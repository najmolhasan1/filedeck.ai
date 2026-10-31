import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { AdapterError } from '@cloudnest/contracts';
import { configFromEnv, mapAuthorization, remoteId, TdlibAdapter, type TdTransport } from '../src/adapter.js';

test('missing credentials cannot create a successful fake authorization',()=>{
  assert.throws(()=>configFromEnv({}), (e:unknown)=>e instanceof AdapterError&&e.code==='SPIKE_DISABLED');
  assert.throws(()=>configFromEnv({CLOUDNEST_SPIKE_ENABLE:'true'}),(e:unknown)=>e instanceof AdapterError&&e.code==='ADAPTER_NOT_CONFIGURED');
});
test('authorization follows provider code delivery and 2FA state',()=>{
  assert.deepEqual(mapAuthorization({_: 'authorizationStateWaitCode',code_info:{type:{_:'authenticationCodeTypeTelegramMessage'},timeout:120}}),{state:'code_required',delivery:'authenticationCodeTypeTelegramMessage'});
  assert.deepEqual(mapAuthorization({_: 'authorizationStateWaitPassword',password_hint:'test'}),{state:'password_required',hint:'test'});
  assert.equal(mapAuthorization({_: 'authorizationStateWaitRegistration'}).state,'unsupported');
});
test('remote identifiers preserve strings and reject unsafe numbers',()=>{
  assert.equal(remoteId('9007199254740993'),'9007199254740993');
  assert.equal(remoteId(-1001234567890),'-1001234567890');
  assert.throws(()=>remoteId(9007199254740992),AdapterError);
});
function transport(handler:(input:Record<string,unknown>)=>Promise<any>):TdTransport{return {invoke:handler,on:()=>{},close:async()=>{}};}
test('adapter ownership is checked before provider access',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-adapter-'));
  try {
    let calls=0;const adapter=await TdlibAdapter.open('account-a',transport(async()=>{calls++;return {};}),directory);
    await assert.rejects(()=>adapter.getAuthorizationState('account-b'),(e:unknown)=>e instanceof AdapterError&&e.code==='PERMISSION_DENIED');assert.equal(calls,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('2FA is not accepted before the provider requests it',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-adapter-'));
  try {
    const calls:Record<string,unknown>[]=[];
    const adapter=await TdlibAdapter.open('account-a',transport(async input=>{calls.push(input);return {_: 'authorizationStateWaitCode',code_info:{}};}),directory);
    await assert.rejects(()=>adapter.submitAuthorizationStep('account-a',{type:'password',value:'never-log-this'}),(e:unknown)=>e instanceof AdapterError&&e.code==='INVALID_AUTH_STEP');assert.equal(calls.length,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('lost acknowledgement is journaled and is not resent on retry or restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-adapter-'));
  try {
    let sends=0;const td=transport(async input=>{
      if(input._==='getMe')return {id:123};if(input._==='createPrivateChat')return {id:123};
      if(input._==='sendMessage'){sends++;throw new Error('connection dropped after send');}
      throw new Error('unexpected call');
    });
    const adapter=await TdlibAdapter.open('account-a',td,directory);await adapter.selectStorageChat('account-a','123');
    const path=join(directory,'fixture.txt');await writeFile(path,'original bytes');
    const input={path,peerId:'123',operationId:'stable_operation_001'};
    assert.equal((await adapter.sendOriginalFile('account-a',input)).state,'unknown');
    assert.equal((await adapter.sendOriginalFile('account-a',input)).state,'unknown');
    const recovered=await TdlibAdapter.open('account-a',td,directory);
    assert.equal((await recovered.sendOriginalFile('account-a',input)).state,'unknown');assert.equal(sends,1);
    await writeFile(path,'changed content');
    await assert.rejects(()=>recovered.sendOriginalFile('account-a',input),(e:unknown)=>e instanceof AdapterError&&e.code==='IDEMPOTENCY_CONFLICT');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('provider flood-wait is honored and sanitized',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-adapter-'));
  try {
    const adapter=await TdlibAdapter.open('account-a',transport(async()=>{throw {code:429,message:'FLOOD_WAIT_120 secret_payload'};}),directory);
    await assert.rejects(()=>adapter.getAuthorizationState('account-a'),(e:unknown)=>e instanceof AdapterError&&e.code==='PROVIDER_WAIT'&&e.retryAfterSeconds===120&&!e.message.includes('secret_payload'));
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('temporary send is pending until a provider success update confirms the attachment',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-adapter-'));
  try {
    let listener:(update:any)=>void=()=>{};
    const temporary={id:1048577,chat_id:123,date:1,sending_state:{_:'messageSendingStatePending'},content:{_:'messageDocument',document:{file_name:'fixture.bin',mime_type:'application/octet-stream',document:{id:99,size:4}}}};
    const td:TdTransport={invoke:async(input)=>{
      if(input._==='getMe')return {id:123};if(input._==='createPrivateChat')return {id:123};if(input._==='sendMessage')return temporary;throw new Error('unexpected');
    },on:(_,fn)=>{listener=fn;},close:async()=>{}};
    const adapter=await TdlibAdapter.open('account-a',td,directory);await adapter.selectStorageChat('account-a','123');
    const path=join(directory,'fixture.bin');await writeFile(path,Buffer.from([0,1,2,3]));
    assert.equal((await adapter.sendOriginalFile('account-a',{path,peerId:'123',operationId:'stable_confirmation_001'})).state,'pending');
    listener({_: 'updateMessageSendSucceeded',old_message_id:1048577,message:{...temporary,id:2097152,sending_state:undefined}});
    // Completion is persisted asynchronously; poll the contract instead of asserting an implementation timer.
    for(let i=0;i<20;i++){if((await adapter.lookupSendResult('account-a','stable_confirmation_001')).state==='confirmed')break;await new Promise(resolve=>setTimeout(resolve,5));}
    const result=await adapter.lookupSendResult('account-a','stable_confirmation_001');assert.equal(result.state,'confirmed');
    if(result.state==='confirmed')assert.deepEqual(result.reference,{telegramUserId:'123',peerId:'123',messageId:'2097152',attachmentIndex:0});
    await adapter.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('stored account identity cannot silently reconnect to another Telegram user',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-adapter-'));
  try {
    await writeFile(join(directory,'operations.json'),JSON.stringify({accountKey:'account-a',telegramUserId:'123',operations:[],selectedChats:[]}));
    const adapter=await TdlibAdapter.open('account-a',transport(async input=>input._==='getAuthorizationState'?{_:'authorizationStateReady'}:{id:456}),directory);
    await assert.rejects(()=>adapter.getAuthorizationState('account-a'),(e:unknown)=>e instanceof AdapterError&&e.code==='ACCOUNT_MISMATCH');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('opaque staging source preserves original filename and cleans prepared bytes after confirmation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-original-name-'));
  try {
    const {readFile,stat}=await import('node:fs/promises');let sentPath='';
    const adapter=await TdlibAdapter.open('account-a',transport(async input=>{
      if(input._==='getMe')return {id:123};if(input._==='createPrivateChat')return {id:123};
      if(input._==='sendMessage'){
        sentPath=(input.input_message_content as any).document.path;
        assert.equal(sentPath.split('/').pop(),'Original বাংলা.txt');assert.equal(await readFile(sentPath,'utf8'),'original bytes');
        return {id:2097152,chat_id:123,date:1,content:{_:'messageDocument',document:{file_name:'Original বাংলা.txt',mime_type:'text/plain',document:{id:99,size:14}}}};
      }throw new Error('unexpected');
    }),directory);await adapter.selectStorageChat('account-a','123');
    const source=join(directory,'opaque-upload-id');await writeFile(source,'original bytes');
    const result=await adapter.sendOriginalFile('account-a',{path:source,originalName:'Original বাংলা.txt',peerId:'123',operationId:'preserve-original-name'});assert.equal(result.state,'confirmed');
    await assert.rejects(()=>stat(sentPath),{code:'ENOENT'});assert.equal(await readFile(source,'utf8'),'original bytes');
    await assert.rejects(()=>adapter.sendOriginalFile('account-a',{path:source,originalName:'../escape',peerId:'123',operationId:'invalid-original-name'}),(error:unknown)=>error instanceof AdapterError&&error.code==='INVALID_FILENAME');
    await adapter.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('known pending message is reconciled by lookup without issuing another send',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-reconcile-'));
  try {
    let sends=0,confirmed=false;
    const message=(done:boolean)=>({id:done?2097152:1048577,chat_id:123,date:1,...(done?{}:{sending_state:{_:'messageSendingStatePending'}}),content:{_:'messageDocument',document:{file_name:'fixture',mime_type:'application/octet-stream',document:{id:99,size:4}}}});
    const adapter=await TdlibAdapter.open('account-a',transport(async input=>{
      if(input._==='getMe')return {id:123};if(input._==='createPrivateChat')return {id:123};if(input._==='sendMessage'){sends++;return message(false);}if(input._==='getMessage')return message(confirmed);throw new Error('unexpected');
    }),directory);await adapter.selectStorageChat('account-a','123');const source=join(directory,'fixture');await writeFile(source,'test');
    assert.equal((await adapter.sendOriginalFile('account-a',{path:source,peerId:'123',operationId:'known-pending-message'})).state,'pending');
    confirmed=true;const result=await adapter.lookupSendResult('account-a','known-pending-message');assert.equal(result.state,'confirmed');assert.equal(sends,1);await adapter.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('a closed native client alone does not claim Telegram authorization revocation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-revoke-'));
  try {
    let logoutCalls=0;
    const adapter=await TdlibAdapter.open('account-a',transport(async input=>{if(input._==='getAuthorizationState')return {_: 'authorizationStateClosed'};if(input._==='logOut')logoutCalls++;return {};}),directory);
    assert.equal((await adapter.getAuthorizationState('account-a')).state,'closed');assert.equal(await adapter.revokeAuthorization('account-a'),'pending');assert.equal(logoutCalls,0);await adapter.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('accepted logout plus provider closure confirms revocation and survives restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-revoke-'));
  try {
    let listener:(update:any)=>void=()=>{};let logoutCalls=0;
    const td:TdTransport={invoke:async input=>{if(input._==='logOut'){logoutCalls++;listener({_: 'updateAuthorizationState',authorization_state:{_: 'authorizationStateClosed'}});return {_: 'ok'};}throw new Error('unexpected');},on:(_,fn)=>{listener=fn;},close:async()=>{}};
    const adapter=await TdlibAdapter.open('account-a',td,directory);assert.equal(await adapter.revokeAuthorization('account-a'),'confirmed');assert.equal(logoutCalls,1);await adapter.close();
    const recovered=await TdlibAdapter.open('account-a',transport(async()=>{throw new Error('must not call provider for persisted confirmed revocation');}),directory);assert.equal(await recovered.revokeAuthorization('account-a'),'confirmed');await recovered.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('restored storage allowlists cannot send through a different native account before auth polling',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cloudnest-bound-send-'));
  try {
    await writeFile(join(directory,'operations.json'),JSON.stringify({accountKey:'account-a',telegramUserId:'123',operations:[],selectedChats:[{peerId:'123',kind:'saved_messages',title:'Saved Messages',canSend:true,canDelete:true}]}));
    let sends=0;
    const adapter=await TdlibAdapter.open('account-a',transport(async input=>{if(input._==='getMe')return {id:456};if(input._==='sendMessage')sends++;return {};}),directory);
    await assert.rejects(()=>adapter.sendOriginalFile('account-a',{path:join(directory,'never-read'),peerId:'123',operationId:'cross-account-must-fail'}),(error:unknown)=>error instanceof AdapterError&&error.code==='ACCOUNT_MISMATCH');assert.equal(sends,0);await adapter.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
