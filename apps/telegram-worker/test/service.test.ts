import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { AdapterError, type TelegramAdapter } from '@cloudnest/contracts';
import { AccountPool, authorized, createWorkerService, ownedStagingPath, parseRange, serviceConfigFromEnv, type AccountWorkerFactory, type WorkerServiceConfig } from '../src/service.js';
const token='a-private-internal-token-at-least-32-characters';
const config=(root:string):WorkerServiceConfig=>({token,host:'127.0.0.1',port:0,stagingRoot:root,enabled:true,approved:true,unavailableCode:'ADAPTER_NOT_CONFIGURED',maxAccounts:4,idleMs:60_000});
const adapter=(overrides:Partial<TelegramAdapter>={}):TelegramAdapter=>({
  startAuthorization:async()=>({state:'code_required',delivery:'Telegram'}),submitAuthorizationStep:async()=>({state:'ready',telegramUserId:'123'}),getAuthorizationState:async()=>({state:'ready',telegramUserId:'123'}),
  getAccountCapabilities:async()=>({productMaxBytes:500*1024*1024,premium:false,providerLimitVerified:false}),listAllowedChats:async()=>[{peerId:'123',kind:'saved_messages',title:'Saved Messages',canSend:true,canDelete:true}],selectStorageChat:async()=>({peerId:'123',kind:'saved_messages',title:'Saved Messages',canSend:true,canDelete:true}),listAttachments:async()=>({items:[]}),
  sendOriginalFile:async(_key,input)=>({state:'pending',operationId:input.operationId}),lookupSendResult:async(_key,operationId)=>({state:'unknown',operationId}),fetchOriginal:async()=>{throw new AdapterError('SOURCE_UNAVAILABLE','No fixture');},refreshReference:async()=>{throw new AdapterError('REMOTE_FILE_MISSING','No fixture');},removeMessages:async()=>[],revokeAuthorization:async()=> 'pending',...overrides
});
async function start(settings:WorkerServiceConfig,factory?:AccountWorkerFactory){const service=createWorkerService(settings,factory);await new Promise<void>((resolve,reject)=>{service.server.once('error',reject);service.server.listen(0,'127.0.0.1',resolve);});const url=`http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;return {...service,url};}
const post=(url:string,body:unknown,secret=token,range?:string)=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json',...(range?{range}:{})},body:JSON.stringify(body)});

test('service configuration requires a distinct bearer, encrypted storage approval and credentials',()=>{
  assert.throws(()=>serviceConfigFromEnv({STAGING_ROOT:'/tmp/staging'}),(error:unknown)=>error instanceof AdapterError&&error.code==='WORKER_AUTH_NOT_CONFIGURED');
  const settings=serviceConfigFromEnv({CLOUDNEST_WORKER_TOKEN:token,STAGING_ROOT:'/tmp/staging',CLOUDNEST_WORKER_ENABLE:'true'});
  assert.equal(settings.approved,false);assert.equal(settings.provider,undefined);assert.equal(settings.unavailableCode,'SESSION_STORAGE_NOT_APPROVED');
  const missing=serviceConfigFromEnv({CLOUDNEST_WORKER_TOKEN:token,STAGING_ROOT:'/tmp/staging',CLOUDNEST_WORKER_ENABLE:'true',CLOUDNEST_SESSION_STORAGE_APPROVED:'true'});assert.equal(missing.provider,undefined);
  assert.equal(authorized(`Bearer ${token}`,token),true);assert.equal(authorized(`Bearer ${token}x`,token),false);assert.equal(authorized(undefined,token),false);
});
test('health is honest when credentials are unavailable and unauthorized callers never open sessions',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cloudnest-rpc-'));const service=await start(config(root));
  try {
    const health=await fetch(`${service.url}/health`).then(r=>r.json());assert.equal(health.configured,false);
    const unauthorized=await post(`${service.url}/rpc`,{method:'auth.state',accountKey:'account-a',input:{}},'wrong');assert.equal(unauthorized.status,401);assert.equal(service.pool.size,0);
    const unavailable=await post(`${service.url}/rpc`,{method:'auth.state',accountKey:'account-a',input:{}});assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).error.code,'ADAPTER_NOT_CONFIGURED');assert.equal(service.pool.size,0);
  }finally{await service.close();await rm(root,{recursive:true,force:true});}
});
test('staging rejects traversal, cross-account paths and escaping symlinks',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cloudnest-staging-'));
  try {
    await mkdir(join(root,'account-a'));await mkdir(join(root,'account-b'));await writeFile(join(root,'account-a','own'),'original');await writeFile(join(root,'account-b','foreign'),'other');await symlink(join(root,'account-b','foreign'),join(root,'account-a','link'));
    assert.equal(await ownedStagingPath(root,'account-a',join(root,'account-a','own')),join(root,'account-a','own'));
    await assert.rejects(()=>ownedStagingPath(root,'account-a',join(root,'account-b','foreign')),AdapterError);
    await assert.rejects(()=>ownedStagingPath(root,'account-a',join(root,'account-a','link')),AdapterError);
    await assert.rejects(()=>ownedStagingPath(root,'../account-b',join(root,'account-b','foreign')),AdapterError);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('RPC binds every call to its account key and validates staged source before sending',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cloudnest-rpc-'));await mkdir(join(root,'account-a'));await mkdir(join(root,'account-b'));await writeFile(join(root,'account-a','file'),'original');await writeFile(join(root,'account-b','file'),'foreign');
  const calls:{account:string;path:string}[]=[];const opened:string[]=[];
  const service=await start(config(root),async key=>{opened.push(key);return {adapter:adapter({sendOriginalFile:async(account,input)=>{calls.push({account,path:input.path});return {state:'pending',operationId:input.operationId};}}),close:async()=>{}};});
  try {
    const good=await post(`${service.url}/rpc`,{method:'files.send',accountKey:'account-a',input:{path:join(root,'account-a','file'),peerId:'123',operationId:'stable-operation'}});assert.equal(good.status,200);assert.equal((await good.json()).result.state,'pending');assert.deepEqual(calls,[{account:'account-a',path:join(root,'account-a','file')}]);
    const cross=await post(`${service.url}/rpc`,{method:'files.send',accountKey:'account-a',input:{path:join(root,'account-b','file'),peerId:'123',operationId:'different-operation'}});assert.equal(cross.status,403);assert.equal(calls.length,1);assert.deepEqual(opened,['account-a']);
    const invalid=await post(`${service.url}/rpc`,{method:'auth.state',accountKey:'../../etc',input:{}});assert.equal(invalid.status,400);assert.deepEqual(opened,['account-a']);
  }finally{await service.close();await rm(root,{recursive:true,force:true});}
});
test('authenticated original streaming preserves bytes and handles 206/416 ranges',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cloudnest-content-'));const path=join(root,'fixture');await writeFile(path,Buffer.from([0,1,2,3,4,5,255]));
  const service=await start(config(root),async()=>({adapter:adapter({fetchOriginal:async(key,reference)=>{assert.equal(key,'account-a');assert.equal(reference.telegramUserId,'123');return {path,bytes:7};}}),close:async()=>{}}));
  const body={accountKey:'account-a',reference:{telegramUserId:'123',peerId:'123',messageId:'1048576',attachmentIndex:0}};
  try {
    const full=await post(`${service.url}/content`,body);assert.equal(full.status,200);assert.deepEqual(Buffer.from(await full.arrayBuffer()),Buffer.from([0,1,2,3,4,5,255]));assert.equal(full.headers.get('x-content-type-options'),'nosniff');
    const partial=await post(`${service.url}/content`,body,token,'bytes=2-4');assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),'bytes 2-4/7');assert.deepEqual(Buffer.from(await partial.arrayBuffer()),Buffer.from([2,3,4]));
    const invalid=await post(`${service.url}/content`,body,token,'bytes=20-');assert.equal(invalid.status,416);assert.equal(invalid.headers.get('content-range'),'bytes */7');await invalid.arrayBuffer();
  }finally{await service.close();await rm(root,{recursive:true,force:true});}
});
test('range parser handles empty files, suffixes and invalid multiple ranges',()=>{
  assert.deepEqual(parseRange(undefined,0),{start:0,end:-1,partial:false});assert.equal(parseRange('bytes=0-',0),null);assert.deepEqual(parseRange('bytes=-2',7),{start:5,end:6,partial:true});assert.equal(parseRange('bytes=0-1,3-4',7),null);assert.equal(parseRange('bytes=9007199254740993-',7),null);
});
test('account pool uses one client per account, serializes work and enforces capacity',async()=>{
  let creates=0,active=0,maxActive=0,closes=0;
  const pool=new AccountPool(async()=>{creates++;return {adapter:adapter(),close:async()=>{closes++;}};},1,1000);
  const action=async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return true;};
  try {await Promise.all([pool.use('account-a',action),pool.use('account-a',action)]);assert.equal(creates,1);assert.equal(maxActive,1);await assert.rejects(()=>pool.use('account-b',action),(error:unknown)=>error instanceof AdapterError&&error.code==='WORKER_CAPACITY');}
  finally{await pool.close();assert.equal(closes,1);}
});
