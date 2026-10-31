import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Pool } from 'pg';
import type express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { DomainError, MAX_FILE_BYTES } from '@cloudnest/domain';
import type { AuthorizationState } from '@cloudnest/contracts';
import { PgAuthStore, hashToken, type SessionIssue } from './auth-store.js';
import { PgCatalogRepository } from './postgres-repository.js';
import { TelegramClient, ProviderError } from './telegram-client.js';
import { requests, type CatalogRepository } from './request-context.js';
import { TransferDispatcher } from './dispatch.js';
import { SyncService } from './sync.js';

const sessionCookie='cn_session',loginCookie='cn_login',csrfCookie='cn_csrf';
const cookies=(request:Request):Record<string,string>=>{
  const parsed:Record<string,string>=Object.create(null);
  for(const part of (request.headers.cookie||'').split(';')){const index=part.indexOf('=');if(index<0)continue;try{parsed[part.slice(0,index).trim()]=decodeURIComponent(part.slice(index+1).trim());}catch{/* Treat malformed cookie values as missing credentials. */}}
  return parsed;
};
const equal=(a:string,b:string)=>{const x=Buffer.from(a);const y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const wrap=(fn:(req:Request,res:Response)=>unknown|Promise<unknown>)=>(req:Request,res:Response,next:NextFunction)=>Promise.resolve(fn(req,res)).catch(next);

export interface ProductionRuntime {
  pool:Pool;auth:PgAuthStore;worker:TelegramClient;stagingRoot:string;cookieSecret:string;origin:string;
  repositoryFor(userId:string):CatalogRepository;
  dispatcher:TransferDispatcher;sync:SyncService;close():Promise<void>;
}
export async function productionFromEnvironment():Promise<ProductionRuntime|undefined> {
  if(process.env.CLOUDNEST_API_ENABLE!=='true')return;
  const database=process.env.DATABASE_URL,workerUrl=process.env.TELEGRAM_WORKER_URL,token=process.env.CLOUDNEST_WORKER_TOKEN,cookieSecret=process.env.CLOUDNEST_COOKIE_SECRET;
  const origin=process.env.APP_ORIGIN||'';
  if(!database||!workerUrl||!token||token.length<32||!cookieSecret||cookieSecret.length<32||!process.env.STAGING_ROOT)throw new Error('Server mode requires database, worker, cookie and staging configuration.');
  const originUrl=new URL(origin);
  if(originUrl.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(originUrl.hostname))throw new Error('APP_ORIGIN must use HTTPS outside local development.');
  const pool=new Pool({connectionString:database,max:10});
  const authPool=process.env.AUTH_DATABASE_URL&&process.env.AUTH_DATABASE_URL!==database?new Pool({connectionString:process.env.AUTH_DATABASE_URL,max:5}):pool;
  const auth=new PgAuthStore(authPool),worker=new TelegramClient(workerUrl,token),stagingRoot=resolve(process.env.STAGING_ROOT);
  await pool.query('SELECT 1 FROM login_transactions LIMIT 0');
  await mkdir(stagingRoot,{recursive:true,mode:0o700});
  let runtime:ProductionRuntime;
  runtime={pool,auth,worker,stagingRoot,cookieSecret,origin,repositoryFor:userId=>new PgCatalogRepository(pool,userId),dispatcher:undefined as unknown as TransferDispatcher,sync:undefined as unknown as SyncService,close:async()=>{runtime.dispatcher.stop();runtime.sync.stop();if(authPool!==pool)await authPool.end();await pool.end();}};
  runtime.dispatcher=new TransferDispatcher(runtime,pool);runtime.sync=new SyncService(runtime,pool);
  if(process.env.CLOUDNEST_DISPATCH_AUTO!=='false'){runtime.dispatcher.start();runtime.sync.start();}
  return runtime;
}

export function installProductionAuth(server:express.Express,runtime:ProductionRuntime):void {
  const secure=new URL(runtime.origin).protocol==='https:';
  const setCookie=(response:Response,name:string,value:string,maxAge:number)=>response.cookie(name,value,{httpOnly:true,secure,sameSite:'lax',path:'/',maxAge});
  const clearCookie=(response:Response,name:string)=>response.clearCookie(name,{httpOnly:true,secure,sameSite:'lax',path:'/'});
  const sign=(value:string)=>createHmac('sha256',runtime.cookieSecret).update(value).digest('base64url');
  const preAuthCsrf=(value:string)=>{const parts=value.split('.');return parts.length===2&&/^[\w-]{40,80}$/.test(parts[0])&&equal(sign(parts[0]),parts[1]);};
  const csrfFor=async(request:Request,requireAuthenticated=false):Promise<string>=>{
    const values=cookies(request),header=request.get('X-CSRF-Token')||'';
    if(values[sessionCookie]){
      const authenticated=await runtime.auth.authenticateSession(values[sessionCookie]);
      if(authenticated){if(!header||!equal(hashToken(header),authenticated.csrfTokenHash))throw new DomainError('CSRF_INVALID','Refresh this page before trying again.',403);return header;}
    }
    if(requireAuthenticated)throw new DomainError('AUTH_EXPIRED','Connect Telegram to continue.',401);
    if(!header||!equal(header,values[csrfCookie]||'')||!preAuthCsrf(header))throw new DomainError('CSRF_INVALID','Refresh this page before trying again.',403);
    return header;
  };
  const rate=async(request:Request,bucket:string,limit:number,seconds:number)=>{
    const ip=createHmac('sha256',runtime.cookieSecret).update(request.ip||'unknown').digest('hex');
    const result=await runtime.auth.checkRateLimit(`${bucket}:${ip}`,limit,seconds);
    if(!result.allowed)throw new ProviderError('RATE_LIMITED','Too many attempts. Wait before trying again.',429,result.retryAfterSeconds);
  };
  const issue=(response:Response,session:SessionIssue)=>{
    const maxAge=Math.max(0,Date.parse(session.session.expiresAt)-Date.now());
    setCookie(response,sessionCookie,session.token,maxAge);setCookie(response,csrfCookie,session.csrfToken,maxAge);clearCookie(response,loginCookie);
  };
  const publishState=async(request:Request,response:Response,state:AuthorizationState,loginToken:string)=>{
    if(state.state==='ready'){
      const transaction=await runtime.auth.getLoginTransaction(loginToken);
      if(!transaction)throw new DomainError('AUTH_EXPIRED','This connection expired. Start again.',401);
      const verified=await runtime.auth.upsertVerifiedUser(state.telegramUserId),previous=await runtime.auth.getTelegramSession(verified.id);
      let reuseAccountKey:string|undefined;
      if(previous?.state==='connected'&&previous.accountKey!==transaction.accountKey){
        try{const previousState=await runtime.worker.state(previous.accountKey);if(previousState.state==='ready'&&previousState.telegramUserId===state.telegramUserId)reuseAccountKey=previous.accountKey;}catch{/* A new verified session can be bound, but old database-local references must not be used through it. */}
      }
      const session=await runtime.auth.completeLogin(loginToken,{telegramUserId:state.telegramUserId,reuseAccountKey});
      const activeKey=reuseAccountKey||transaction.accountKey;
      let recoveryRequired=false;
      if(session.previousAccountKey&&!reuseAccountKey){
        await runtime.repositoryFor(session.user.id).transaction(catalog=>{for(const file of catalog.files){if(file.availability==='confirmed'&&file.remote_reference?.account_key!==activeKey){file.availability='unavailable';file.version++;file.updated_at=new Date().toISOString();recoveryRequired=true;}}});
      }
      const retired=session.unusedAccountKey||session.previousAccountKey;
      if(retired){
        await runtime.auth.enqueueRevocation(session.user.id,retired);
        try{const outcome=await runtime.worker.revoke(retired);if(outcome==='confirmed')await runtime.auth.completeRevocation(session.user.id,retired);else await runtime.auth.deferRevocation(session.user.id,retired);}catch(error){await runtime.auth.deferRevocation(session.user.id,retired,error instanceof ProviderError?error.retryAfterSeconds:undefined,error instanceof ProviderError?error.code:'WORKER_UNAVAILABLE');}
      }
      issue(response,session);response.json({state:'ready',csrf_token:session.csrfToken,recovery_required:recoveryRequired});return;
    }
    await runtime.auth.updateLoginTransaction(loginToken,state as unknown as Record<string,unknown>);
    const txn=await runtime.auth.getLoginTransaction(loginToken);
    response.json({...state,transaction_id:txn?.id});
  };
  server.get('/v1/auth/bootstrap',wrap(async(request,response)=>{
    const values=cookies(request),authenticated=values[sessionCookie]?await runtime.auth.authenticateSession(values[sessionCookie]):null;
    if(authenticated&&values[csrfCookie]&&equal(hashToken(values[csrfCookie]),authenticated.csrfTokenHash)){
      response.json({authenticated:true,csrf_token:values[csrfCookie],user:{id:authenticated.user.id,telegram_user_id:authenticated.user.telegramUserId,locale:authenticated.user.locale}});return;
    }
    if(values[sessionCookie])clearCookie(response,sessionCookie);
    const nonce=randomBytes(32).toString('base64url'),csrf=`${nonce}.${sign(nonce)}`;setCookie(response,csrfCookie,csrf,30*60*1000);
    response.json({authenticated:false,csrf_token:csrf});
  }));
  server.post('/v1/auth/telegram/start',wrap(async(request,response)=>{
    await csrfFor(request);await rate(request,'login:start',8,600);
    const body=request.body||{},phone=body.phoneNumber||body.phone;
    if(body.disclosureAccepted!==true)throw new DomainError('DISCLOSURE_REQUIRED','Review and accept the Telegram session disclosure.',400);
    if(typeof phone!=='string'||!/^\+[1-9][0-9\s-]{6,20}$/.test(phone))throw new DomainError('INVALID_PHONE','Enter a phone number with its country code.',400);
    const phoneKey=createHash('sha256').update(phone.replace(/[\s-]/g,'')).digest('hex');
    const byAccount=await runtime.auth.checkRateLimit(`phone:${phoneKey}`,5,600);
    if(!byAccount.allowed)throw new ProviderError('RATE_LIMITED','Wait before requesting another code.',429,byAccount.retryAfterSeconds);
    const transaction=await runtime.auth.createLoginTransaction(randomUUID());
    setCookie(response,loginCookie,transaction.token,10*60*1000);
    const state=await runtime.worker.start(transaction.accountKey,phone.replace(/[\s-]/g,''));
    await publishState(request,response,state,transaction.token);
  }));
  server.get('/v1/auth/telegram/state',wrap(async(request,response)=>{
    const values=cookies(request),transaction=await runtime.auth.getLoginTransaction(values[loginCookie]||'');
    if(!transaction){
      if(values[sessionCookie]&&await runtime.auth.authenticateSession(values[sessionCookie])){response.json({state:'ready'});return;}
      throw new DomainError('AUTH_EXPIRED','This connection has expired. Start again.',401);
    }
    await rate(request,'login:poll',120,60);
    await publishState(request,response,await runtime.worker.state(transaction.accountKey),values[loginCookie]);
  }));
  server.post('/v1/auth/telegram/step',wrap(async(request,response)=>{
    await csrfFor(request);await rate(request,'login:step',20,600);
    const values=cookies(request),transaction=await runtime.auth.getLoginTransaction(values[loginCookie]||'');
    if(!transaction)throw new DomainError('AUTH_EXPIRED','This connection has expired. Start again.',401);
    const body=request.body?.step||request.body||{};
    if(!['code','password'].includes(body.type)||typeof body.value!=='string'||!body.value||body.value.length>512)throw new DomainError('INVALID_AUTH_STEP','Enter the verification step requested by Telegram.',400);
    const state=await runtime.worker.step(transaction.accountKey,{type:body.type,value:body.value});
    await publishState(request,response,state,values[loginCookie]);
  }));
  server.post('/v1/auth/refresh',wrap(async(request,response)=>{
    const values=cookies(request),header=request.get('X-CSRF-Token')||'';
    if(!values[sessionCookie]||!header||!equal(header,values[csrfCookie]||''))throw new DomainError('CSRF_INVALID','Refresh this page before trying again.',403);
    const session=await runtime.auth.rotateSession(values[sessionCookie]);issue(response,session);response.json({refreshed:true,csrf_token:session.csrfToken});
  }));
  server.use('/v1',async(request,response,next)=>{
    try{
      const values=cookies(request),authenticated=values[sessionCookie]?await runtime.auth.authenticateSession(values[sessionCookie]):null;
      if(!authenticated)throw new DomainError('AUTH_EXPIRED','Connect Telegram to continue.',401);
      if(!['GET','HEAD','OPTIONS'].includes(request.method))await csrfFor(request,true);
      const telegram=await runtime.auth.getTelegramSession(authenticated.user.id);
      requests.run({userId:authenticated.user.id,sessionToken:values[sessionCookie],accountKey:telegram?.accountKey,repository:runtime.repositoryFor(authenticated.user.id),csrfToken:values[csrfCookie]},()=>next());
    }catch(error){next(error);}
  });
  server.get('/v1/sync-jobs',wrap(async(_request,response)=>response.json({items:await runtime.sync.listJobs(requests.getStore()!.userId)})));
  server.post('/v1/sync-jobs',wrap(async(request,response)=>{
    const input=request.body||{};
    const job=await runtime.sync.startJob(requests.getStore()!.userId,typeof input.storage_chat_id==='string'?input.storage_chat_id:undefined);
    response.status(202).json(job);
  }));
  server.get('/v1/sync-jobs/:id',wrap(async(request,response)=>response.json(await runtime.sync.getJob(requests.getStore()!.userId,String(request.params.id)))));
  server.get('/v1/me',wrap(async(request,response)=>{
    const value=requests.getStore()!,user=await runtime.auth.getUser(value.userId),telegram=await runtime.auth.getTelegramSession(value.userId),selected=await runtime.auth.getSelectedChat(value.userId);
    let connectionState=telegram?.state||'disconnected';
    if(telegram?.state==='connected'){
      try{const actual=await runtime.worker.state(telegram.accountKey);if(actual.state!=='ready'||actual.telegramUserId!==user!.telegramUserId){connectionState='expired';await runtime.auth.setTelegramSessionState(value.userId,'expired');}}
      catch(error){connectionState=error instanceof ProviderError&&error.code==='AUTH_EXPIRED'?'expired':'unavailable';if(connectionState==='expired')await runtime.auth.setTelegramSessionState(value.userId,'expired');}
    }
    response.json({id:user!.id,telegram_user_id:user!.telegramUserId,locale:user!.locale,mode:'server',csrf_token:value.csrfToken,telegram_connected:connectionState==='connected',connection_state:connectionState,storage_selected:Boolean(selected),capabilities:{file_limit_bytes:MAX_FILE_BYTES,remote_deletion:false,camera_backup:false}});
  }));
  server.get('/v1/me/devices',wrap(async(_request,response)=>response.json({items:await runtime.auth.listDevices(requests.getStore()!.userId)})));
  server.post('/v1/auth/logout',wrap(async(_request,response)=>{
    await runtime.auth.revokeSession(requests.getStore()!.sessionToken!);clearCookie(response,sessionCookie);clearCookie(response,csrfCookie);response.json({signed_out:true,telegram_untouched:true});
  }));
  server.delete('/v1/me/telegram-session',wrap(async(_request,response)=>{
    const value=requests.getStore()!;let outcome:'confirmed'|'pending'='pending';
    await runtime.auth.setTelegramSessionState(value.userId,'revocation_pending');
    if(value.accountKey){
      await runtime.auth.enqueueRevocation(value.userId,value.accountKey);
      try{outcome=await runtime.worker.revoke(value.accountKey);if(outcome==='confirmed')await runtime.auth.completeRevocation(value.userId,value.accountKey);else await runtime.auth.deferRevocation(value.userId,value.accountKey);}catch(error){await runtime.auth.deferRevocation(value.userId,value.accountKey,error instanceof ProviderError?error.retryAfterSeconds:undefined,error instanceof ProviderError?error.code:'WORKER_UNAVAILABLE');}
    }
    await runtime.auth.setTelegramSessionState(value.userId,outcome==='confirmed'?'disconnected':'revocation_pending');
    response.json({state:outcome==='confirmed'?'disconnected':'revocation_pending',revocation:outcome,telegram_messages_untouched:true});
  }));
  server.get('/v1/storage-chats',wrap(async(_request,response)=>{
    const value=requests.getStore()!,telegram=await runtime.auth.getTelegramSession(value.userId);
    if(!value.accountKey||telegram?.state!=='connected'){response.json({items:[],connected:false});return;}
    const [available,selected]=await Promise.all([runtime.worker.chats(value.accountKey),runtime.auth.getSelectedChat(value.userId)]);
    response.json({items:available.map(chat=>({peer_id:chat.peerId,title:chat.title,type:chat.kind,can_send:chat.canSend,can_delete:chat.canDelete,selected:chat.peerId===selected?.peerId})),connected:true});
  }));
  server.post('/v1/storage-chats',wrap(async(request,response)=>{
    const value=requests.getStore()!;if(!value.accountKey)throw new DomainError('AUTH_EXPIRED','Connect Telegram before selecting storage.',401);
    const body=request.body||{},chats=await runtime.worker.chats(value.accountKey);
    const selected=body.type==='saved_messages'?chats.find(chat=>chat.kind==='saved_messages'):chats.find(chat=>chat.peerId===(body.peer_id||body.peerId));
    if(!selected||!selected.canSend)throw new DomainError('PERMISSION_DENIED','Choose a writable storage chat that you control.',403);
    const verified=await runtime.worker.selectChat(value.accountKey,selected.peerId);
    const saved=await runtime.auth.selectChat(value.userId,verified);response.status(201).json({id:saved.id,peer_id:saved.peerId,title:saved.title,type:saved.kind,can_send:saved.canSend,can_delete:saved.canDelete,selected:true});
  }));
}
