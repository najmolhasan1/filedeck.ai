import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DomainError, createFolder, patchFile } from '@cloudnest/domain';
import type { RemoteAttachment } from '@cloudnest/contracts';
import { PgAuthStore,withTenant } from '../src/auth-store.js';
import { PgCatalogRepository } from '../src/postgres-repository.js';
import type { ProductionRuntime } from '../src/production.js';
import { ProviderError } from '../src/telegram-client.js';
import { SyncService,recoveryRetry,validateRecoveryPage } from '../src/sync.js';
const item=(messageId='5242880',user='123',peer='123'):RemoteAttachment=>({reference:{telegramUserId:user,peerId:peer,messageId,attachmentIndex:0},originalName:'Lecture বাংলা.pdf',mime:'application/pdf',bytes:1234,createdAt:'2026-10-31T12:00:00.000Z'});
const code=(expected:string)=>(error:unknown)=>error instanceof DomainError&&error.code===expected;

test('recovery accepts only the selected provider account/chat and exact remote identifiers',()=>{
  assert.equal(validateRecoveryPage({items:[item('9007199254740993')],cursor:'2097152'},'123','123').items[0].reference.messageId,'9007199254740993');
  assert.throws(()=>validateRecoveryPage({items:[item('5242880','456')]},'123','123'),code('SYNC_INVALID_ATTACHMENT'));
  assert.throws(()=>validateRecoveryPage({items:[item('5242880','123','456')]},'123','123'),code('SYNC_INVALID_ATTACHMENT'));
  assert.throws(()=>validateRecoveryPage({items:[item('9223372036854775808')]},'123','123'),code('SYNC_INVALID_ATTACHMENT'));
});
test('recovery rejects unsent items, unsafe sizes and stalled cursors',()=>{
  assert.throws(()=>validateRecoveryPage({items:[{...item(),sending_state:{_:'messageSendingStatePending'}}]},'123','123'),code('SYNC_INVALID_ATTACHMENT'));
  assert.throws(()=>validateRecoveryPage({items:[{...item(),bytes:Number.MAX_SAFE_INTEGER+1}]},'123','123'),code('SYNC_INVALID_ATTACHMENT'));
  assert.throws(()=>validateRecoveryPage({items:[],cursor:'2097152'},'123','123','2097152'),code('SYNC_CURSOR_STALLED'));
  assert.throws(()=>validateRecoveryPage({items:Array.from({length:101},()=>item())},'123','123'),code('SYNC_INVALID_PAGE'));
});
test('recovery removes filename controls, preserves Unicode and deduplicates a provider page',()=>{
  const page=validateRecoveryPage({items:[{...item(),originalName:'\u0000Lecture বাংলা.pdf\n'},item()]},'123','123');assert.equal(page.items.length,1);assert.equal(page.items[0].originalName,'Lecture বাংলা.pdf');
  assert.deepEqual(validateRecoveryPage({items:[]},'123','123'),{items:[]});
});
test('recovery honors provider waits, bounds network retries and fails permanent account errors',()=>{
  assert.deepEqual(recoveryRetry(new ProviderError('PROVIDER_WAIT','safe',503,120),1),{state:'WAITING_PROVIDER',code:'PROVIDER_WAIT',retrySeconds:120});
  assert.equal(recoveryRetry(new DomainError('AUTH_EXPIRED','safe',401),1).state,'FAILED');
  assert.equal(recoveryRetry(new Error('unlogged provider detail'),2).state,'WAITING_NETWORK');
  assert.equal(recoveryRetry(new Error('unlogged provider detail'),10).code,'SYNC_RETRY_EXHAUSTED');
});

const enabled=Boolean(process.env.TEST_DATABASE_URL&&process.env.TEST_ADMIN_DATABASE_URL);
test('PostgreSQL recovery resumes checkpoints, preserves organization, skips tombstones and enforces tenants', {skip:!enabled},async()=>{
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),admin=new Pool({connectionString:process.env.TEST_ADMIN_DATABASE_URL,max:2});
  const auth=new PgAuthStore(pool),userIds:string[]=[],loginIds:string[]=[];
  try {
    const telegramId=String(7000000000000000000n+BigInt('0x'+randomUUID().replaceAll('-','').slice(0,10)));
    const login=await auth.createLoginTransaction(randomUUID());loginIds.push(login.id);
    const identity=await auth.completeLogin(login.token,{telegramUserId:telegramId});userIds.push(identity.user.id);const uid=identity.user.id;
    const bob=await auth.upsertVerifiedUser(String(BigInt(telegramId)+1n));userIds.push(bob.id);
    const chat=await auth.selectChat(uid,{peerId:telegramId,kind:'saved_messages',canSend:true,canDelete:true,title:'Isolated fixture'});
    const first=item('5242880',telegramId,telegramId),removed=item('4194304',telegramId,telegramId),second=item('3145728',telegramId,telegramId);
    await withTenant(pool,uid,client=>client.query('INSERT INTO catalog_tombstones(user_id,remote_attachment_key,reason,remote_reference) VALUES($1,$2,\'catalog_removed\',$3)',[uid,JSON.stringify([telegramId,telegramId,'4194304',0]),removed.reference]));
    const cursors:(string|undefined)[]=[];
    const runtime={auth,repositoryFor:(userId:string)=>new PgCatalogRepository(pool,userId),worker:{selectChat:async()=>chat,rpc:async(method:string,key:string,input:{peerId:string;cursor?:string})=>{
      assert.equal(method,'attachments.list');assert.equal(key,login.accountKey);assert.equal(input.peerId,telegramId);cursors.push(input.cursor);
      return input.cursor?{items:[first,second]}:{items:[first,removed],cursor:'4194304'};
    }}} as unknown as ProductionRuntime;
    const sync=new SyncService(runtime,pool),job=await sync.startJob(uid,chat.id);assert.equal((await sync.startJob(uid,chat.id)).id,job.id);
    await sync.tick();assert.equal((await sync.getJob(uid,job.id)).state,'QUEUED');
    const repository=new PgCatalogRepository(pool,uid);
    await repository.transaction(state=>{assert.equal(state.files.length,1);const folder=createFolder(state,uid,{name:'Kept organization'});patchFile(state,uid,state.files[0].id,{name:'My display name.pdf',folder_id:folder.id,favorite:true,tags:['keep']},1);});
    const restarted=new SyncService(runtime,pool);await restarted.tick();const done=await restarted.getJob(uid,job.id);
    assert.equal(done.state,'COMPLETED');assert.equal(done.imported_files,2);assert.equal(done.skipped_files,2);assert.deepEqual(cursors,[undefined,'4194304']);
    const files=await repository.read(state=>state.files);assert.equal(files.length,2);assert.equal(files.find(file=>file.remote_reference?.message_id==='5242880')?.name,'My display name.pdf');assert.deepEqual(files.find(file=>file.name==='My display name.pdf')?.tags,['keep']);assert.ok(!files.some(file=>file.remote_reference?.message_id==='4194304'));
    const again=await restarted.startJob(uid,chat.id);await restarted.tick();await restarted.tick();assert.equal((await restarted.getJob(uid,again.id)).imported_files,0);assert.equal(await repository.read(state=>state.files.length),2);
    await assert.rejects(()=>restarted.getJob(bob.id,job.id),code('NOT_FOUND'));
    await assert.rejects(()=>restarted.startJob(bob.id,chat.id),code('AUTH_EXPIRED'));
    assert.equal(await withTenant(pool,bob.id,async client=>(await client.query('SELECT count(*)::integer AS count FROM sync_jobs WHERE id=$1',[job.id])).rows[0].count),0);
    const checkpoint=await withTenant(pool,uid,async client=>(await client.query('SELECT history_cursor,last_reconciled_at FROM sync_checkpoints WHERE user_id=$1 AND storage_chat_id=$2',[uid,chat.id])).rows[0]);assert.equal(checkpoint.history_cursor,null);assert.ok(checkpoint.last_reconciled_at);
  }finally{if(userIds.length)await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[userIds]);if(loginIds.length)await admin.query('DELETE FROM login_transactions WHERE id=ANY($1::uuid[])',[loginIds]);await pool.end();await admin.end();}
});
