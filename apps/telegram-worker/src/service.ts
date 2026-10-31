import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AdapterError, type AttachmentRef, type TelegramAdapter, type WorkerRpcMethod, type WorkerRpcRequest } from '@cloudnest/contracts';
import { createTdlibAdapter, providerConfigFromEnv, type WorkerConfig } from './adapter.js';

export interface WorkerServiceConfig {
  token:string;
  host:string;
  port:number;
  stagingRoot:string;
  provider?:WorkerConfig;
  enabled:boolean;
  approved:boolean;
  unavailableCode:string;
  maxAccounts:number;
  idleMs:number;
}
export function serviceConfigFromEnv(env:NodeJS.ProcessEnv):WorkerServiceConfig {
  const token=env.CLOUDNEST_WORKER_TOKEN ?? '';
  if(token.length<32)throw new AdapterError('WORKER_AUTH_NOT_CONFIGURED','Set a unique internal service bearer token of at least 32 characters.');
  if(!env.STAGING_ROOT||!isAbsolute(env.STAGING_ROOT))throw new AdapterError('INVALID_CONFIGURATION','STAGING_ROOT must be an absolute shared staging directory.');
  const enabled=env.CLOUDNEST_WORKER_ENABLE==='true';
  const approved=env.CLOUDNEST_SESSION_STORAGE_APPROVED==='true';
  let provider:WorkerConfig|undefined;let unavailableCode=enabled?(approved?'ADAPTER_NOT_CONFIGURED':'SESSION_STORAGE_NOT_APPROVED'):'WORKER_DISABLED';
  if(enabled&&approved) {try{provider=providerConfigFromEnv(env);}catch(error){if(!(error instanceof AdapterError&&error.code==='ADAPTER_NOT_CONFIGURED'))throw error;}}
  const port=Number(env.WORKER_PORT||4001);if(!Number.isInteger(port)||port<0||port>65535)throw new AdapterError('INVALID_CONFIGURATION','WORKER_PORT is invalid.');
  const maxAccounts=Number(env.WORKER_MAX_ACCOUNTS||10);if(!Number.isInteger(maxAccounts)||maxAccounts<1||maxAccounts>100)throw new AdapterError('INVALID_CONFIGURATION','WORKER_MAX_ACCOUNTS must be between 1 and 100.');
  return {token,host:env.WORKER_HOST||'127.0.0.1',port,stagingRoot:resolve(env.STAGING_ROOT),provider,enabled,approved,unavailableCode,maxAccounts,idleMs:15*60*1000};
}
export interface AccountWorker { adapter:TelegramAdapter; close:()=>Promise<void>; }
export type AccountWorkerFactory=(accountKey:string)=>Promise<AccountWorker>;
interface PoolEntry { worker:Promise<AccountWorker>; queue:Promise<unknown>; active:number;lastUsed:number; }
export class AccountPool {
  private readonly entries=new Map<string,PoolEntry>();
  private closing=false;
  constructor(private readonly factory:AccountWorkerFactory,private readonly maximum:number,private readonly idleMs:number) {}
  get size(){return this.entries.size;}
  async use<T>(accountKey:string,action:(adapter:TelegramAdapter)=>Promise<T>):Promise<T> {
    validateAccountKey(accountKey);if(this.closing)throw new AdapterError('WORKER_STOPPING','The worker is stopping. Retry shortly.');
    await this.sweep();
    let entry=this.entries.get(accountKey);
    if(!entry) {
      if(this.entries.size>=this.maximum)throw new AdapterError('WORKER_CAPACITY','This worker has reached its configured account capacity.',10);
      const worker=this.factory(accountKey);entry={worker,queue:Promise.resolve(),active:0,lastUsed:Date.now()};this.entries.set(accountKey,entry);
      void worker.catch(()=>{if(this.entries.get(accountKey)===entry)this.entries.delete(accountKey);});
    }
    const current=entry;current.active++;
    const result=current.queue.catch(()=>{}).then(async()=>action((await current.worker).adapter));
    current.queue=result.then(()=>{},()=>{});
    try{return await result;}finally{current.active--;current.lastUsed=Date.now();}
  }
  async sweep(){
    const expired=[...this.entries].filter(([,entry])=>entry.active===0&&Date.now()-entry.lastUsed>this.idleMs);
    await Promise.all(expired.map(async([key,entry])=>{if(this.entries.get(key)!==entry)return;this.entries.delete(key);try{await (await entry.worker).close();}catch{/* Only opaque lifecycle failures are surfaced through requests. */}}));
  }
  async close(){this.closing=true;const entries=[...this.entries.values()];this.entries.clear();await Promise.all(entries.map(async entry=>{try{await entry.queue;await(await entry.worker).close();}catch{/* Do not log provider state. */}}));}
}
export function validateAccountKey(value:unknown):asserts value is string {
  if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{3,80}$/.test(value))throw new AdapterError('INVALID_ACCOUNT_KEY','Use an opaque account key assigned by the API.');
}
export async function ownedStagingPath(root:string,accountKey:string,source:unknown):Promise<string> {
  validateAccountKey(accountKey);
  if(typeof source!=='string'||!isAbsolute(source))throw new AdapterError('PERMISSION_DENIED','The staged original must be an account-owned absolute path.');
  const owned=resolve(root,accountKey);const candidate=resolve(source);assertInside(owned,candidate);
  try {
    const actualOwned=await realpath(owned);const actual=await realpath(candidate);assertInside(actualOwned,actual);
    const rootReal=await realpath(root);assertInside(rootReal,actualOwned);
    if(!(await stat(actual)).isFile())throw new AdapterError('SOURCE_UNAVAILABLE','The staged source is not a regular file.');
    return actual;
  } catch(error){if(error instanceof AdapterError)throw error;throw new AdapterError('SOURCE_UNAVAILABLE','The staged original is unavailable.');}
}
function assertInside(root:string,path:string) {
  const part=relative(root,path);
  if(!part||part==='..'||part.startsWith(`..${sep}`)||isAbsolute(part))throw new AdapterError('PERMISSION_DENIED','The file is outside the account-owned storage directory.');
}
function stringValue(input:Record<string,unknown>,key:string,maximum=4096):string {
  const value=input[key];if(typeof value!=='string'||!value||value.length>maximum)throw new AdapterError('INVALID_REQUEST',`A valid ${key} is required.`);return value;
}
function referenceValue(input:Record<string,unknown>):AttachmentRef {
  const value=input.reference;if(!value||typeof value!=='object'||Array.isArray(value))throw new AdapterError('INVALID_REQUEST','An attachment reference is required.');
  const ref=value as Record<string,unknown>;
  const telegramUserId=stringValue(ref,'telegramUserId',30),peerId=stringValue(ref,'peerId',30),messageId=stringValue(ref,'messageId',30);
  if(!/^\d+$/.test(telegramUserId)||!/^-?\d+$/.test(peerId)||!/^\d+$/.test(messageId)||ref.attachmentIndex!==0)throw new AdapterError('INVALID_REQUEST','The attachment reference is invalid.');
  return {telegramUserId,peerId,messageId,attachmentIndex:0};
}
const methods=new Set<WorkerRpcMethod>(['auth.start','auth.step','auth.state','capabilities','chats.list','chats.select','attachments.list','files.send','files.result','files.fetch','files.refresh','session.revoke']);
async function dispatch(pool:AccountPool,root:string,request:WorkerRpcRequest):Promise<unknown> {
  if(!methods.has(request.method))throw new AdapterError('METHOD_NOT_FOUND','This worker operation is unsupported.');
  const input=request.input as Record<string,unknown>;
  return pool.use(request.accountKey,async adapter=>{
    const key=request.accountKey;
    switch(request.method) {
      case 'auth.start':return adapter.startAuthorization(key,{phoneNumber:stringValue(input,'phoneNumber',30)});
      case 'auth.step':{const type=input.type;if(type!=='code'&&type!=='password')throw new AdapterError('INVALID_AUTH_STEP','Telegram must request the authorization step.');return adapter.submitAuthorizationStep(key,{type,value:stringValue(input,'value',1024)});}
      case 'auth.state':return adapter.getAuthorizationState(key);
      case 'capabilities':return adapter.getAccountCapabilities(key);
      case 'chats.list':return adapter.listAllowedChats(key);
      case 'chats.select':return adapter.selectStorageChat(key,stringValue(input,'peerId',30));
      case 'attachments.list':return adapter.listAttachments(key,stringValue(input,'peerId',30),input.cursor===undefined?undefined:stringValue(input,'cursor',30));
      case 'files.send':return adapter.sendOriginalFile(key,{path:await ownedStagingPath(root,key,input.path),peerId:stringValue(input,'peerId',30),operationId:stringValue(input,'operationId',100),...(input.originalName===undefined?{}:{originalName:stringValue(input,'originalName',255)})});
      case 'files.result':return adapter.lookupSendResult(key,stringValue(input,'operationId',100));
      case 'files.fetch':return adapter.fetchOriginal(key,referenceValue(input));
      case 'files.refresh':return adapter.refreshReference(key,referenceValue(input));
      case 'session.revoke':return adapter.revokeAuthorization(key);
    }
  });
}
export function authorized(header:string|undefined,token:string):boolean {
  if(!header?.startsWith('Bearer '))return false;
  return timingSafeEqual(createHash('sha256').update(header.slice(7)).digest(),createHash('sha256').update(token).digest());
}
async function jsonBody(request:IncomingMessage):Promise<Record<string,unknown>> {
  if(!request.headers['content-type']?.toLowerCase().startsWith('application/json'))throw new AdapterError('INVALID_REQUEST','Use an application/json request body.');
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of request){length+=chunk.length;if(length>64*1024)throw new AdapterError('REQUEST_TOO_LARGE','The worker request is too large.');chunks.push(chunk);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw new AdapterError('INVALID_REQUEST','The worker request must be a JSON object.');}
}
function statusFor(error:AdapterError):number {
  if(['WORKER_DISABLED','ADAPTER_NOT_CONFIGURED','SESSION_STORAGE_NOT_APPROVED','WORKER_STOPPING','WORKER_CAPACITY'].includes(error.code))return 503;
  if(error.code==='PERMISSION_DENIED')return 403;if(error.code==='UNAUTHORIZED')return 401;if(error.code==='METHOD_NOT_FOUND')return 404;
  if(error.code==='PROVIDER_WAIT'||error.code==='ACCOUNT_BUSY')return 429;if(error.code==='REQUEST_TOO_LARGE')return 413;
  if(['SOURCE_UNAVAILABLE','REMOTE_FILE_MISSING'].includes(error.code))return 404;
  if(['IDEMPOTENCY_CONFLICT','ACCOUNT_MISMATCH','WORKER_LEASE_BUSY'].includes(error.code))return 409;
  if(error.code==='PROVIDER_ERROR')return 502;return 400;
}
function sendJson(response:ServerResponse,status:number,value:unknown){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));}
export function parseRange(header:string|undefined,bytes:number):{start:number;end:number;partial:boolean}|null {
  if(!header)return {start:0,end:bytes-1,partial:false};
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);if(!match||(!match[1]&&!match[2])||bytes===0)return null;
  let start:number,end:number;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,bytes-suffix);end=bytes-1;}
  else{start=Number(match[1]);end=match[2]?Number(match[2]):bytes-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=bytes||start>end)return null;end=Math.min(end,bytes-1);}
  return {start,end,partial:true};
}
export function createWorkerService(config:WorkerServiceConfig,factory?:AccountWorkerFactory) {
  const pool=new AccountPool(factory??(accountKey=>createTdlibAdapter(accountKey,config.provider!)),config.maxAccounts,config.idleMs);
  const configured=Boolean(config.enabled&&config.approved&&(config.provider||factory));
  const timer=setInterval(()=>void pool.sweep(),60_000);timer.unref();
  const server=createServer({requestTimeout:120_000,headersTimeout:15_000,maxHeaderSize:16*1024},async(request,response)=>{
    try {
      if(request.url==='/health'&&request.method==='GET'){sendJson(response,200,{service:'telegram-worker',configured,enabled:config.enabled,approved:config.approved,activeAccounts:pool.size});return;}
      if(!authorized(request.headers.authorization,config.token))throw new AdapterError('UNAUTHORIZED','Internal service authentication is required.');
      if(!configured)throw new AdapterError(config.unavailableCode,'The Telegram worker is unavailable until credentials and approved encrypted session storage are configured.');
      if(request.method!=='POST'||(request.url!=='/rpc'&&request.url!=='/content'))throw new AdapterError('METHOD_NOT_FOUND','This worker endpoint is unsupported.');
      const body=await jsonBody(request);validateAccountKey(body.accountKey);
      if(request.url==='/rpc') {
        if(typeof body.method!=='string'||!body.input||typeof body.input!=='object'||Array.isArray(body.input))throw new AdapterError('INVALID_REQUEST','A method and input object are required.');
        const result=await dispatch(pool,config.stagingRoot,body as WorkerRpcRequest);sendJson(response,200,{result});return;
      }
      const file=await pool.use(body.accountKey,adapter=>adapter.fetchOriginal(body.accountKey as string,referenceValue(body)));
      const details=await stat(file.path);if(!details.isFile()||details.size!==file.bytes)throw new AdapterError('SOURCE_UNAVAILABLE','The downloaded original is unavailable.');
      const range=parseRange(request.headers.range,details.size);
      if(!range){response.writeHead(416,{'Content-Range':`bytes */${details.size}`,'Cache-Control':'no-store'});response.end();return;}
      const length=Math.max(0,range.end-range.start+1);
      response.writeHead(range.partial?206:200,{'Content-Type':'application/octet-stream','Content-Length':length,'Accept-Ranges':'bytes','Content-Disposition':'attachment; filename="original"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",...(range.partial?{'Content-Range':`bytes ${range.start}-${range.end}/${details.size}`}:{})});
      if(!length){response.end();return;}
      await pipeline(createReadStream(file.path,{start:range.start,end:range.end,highWaterMark:64*1024}),response);
    } catch(error) {
      if(response.headersSent){response.destroy();return;}
      const safe=error instanceof AdapterError?error:new AdapterError('WORKER_FAILED','The worker could not complete this operation.');
      if(safe.retryAfterSeconds)response.setHeader('Retry-After',String(safe.retryAfterSeconds));
      sendJson(response,error instanceof AdapterError?statusFor(safe):500,{error:{code:safe.code,message:safe.message,...(safe.retryAfterSeconds?{retryAfterSeconds:safe.retryAfterSeconds}:{})}});
    }
  });
  return {server,pool,close:async()=>{clearInterval(timer);await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await pool.close();}};
}
