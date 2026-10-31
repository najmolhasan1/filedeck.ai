import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DomainError, createFolder, deleteFolder, patchFile, patchFolder, removeCatalogFile, type FileRecord, type Transfer } from '@cloudnest/domain';
import { PgAuthStore, hashToken, withTenant } from '../src/auth-store.js';
import { PgCatalogRepository } from '../src/postgres-repository.js';

const runtimeUrl = process.env.TEST_DATABASE_URL;
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
const enabled = Boolean(runtimeUrl && adminUrl);
const providerId = (): string => String(8000000000000000000n + BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 10)));
const isCode = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const localFile = (userId: string, folderId: string | null = null): FileRecord => { const now = new Date().toISOString(); return { id: randomUUID(),user_id:userId,folder_id:folderId,name:'Original.txt',original_name:'Original.txt',mime:'text/plain',bytes:12,sha256:null,favorite:false,tags:['lecture'],created_at:now,updated_at:now,trashed_at:null,availability:'local',version:1,local_blob_id:randomUUID() }; };
const pendingTransfer = (userId: string, folderId: string | null): Transfer => { const now = new Date().toISOString(); return { id:randomUUID(),user_id:userId,operation_id:randomUUID(),file_id:null,folder_id:folderId,name:'Original.txt',mime:'text/plain',expected_bytes:12,stage_bytes:0,state:'CREATED',attempts:0,error_code:null,created_at:now,updated_at:now,sha256:null }; };

async function fixture(run: (runtime: Pool, admin: Pool, auth: PgAuthStore, ids: string[]) => Promise<void>): Promise<void> {
  const runtime = new Pool({connectionString:runtimeUrl,max:6}); const admin = new Pool({connectionString:adminUrl,max:2}); const auth = new PgAuthStore(runtime); const ids: string[]=[];
  try { await run(runtime,admin,auth,ids); }
  finally { if(ids.length) await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids]); await runtime.end(); await admin.end(); }
}

test('PostgreSQL normalized catalog persists originals metadata, versions, chunks and durable dispatch atomically', {skip:!enabled}, async () => fixture(async (runtime,admin,auth,ids) => {
  const user=await auth.upsertVerifiedUser(providerId()); ids.push(user.id);
  const repository=new PgCatalogRepository(runtime,user.id); await repository.initialize();
  const {folder,file,transfer}=await repository.transaction(state=>{
    const folder=createFolder(state,user.id,{name:'University'}); const file=localFile(user.id,folder.id); state.files.push(file);
    const transfer=pendingTransfer(user.id,folder.id); transfer.account_key=randomUUID(); transfer.file_id=file.id; state.transfers.push(transfer); return {folder,file,transfer};
  });
  await repository.transaction(state=>{
    patchFile(state,user.id,file.id,{name:'Lecture.txt',favorite:true,tags:['বাংলা','notes']},1);
    const item=state.transfers.find(t=>t.id===transfer.id)!; item.stage_bytes=12; item.state='QUEUED'; item.sha256=createHash('sha256').update('twelve bytes').digest('hex');
    item.verified_chunks=[{offset:0,length:12,checksum:item.sha256}];
    state.idempotency.push({user_id:user.id,scope:'unit',key:'test',digest:'digest',result:{ok:true},expires_at:new Date(Date.now()+60000).toISOString()});
  });
  const restarted=new PgCatalogRepository(runtime,user.id);
  const state=await restarted.read(state=>state); assert.equal(state.files[0].name,'Lecture.txt'); assert.equal(state.files[0].original_name,'Original.txt'); assert.equal(state.files[0].version,2); assert.deepEqual(state.files[0].tags,['notes','বাংলা']);
  assert.equal(state.transfers[0].account_key,transfer.account_key); assert.equal(state.transfers[0].stage_bytes,12); assert.equal(state.transfers[0].verified_chunks?.[0].length,12); assert.deepEqual(state.idempotency[0].result,{ok:true});
  const persisted=await admin.query('SELECT f.display_name,f.original_name,t.state,u.offset_bytes,u.staging_ref,c.length_bytes FROM files f JOIN transfers t ON t.file_id=f.id JOIN uploads u ON u.transfer_id=t.id JOIN upload_chunks c ON c.upload_id=u.id WHERE f.id=$1',[file.id]); assert.equal(persisted.rows[0].display_name,'Lecture.txt'); assert.equal(persisted.rows[0].offset_bytes,'12'); assert.equal(persisted.rows[0].staging_ref,`${transfer.account_key}/${transfer.id}`);
  assert.equal((await admin.query("SELECT count(*)::integer AS count FROM outbox_events WHERE user_id=$1 AND event_type='transfer.queued'",[user.id])).rows[0].count,1);
  await assert.rejects(repository.transaction(state=>{patchFile(state,user.id,file.id,{name:'Rolled back'},2); throw new Error('intentional rollback');}));
  assert.equal(await repository.read(state=>state.files[0].name),'Lecture.txt');
  await assert.rejects(repository.transaction(state=>patchFile(state,user.id,file.id,{name:'stale'},1)),isCode('VERSION_CONFLICT'));
  await repository.transaction(state=>{ deleteFolder(state,user.id,folder.id,'root',1); removeCatalogFile(state,user.id,file.id); });
  assert.equal(await repository.read(state=>state.folders.length),0); assert.equal(await repository.read(state=>state.tombstones[0].file_id),file.id); assert.equal(await repository.read(state=>state.transfers[0].file_id),null);
}));

test('PostgreSQL actual runtime role enforces tenant boundaries and concurrent folder mutations', {skip:!enabled}, async () => fixture(async (runtime,admin,auth,ids) => {
  const alice=await auth.upsertVerifiedUser(providerId()); const bob=await auth.upsertVerifiedUser(providerId()); ids.push(alice.id,bob.id);
  const a=new PgCatalogRepository(runtime,alice.id); const b=new PgCatalogRepository(runtime,bob.id);
  const file=await a.transaction(state=>{const file=localFile(alice.id);state.files.push(file);return file;});
  assert.equal(await b.read(state=>state.files.length),0);
  const role=await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'); assert.equal(role.rows[0].rolsuper,false); assert.equal(role.rows[0].rolbypassrls,false);
  assert.equal((await runtime.query('SELECT count(*)::integer AS count FROM files')).rows[0].count,0);
  assert.equal(await withTenant(runtime,bob.id,async client=>(await client.query('SELECT count(*)::integer AS count FROM files WHERE id=$1',[file.id])).rows[0].count),0);
  await assert.rejects(b.transaction(state=>{state.files.push({...file,id:randomUUID(),user_id:alice.id});}),isCode('PERMISSION_DENIED'));
  const outcomes=await Promise.allSettled(Array.from({length:5},()=>a.transaction(state=>createFolder(state,alice.id,{name:'Same folder'})))); assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(await a.read(state=>state.folders.length),1);
  await assert.rejects(withTenant(runtime,bob.id,async client=>{await client.query("INSERT INTO files(user_id,display_name,original_name,mime,bytes,origin) VALUES($1,'bad','bad','text/plain',1,'web')",[alice.id]);}));
}));

test('PostgreSQL hierarchy swaps remain atomic and confirmed remote references stay account-bound with bigint precision', {skip:!enabled}, async () => fixture(async (runtime,admin,auth,ids) => {
  const user=await auth.upsertVerifiedUser(providerId()); ids.push(user.id); const repository=new PgCatalogRepository(runtime,user.id);
  const {parent,child}=await repository.transaction(state=>{const parent=createFolder(state,user.id,{name:'A'});const child=createFolder(state,user.id,{name:'B',parent_id:parent.id});return {parent,child};});
  await repository.transaction(state=>{patchFolder(state,user.id,child.id,{parent_id:null},1);patchFolder(state,user.id,parent.id,{parent_id:child.id},1);});
  assert.equal(await repository.read(state=>state.folders.find(f=>f.id===parent.id)?.parent_id),child.id);
  await auth.selectChat(user.id,{peerId:'-1001234567890',kind:'private_channel',canSend:true,canDelete:true,title:'Private test'});
  const file=localFile(user.id); file.availability='confirmed'; file.remote_reference={telegramUserId:user.telegramUserId,peerId:'-1001234567890',messageId:'9007199254740993',attachmentIndex:'0'};
  await repository.transaction(state=>{state.files.push(file);});
  assert.equal(await repository.read(state=>state.files[0].remote_reference?.messageId),'9007199254740993');
  const sql=await admin.query('SELECT remote_message_id,storage_chat_id FROM files WHERE id=$1',[file.id]); assert.equal(sql.rows[0].remote_message_id,'9007199254740993'); assert.ok(sql.rows[0].storage_chat_id);
  await assert.rejects(repository.transaction(state=>{const invalid=localFile(user.id);invalid.availability='confirmed';invalid.remote_reference={...file.remote_reference,telegramUserId:'123'};state.files.push(invalid);}),isCode('PERMISSION_DENIED'));
}));

test('PostgreSQL sessions persist only hashes, rotate credentials, revoke on reuse and reject invented tokens', {skip:!enabled}, async () => fixture(async (runtime,admin,auth,ids) => {
  const telegramId=providerId(); const user=await auth.upsertVerifiedUser(telegramId,'bn');ids.push(user.id);
  assert.equal((await auth.upsertVerifiedUser(telegramId)).id,user.id); assert.equal((await auth.getUser(user.id))?.telegramUserId,telegramId);
  const issue=await auth.createSession(user.id,{deviceLabel:'Test browser'});
  const stored=await admin.query('SELECT hashed_refresh_token,hashed_csrf_token FROM product_sessions WHERE id=$1',[issue.session.id]); assert.equal(stored.rows[0].hashed_refresh_token,hashToken(issue.token));assert.notEqual(stored.rows[0].hashed_refresh_token,issue.token); assert.equal(stored.rows[0].hashed_csrf_token,hashToken(issue.csrfToken));
  assert.equal((await auth.authenticateSession(issue.token))?.user.id,user.id);
  assert.equal(await auth.authenticateSession(`${user.id}.${issue.session.id}.${'x'.repeat(54)}`),null);
  const rotated=await auth.rotateSession(issue.token); assert.notEqual(rotated.token,issue.token);assert.equal(await auth.authenticateSession(issue.token),null);assert.ok(await auth.authenticateSession(rotated.token));
  await assert.rejects(auth.rotateSession(issue.token),isCode('SESSION_REUSE')); assert.equal(await auth.authenticateSession(rotated.token),null);
  const another=await auth.createSession(user.id);await auth.revokeSession(another.token);assert.equal(await auth.authenticateSession(another.token),null);
}));

test('PostgreSQL login transactions are durable, expiring and single-use and rate limits are shared across instances', {skip:!enabled}, async () => fixture(async (runtime,admin,auth,ids) => {
  const other=new PgAuthStore(runtime); const accountKey=randomUUID(); const login=await auth.createLoginTransaction(accountKey);
  assert.equal((await other.getLoginTransaction(login.token))?.accountKey,accountKey);
  await auth.updateLoginTransaction(login.token,{state:'code_required',delivery:'Telegram app'});
  await assert.rejects(auth.updateLoginTransaction(login.token,{code:'123456'}),isCode('INVALID_AUTH_STATE'));
  const telegramId=providerId(); const completed=await Promise.allSettled([auth.completeLogin(login.token,{telegramUserId:telegramId}),other.completeLogin(login.token,{telegramUserId:telegramId})]); assert.equal(completed.filter(result=>result.status==='fulfilled').length,1);
  const issue=(completed.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<PgAuthStore['completeLogin']>>>).value; ids.push(issue.user.id);
  assert.equal(await auth.getLoginTransaction(login.token),null);assert.equal((await auth.getTelegramSession(issue.user.id))?.accountKey,accountKey);assert.ok((await auth.listConnectedUsers()).some(item=>item.userId===issue.user.id));
  const expired=await auth.createLoginTransaction(randomUUID());await admin.query("UPDATE login_transactions SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);assert.equal(await auth.getLoginTransaction(expired.token),null);await assert.rejects(auth.completeLogin(expired.token,{telegramUserId:providerId()}),isCode('AUTH_EXPIRED'));
  const key=randomUUID();const rates=await Promise.all(Array.from({length:10},(_,index)=>(index%2?auth:other).checkRateLimit(key,3,60)));assert.equal(rates.filter(result=>result.allowed).length,3);assert.ok(rates.filter(result=>!result.allowed).every(result=>result.retryAfterSeconds>0));
  const stored=await admin.query('SELECT token_hash,state FROM login_transactions WHERE id=$1',[login.id]);assert.equal(stored.rows[0].token_hash,hashToken(login.token));assert.ok(!JSON.stringify(stored.rows[0]).includes('123456'));
  await admin.query('DELETE FROM login_transactions WHERE id=ANY($1::uuid[])',[[login.id,expired.id]]);await admin.query('DELETE FROM auth_rate_limits WHERE key_hash=$1',[hashToken(key)]);
}));


test('PostgreSQL reconnect preserves a verified canonical worker and durably queues obsolete authorizations', {skip:!enabled}, async () => fixture(async (runtime,admin,auth,ids) => {
  const user=await auth.upsertVerifiedUser(providerId());ids.push(user.id);const canonical=randomUUID();
  // A legacy canonical binding has no consumed-login ownership row.
  await admin.query("INSERT INTO telegram_sessions(user_id,runtime_kind,encrypted_state_ref,kms_key_version,state,account_key) VALUES($1,'server',$2,'adapter-managed','connected',$3)",[user.id,`tdlib:${canonical}`,canonical]);
  const login=await auth.createLoginTransaction(randomUUID());
  const reused=await auth.completeLogin(login.token,{telegramUserId:user.telegramUserId,reuseAccountKey:canonical});
  assert.equal(reused.unusedAccountKey,login.accountKey);assert.equal((await auth.getTelegramSession(user.id))?.accountKey,canonical);
  assert.ok((await auth.listPendingRevocations()).some(row=>row.userId===user.id&&row.accountKey===login.accountKey));
  await auth.completeRevocation(user.id,login.accountKey);assert.ok(!(await auth.listPendingRevocations()).some(row=>row.accountKey===login.accountKey));
  const replacement=await auth.createLoginTransaction(randomUUID());const replaced=await auth.completeLogin(replacement.token,{telegramUserId:user.telegramUserId});
  assert.equal(replaced.previousAccountKey,canonical);await auth.enqueueRevocation(user.id,canonical);
  assert.ok((await auth.listPendingRevocations()).some(row=>row.userId===user.id&&row.accountKey===canonical));
  await auth.deferRevocation(user.id,canonical,60,'PROVIDER_UNAVAILABLE');assert.ok(!(await auth.listPendingRevocations()).some(row=>row.accountKey===canonical));
  await assert.rejects(auth.enqueueRevocation(user.id,randomUUID()),isCode('PERMISSION_DENIED'));
}));
