import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyCatalog, type CatalogState, type Transfer } from '@cloudnest/domain';
import type { Pool } from 'pg';
import type { ProductionRuntime } from '../src/production.js';
import { TransferDispatcher } from '../src/dispatch.js';

function fixture(state:CatalogState,stagingRoot:string,worker:Record<string,unknown>={}) {
  const userId='00000000-0000-4000-8000-000000000001',accountKey='00000000-0000-4000-8000-000000000002';
  const repository={read:async<T>(fn:(value:CatalogState)=>T)=>fn(structuredClone(state)),transaction:async<T>(fn:(value:CatalogState)=>T|Promise<T>)=>{const copy=structuredClone(state);const result=await fn(copy);Object.assign(state,copy);return result;}};
  const auth={listPendingRevocations:async()=>[],listConnectedUsers:async()=>[{userId,accountKey}],getSelectedChat:async()=>({peerId:'1234',canSend:true}),getTelegramSession:async()=>({accountKey,state:'connected'}),getUser:async()=>({id:userId,telegramUserId:'1234'})};
  const runtime={auth,repositoryFor:()=>repository,worker,stagingRoot} as unknown as ProductionRuntime;
  const pool={connect:async()=>({query:async()=>({rows:[{locked:true}]}),release:()=>{}})} as unknown as Pool;
  return {dispatcher:new TransferDispatcher(runtime,pool),userId,accountKey};
}
const transfer=(userId:string,state:Transfer['state'],updatedAt=new Date().toISOString()):Transfer=>({id:'upload-fixture',user_id:userId,operation_id:'stable-operation',file_id:null,folder_id:null,name:'original.txt',mime:'text/plain',expected_bytes:8,stage_bytes:8,state,attempts:state==='QUEUED'?0:1,error_code:null,created_at:updatedAt,updated_at:updatedAt,sha256:null});

test('stale staging expires without provider work or a false catalog entry',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-expiry-'));
  try {
    const state=emptyCatalog(),fixtureValue=fixture(state,directory,{send:async()=>{throw new Error('Expired bytes must never be dispatched.');}});
    state.transfers.push(transfer(fixtureValue.userId,'QUEUED',new Date(Date.now()-25*60*60*1000).toISOString()));
    await mkdir(join(directory,fixtureValue.accountKey));await writeFile(join(directory,fixtureValue.accountKey,'upload-fixture'),'original');
    await fixtureValue.dispatcher.tick();
    assert.equal(state.transfers[0].state,'FAILED');assert.equal(state.transfers[0].error_code,'STAGING_EXPIRED');assert.equal(state.files.length,0);
    await assert.rejects(stat(join(directory,fixtureValue.accountKey,'upload-fixture')),{code:'ENOENT'});
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a pending send cancellation is reconciled rather than reported as undone',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-cancel-'));
  try {
    const state=emptyCatalog();let confirmed=false,sendCount=0;
    const value=fixture(state,directory,{send:async()=>{sendCount++;},result:async()=>confirmed?{state:'confirmed',reference:{telegramUserId:'1234',peerId:'1234',messageId:'5678',attachmentIndex:0},bytes:8}:{state:'pending',operationId:'stable-operation'}});
    state.transfers.push(transfer(value.userId,'CANCEL_REQUESTED'));
    await value.dispatcher.tick();assert.equal(state.transfers[0].state,'CANCEL_REQUESTED');assert.equal(state.transfers[0].error_code,'CANCEL_UNCERTAIN');
    confirmed=true;await value.dispatcher.tick();assert.equal(state.transfers[0].state,'COMPLETED');assert.equal(state.files[0].availability,'confirmed');assert.equal(sendCount,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a changed Telegram authorization never silently replays an older transfer',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-account-change-'));
  try {
    const state=emptyCatalog();let effects=0;
    const value=fixture(state,directory,{send:async()=>{effects++;},result:async()=>{effects++;}});
    state.transfers.push({...transfer(value.userId,'QUEUED'),account_key:'retired-account-key'});
    await mkdir(join(directory,'retired-account-key'));await writeFile(join(directory,'retired-account-key','upload-fixture'),'original');
    await value.dispatcher.tick();
    assert.equal(state.transfers[0].state,'NEEDS_ATTENTION');assert.equal(state.transfers[0].error_code,'ACCOUNT_SESSION_CHANGED');assert.equal(effects,0);
    assert.equal((await stat(join(directory,'retired-account-key','upload-fixture'))).size,8);
  }finally{await rm(directory,{recursive:true,force:true});}
});
