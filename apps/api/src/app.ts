import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  DomainError, MAX_FILE_BYTES, catalogExport, cleanName, createFolder, deleteFolder, listFiles,
  owned, parseRange, patchFile, patchFolder, removeCatalogFile, setTrashed, transition, validateOffset,
  type CatalogState, type FileRecord, type Transfer
} from '@cloudnest/domain';
import { DemoCatalogRepository } from './repository.js';
import { currentUser, requests, scope, type CatalogRepository } from './request-context.js';
import { installProductionAuth, productionFromEnvironment, type ProductionRuntime } from './production.js';
import { ProviderError } from './telegram-client.js';
import { providerReference } from './dispatch.js';
import { Readable } from 'node:stream';
import { sniffPreview } from './preview.js';

class ApiModule {}
Module({})(ApiModule);

const DEMO_USER = '00000000-0000-4000-8000-000000000001';
type Route = (request: Request, response: Response) => unknown | Promise<unknown>;
type ErrorRequest = Request & { requestId?: string };
const wrap = (callback: Route) => (request: Request, response: Response, next: NextFunction) => Promise.resolve(callback(request, response)).catch(next);
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const paramsId = (request: Request): string => String(request.params.id);
const bodyRecord = (request: Request): Record<string, any> => {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Buffer.isBuffer(request.body)) throw new DomainError('INVALID_INPUT', 'A JSON object is required.');
  return request.body;
};
const version = (request: Request): number => {
  const value = request.get('If-Match');
  if (!value || !/^"?\d+"?$/.test(value)) throw new DomainError('PRECONDITION_REQUIRED', 'Send the current item version in If-Match.', 428);
  return Number(value.replaceAll('"', ''));
};

function idempotent<T>(request: Request, state: CatalogState, scope: string, callback: () => T): T {
  const key = request.get('Idempotency-Key');
  if (!key || key.length > 128 || !/^[\w.:-]+$/.test(key)) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key header.');
  const digest = createHash('sha256').update(JSON.stringify(request.body ?? null)).digest('hex');
  const existing = state.idempotency.find(item => item.user_id === currentUser() && item.scope === scope && item.key === key && item.expires_at > new Date().toISOString());
  if (existing) {
    if (existing.digest !== digest) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This request key was already used for different data.', 409);
    return existing.result as T;
  }
  const result = callback();
  state.idempotency = state.idempotency.filter(item => item.expires_at > new Date().toISOString());
  state.idempotency.push({ user_id: currentUser(), scope, key, digest, result: structuredClone(result), expires_at: new Date(Date.now() + 86400000).toISOString() });
  return result;
}

export interface ApiOptions { demo?: boolean; directory?: string; origin?: string; logger?: boolean; production?: ProductionRuntime }
export async function createApi(options: ApiOptions = {}) {
  const demo = options.demo ?? process.env.CLOUDNEST_DEMO === '1';
  const production = demo ? undefined : options.production ?? await productionFromEnvironment();
  const origin = options.origin ?? production?.origin ?? process.env.APP_ORIGIN ?? 'http://localhost:3000';
  const directory = resolve(options.directory ?? process.env.CLOUDNEST_DATA_DIR ?? '.data/api');
  const localRepository = new DemoCatalogRepository(directory);
  if (demo) await localRepository.initialize();
  const repository: CatalogRepository = {
    read: callback => scope().repository.read(callback),
    transaction: callback => scope().repository.transaction(callback)
  };
  const staging = production?.stagingRoot ?? join(directory, 'staging');
  const stagingPath = (id:string,accountKey?:string) => {
    if(!production)return join(staging,id);
    const key=accountKey||scope().accountKey;
    if(!key||!/^[A-Za-z0-9_-]{3,80}$/.test(key))throw new DomainError('AUTH_EXPIRED','The Telegram transfer authorization is unavailable.',401);
    return join(staging,key,id);
  };
  if (demo) await mkdir(staging, { recursive: true, mode: 0o700 });
  const app = await NestFactory.create(ApiModule, { bodyParser: false, logger: options.logger === false ? false : ['error', 'warn', 'log'] });
  const server = app.getHttpAdapter().getInstance() as express.Express;
  server.disable('x-powered-by');
  const proxyHops=Number(process.env.CLOUDNEST_TRUST_PROXY_HOPS||0);
  if(Number.isSafeInteger(proxyHops)&&proxyHops>0&&proxyHops<=5)server.set('trust proxy',proxyHops);
  server.use((request: ErrorRequest, response: Response, next: NextFunction) => {
    request.requestId = randomUUID();
    response.setHeader('X-Request-Id', request.requestId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
    if (request.headers.origin === origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PATCH,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Idempotency-Key,If-Match,Upload-Offset,Upload-Checksum,Range,X-CSRF-Token');
      response.setHeader('Access-Control-Expose-Headers', 'Upload-Offset,Upload-Length,Content-Range,ETag,X-Request-Id');
    }
    if (request.method === 'OPTIONS') { response.sendStatus(204); return; }
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin && request.headers.origin !== origin) { next(new DomainError('PERMISSION_DENIED', 'This origin is not allowed.', 403)); return; }
    next();
  });
  server.use('/v1', express.json({ limit: '64kb', type: 'application/json' }));
  server.get('/v1/health', (_request, response) => response.json({ status: 'ok', service: 'cloudnest-api', mode: demo ? 'local-demo' : production ? 'server' : 'not-configured', telegram: production ? 'worker-configured' : 'not-configured', production_ready: false }));
  if (production) installProductionAuth(server, production);
  else {
    server.get('/v1/auth/bootstrap', (_request,response) => response.json({authenticated:demo,csrf_token:null,mode:demo?'local-demo':'not-configured'}));
    server.get('/v1/auth/telegram/state', (_request, response) => response.status(503).json({ state: 'unavailable', error: { code: 'ADAPTER_NOT_CONFIGURED', message: 'A verified Telegram worker and developer credentials are required.' } }));
    server.post(['/v1/auth/telegram/start', '/v1/auth/telegram/step'], wrap(() => { throw new DomainError('ADAPTER_NOT_CONFIGURED', 'Live Telegram login is not configured. No login code or password has been stored.', 503); }));
    server.use('/v1', (_request, _response, next) => {
      if (!demo) { next(new DomainError('AUTH_NOT_CONFIGURED', 'Verified account authentication and PostgreSQL persistence must be configured before enabling this API.', 503)); return; }
      requests.run({userId:DEMO_USER,repository:localRepository},()=>next());
    });
    server.get('/v1/me', (_request, response) => response.json({ id: currentUser(), name: 'Local demo', locale: 'en', mode: 'local-demo', telegram_connected: false, capabilities: { file_limit_bytes: MAX_FILE_BYTES, remote_deletion: false, camera_backup: false } }));
    server.get('/v1/me/devices', (_request, response) => response.json({ items: [], message: 'Device sessions require a verified Telegram account.' }));
    server.get('/v1/storage-chats', (_request, response) => response.json({ items: [], connected: false }));
  }
  server.get('/v1/files', wrap(async (request, response) => response.json(await repository.read(state => listFiles(state, currentUser(), {
    q: text(request.query.q), type: text(request.query.type), folder_id: request.query.folder_id === 'root' ? null : text(request.query.folder_id),
    favorite: request.query.favorite === undefined ? undefined : request.query.favorite === 'true', trash: request.query.trash === 'true',
    cursor: text(request.query.cursor), limit: request.query.limit ? Number(request.query.limit) : undefined,
    after: text(request.query.after), before: text(request.query.before)
  })))));
  server.get('/v1/files/:id', wrap(async (request, response) => {
    const file = await repository.read(state => owned(state.files, currentUser(), paramsId(request)));
    response.setHeader('ETag', `"${file.version}"`); response.json(file);
  }));
  server.patch('/v1/files/:id', wrap(async (request, response) => response.json(await repository.transaction(state => idempotent(request, state, `file:${paramsId(request)}`, () => patchFile(state, currentUser(), paramsId(request), bodyRecord(request), version(request)))))));
  for (const [action, trashed] of [['trash', true], ['restore', false]] as const) server.post(`/v1/files/:id/${action}`, wrap(async (request, response) => response.json(await repository.transaction(state => idempotent(request, state, `${action}:${paramsId(request)}`, () => setTrashed(state, currentUser(), paramsId(request), trashed))))));
  server.delete('/v1/files/:id/catalog', wrap(async (request, response) => {
    await repository.transaction(state => idempotent(request, state, `remove:${paramsId(request)}`, () => { removeCatalogFile(state, currentUser(), paramsId(request)); return { removed_from_app: true, telegram_untouched: true }; }));
    response.json({ removed_from_app: true, telegram_untouched: true });
  }));
  server.post('/v1/files/:id/delete-remote', wrap(async (request) => {
    await repository.read(state => owned(state.files, currentUser(), paramsId(request)));
    throw new DomainError('ADAPTER_NOT_CONFIGURED', 'Deleting Telegram messages requires a verified provider connection and separate explicit confirmation.', 503);
  }));
  server.post('/v1/files/bulk', wrap(async (request, response) => {
    const body = bodyRecord(request);
    if (!Array.isArray(body.items) || body.items.length > 100) throw new DomainError('INVALID_INPUT', 'Provide up to 100 items.');
    response.json(await repository.transaction(state => idempotent(request, state, 'files:bulk', () => ({ items: body.items.map((item: any) => {
      const itemId = item && typeof item.id === 'string' ? item.id : null;
      const copy = structuredClone(state);
      try {
        if (!itemId || !Number.isSafeInteger(item.version) || !item.patch || typeof item.patch !== 'object' || Array.isArray(item.patch)) throw new DomainError('INVALID_INPUT', 'Each item requires an ID, version and metadata patch.');
        const file = patchFile(copy, currentUser(), itemId, item.patch, item.version); Object.assign(state, copy); return { id: itemId, ok: true, file };
      }
      catch (error) { return { id: itemId, ok: false, error: { code: error instanceof DomainError ? error.code : 'INVALID_INPUT', message: error instanceof DomainError ? error.message : 'This item could not be updated.' } }; }
    }) }))));
  }));
  server.get('/v1/folders', wrap(async (_request, response) => response.json(await repository.read(state => ({ items: state.folders.filter(folder => folder.user_id === currentUser() && !folder.trashed_at) })))));
  server.post('/v1/folders', wrap(async (request, response) => response.status(201).json(await repository.transaction(state => idempotent(request, state, 'folders:create', () => createFolder(state, currentUser(), bodyRecord(request) as { name: unknown }))))));
  server.patch('/v1/folders/:id', wrap(async (request, response) => response.json(await repository.transaction(state => idempotent(request, state, `folder:${paramsId(request)}`, () => patchFolder(state, currentUser(), paramsId(request), bodyRecord(request), version(request)))))));
  server.delete('/v1/folders/:id', wrap(async (request, response) => {
    const mode = bodyRecord(request).contents;
    if (mode !== 'root' && mode !== 'trash') throw new DomainError('CONFIRMATION_REQUIRED', 'Choose whether folder contents move to root or app trash.');
    await repository.transaction(state => idempotent(request, state, `folder:delete:${paramsId(request)}`, () => { deleteFolder(state, currentUser(), paramsId(request), mode, version(request)); return { removed: true, telegram_untouched: true }; }));
    response.json({ removed: true, telegram_untouched: true });
  }));
  server.get('/v1/exports/catalog', wrap(async (_request, response) => {
    response.setHeader('Content-Disposition', 'attachment; filename="cloudnest-catalog.json"');
    response.json(await repository.read(state => catalogExport(state, currentUser())));
  }));
  server.post('/v1/uploads', wrap(async (request, response) => {
    const body = bodyRecord(request);
    const name = cleanName(body.name ?? body.original_name);
    if (production) {
      const telegram = await production.auth.getTelegramSession(currentUser());
      if (!scope().accountKey || telegram?.state !== 'connected') throw new DomainError('AUTH_EXPIRED','Connect Telegram before uploading.',401);
      const selected = await production.auth.getSelectedChat(currentUser());
      if (!selected?.canSend) throw new DomainError('STORAGE_REQUIRED','Choose a writable storage chat before uploading.',409);
      await mkdir(join(staging,scope().accountKey!),{recursive:true,mode:0o700});
    }
    if (!Number.isSafeInteger(body.bytes) || body.bytes < 0 || body.bytes > MAX_FILE_BYTES) throw new DomainError('FILE_TOO_LARGE', 'The local product limit is 500 MiB per file.', 413);
    response.status(201).json(await repository.transaction(state => idempotent(request, state, 'uploads:create', () => {
      if (body.folder_id) { const folder = owned(state.folders, currentUser(), body.folder_id); if (folder.trashed_at) throw new DomainError('INVALID_FOLDER', 'Choose an active folder.'); }
      const reserved = state.transfers.filter(item => item.user_id === currentUser() && !['CANCELLED', 'FAILED', 'COMPLETED'].includes(item.state)).reduce((sum, item) => sum + item.expected_bytes, 0);
      if (reserved + body.bytes > 2 * 1024 * 1024 * 1024) throw new DomainError('STAGING_QUOTA_EXCEEDED', 'The local staging budget is full.', 413);
      const now = new Date().toISOString();
      const transfer: Transfer = { id: randomUUID(), user_id: currentUser(), operation_id: randomUUID(), file_id: null, folder_id: body.folder_id ?? null, name, mime: typeof body.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(body.mime) ? body.mime : 'application/octet-stream', expected_bytes: body.bytes, stage_bytes: 0, state: 'CREATED', ...(production?{account_key:scope().accountKey}:{}), attempts: 0, error_code: null, created_at: now, updated_at: now, sha256: null };
      state.transfers.push(transfer);
      return { ...transfer, upload_url: `/v1/uploads/${transfer.id}`, local_demo: demo };
    })));
  }));
  server.head('/v1/uploads/:id', wrap(async (request, response) => {
    const transfer = await repository.read(state => owned(state.transfers, currentUser(), paramsId(request)));
    response.set({ 'Upload-Offset': String(transfer.stage_bytes), 'Upload-Length': String(transfer.expected_bytes), 'Tus-Resumable': '1.0.0' }).sendStatus(204);
  }));
  server.patch('/v1/uploads/:id', express.raw({ type: 'application/offset+octet-stream', limit: '8mb' }), wrap(async (request, response) => {
    if (!Buffer.isBuffer(request.body)) throw new DomainError('INVALID_CHUNK', 'Use application/offset+octet-stream for upload chunks.');
    const chunk = request.body as Buffer;
    const checksum = request.get('Upload-Checksum');
    if (checksum) {
      const match = /^sha256 ([A-Za-z0-9+/]+={0,2})$/.exec(checksum);
      const expected = match ? Buffer.from(match[1], 'base64') : Buffer.alloc(0);
      const actual = createHash('sha256').update(chunk).digest();
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new DomainError('CHECKSUM_MISMATCH', 'The upload chunk checksum did not match.', 460);
    }
    const offset = Number(request.get('Upload-Offset'));
    if (!request.get('Upload-Offset')) throw new DomainError('OFFSET_REQUIRED', 'Send the current Upload-Offset.');
    const transfer = await repository.transaction(async state => {
      const transfer = owned(state.transfers, currentUser(), paramsId(request));
      if(production&&transfer.account_key&&transfer.account_key!==scope().accountKey)throw new DomainError('ACCOUNT_SESSION_CHANGED','This transfer belongs to a previous Telegram connection. Cancel it and select the original again.',409);
      validateOffset(transfer, offset, chunk.length);
      const path = stagingPath(transfer.id,transfer.account_key);
      const handle = await open(path, offset === 0 ? 'w' : 'r+', 0o600);
      try {
        let written = 0;
        while (written < chunk.length) {
          const result = await handle.write(chunk, written, chunk.length - written, offset + written);
          if (result.bytesWritten === 0) throw new DomainError('STAGING_WRITE_FAILED', 'The staged chunk could not be written.', 503);
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (transfer.state === 'CREATED') transition(transfer, 'STAGING');
      transfer.verified_chunks = [...(transfer.verified_chunks || []),{offset,length:chunk.length,checksum:createHash('sha256').update(chunk).digest('hex')}];
      transfer.stage_bytes += chunk.length; transfer.updated_at = new Date().toISOString();
      return transfer;
    });
    response.setHeader('Upload-Offset', String(transfer.stage_bytes)); response.sendStatus(204);
  }));
  server.post('/v1/uploads/:id/commit', wrap(async (request, response) => {
    const result = await repository.transaction(async state => {
      const transfer = owned(state.transfers, currentUser(), paramsId(request));
      if (transfer.file_id) return { transfer, file: owned(state.files, currentUser(), transfer.file_id), telegram_confirmed: transfer.state==='COMPLETED' };
      if (production && ['QUEUED','SENDING','VERIFYING','RECONCILING','NEEDS_ATTENTION','WAITING_PROVIDER','COMPLETED'].includes(transfer.state)) return {transfer,telegram_confirmed:transfer.state==='COMPLETED'};
      if(production&&transfer.account_key&&transfer.account_key!==scope().accountKey)throw new DomainError('ACCOUNT_SESSION_CHANGED','This transfer belongs to a previous Telegram connection. Cancel it and select the original again.',409);
      if (transfer.stage_bytes !== transfer.expected_bytes) throw new DomainError('UPLOAD_INCOMPLETE', 'Upload all bytes before committing.', 409);
      if (!['CREATED', 'STAGING'].includes(transfer.state)) throw new DomainError('UPLOAD_CLOSED', 'This upload cannot be committed.', 409);
      const path = stagingPath(transfer.id,transfer.account_key);
      if (transfer.expected_bytes === 0) { const handle = await open(path, 'w', 0o600); await handle.close(); transition(transfer, 'STAGING'); }
      const actual = await stat(path);
      if (actual.size !== transfer.expected_bytes) throw new DomainError('STAGING_INCONSISTENT', 'Staged bytes need verification before continuing.', 409);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      transfer.sha256 = hash.digest('hex'); transition(transfer, 'STAGED'); transition(transfer, 'QUEUED');
      if(production){transfer.error_code=null;return {transfer,telegram_confirmed:false,message:'The original is staged and queued. Success requires a confirmed Telegram attachment.'};}
      transfer.error_code = 'ADAPTER_NOT_CONFIGURED';
      const now = new Date().toISOString();
      const file: FileRecord = { id: randomUUID(), user_id: currentUser(), folder_id: transfer.folder_id, name: transfer.name, original_name: transfer.name, mime: transfer.mime, bytes: transfer.expected_bytes, sha256: transfer.sha256, favorite: false, tags: [], created_at: now, updated_at: now, trashed_at: null, availability: 'local', version: 1, local_blob_id: transfer.id };
      transfer.file_id = file.id; state.files.push(file);
      return { transfer, file, telegram_confirmed: false, message: 'Original bytes are staged locally. A verified Telegram worker is required to upload them to Telegram.' };
    });
    response.status(202).json(result);
  }));
  server.get('/v1/transfers', wrap(async (_request, response) => response.json(await repository.read(state => ({ items: state.transfers.filter(item => item.user_id === currentUser()) })))));
  server.get('/v1/transfers/:id', wrap(async (request, response) => response.json(await repository.read(state => owned(state.transfers, currentUser(), paramsId(request))))));
  server.post('/v1/transfers/:id/cancel', wrap(async (request, response) => {
    const transfer = await repository.transaction(state => idempotent(request, state, `cancel:${paramsId(request)}`, () => {
      const transfer = owned(state.transfers, currentUser(), paramsId(request));
      if (transfer.state === 'CANCELLED') return transfer;
      const uncertain=production&&['SENDING','VERIFYING','RECONCILING','NEEDS_ATTENTION'].includes(transfer.state);
      transition(transfer, 'CANCEL_REQUESTED');
      if(uncertain){transfer.error_code='CANCEL_UNCERTAIN';return transfer;}
      transition(transfer, 'CANCELLED');
      if (transfer.file_id) { removeCatalogFile(state, currentUser(), transfer.file_id); transfer.file_id = null; }
      return transfer;
    }));
    if(transfer.state==='CANCELLED')await unlink(stagingPath(transfer.id,transfer.account_key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    response.json(transfer);
  }));
  server.post('/v1/transfers/:id/retry', wrap(async (request,response) => {
    if(!production){await repository.read(state => owned(state.transfers,currentUser(),paramsId(request)));throw new DomainError('ADAPTER_NOT_CONFIGURED','A verified Telegram worker is required before a transfer can retry.',503);}
    const result=await repository.transaction(state=>idempotent(request,state,`retry:${paramsId(request)}`,()=>{
      const transfer=owned(state.transfers,currentUser(),paramsId(request));
      if(transfer.account_key&&transfer.account_key!==scope().accountKey)throw new DomainError('ACCOUNT_SESSION_CHANGED','This transfer belongs to a previous Telegram connection. Cancel it before choosing the original again.',409);
      if(transfer.state==='NEEDS_ATTENTION'){transition(transfer,'RECONCILING');}
      else if(transfer.state==='FAILED'){
        if(!['SOURCE_UNAVAILABLE','AUTH_EXPIRED','PERMISSION_DENIED'].includes(transfer.error_code||''))throw new DomainError('UPLOAD_UNCERTAIN','This upload must be verified before another send.',409);
        transition(transfer,'RETRY_SCHEDULED');
      }else throw new DomainError('INVALID_TRANSITION','This transfer cannot be retried yet.',409);
      transfer.error_code=null;return transfer;
    }));response.json(result);
  }));
  server.get('/v1/events', wrap(async (_request,response) => {
    const context=scope();
    response.setHeader('Content-Type','text/event-stream');response.setHeader('Connection','keep-alive');response.setHeader('X-Accel-Buffering','no');response.flushHeaders();
    let closed=false,busy=false,sequence=0;
    let timer:ReturnType<typeof setInterval>|undefined;
    response.on('close',()=>{closed=true;if(timer)clearInterval(timer);});
    const send=async()=>{if(closed||busy)return;busy=true;try{
      if(production){
        const authenticated=context.sessionToken?await production.auth.authenticateSession(context.sessionToken):null;
        if(!authenticated||authenticated.user.id!==context.userId){closed=true;response.write('event: auth_expired\ndata: {}\n\n');response.end();if(timer)clearInterval(timer);return;}
      }
      const data=await context.repository.read(state=>({transfers:state.transfers.filter(item=>item.user_id===context.userId),catalog_updated_at:state.files.filter(file=>file.user_id===context.userId).reduce((latest,file)=>file.updated_at>latest?file.updated_at:latest,'')}));
      if(!closed)response.write(`id: ${++sequence}\nevent: status\ndata: ${JSON.stringify(data)}\n\n`);
    }catch{if(!closed)response.write('event: reconnect\ndata: {}\n\n');}finally{busy=false;}};
    await send();if(!closed){timer=setInterval(()=>{void send();},2000);timer.unref();}
  }));
  server.get(['/v1/files/:id/content','/v1/files/:id/preview'], wrap(async (request, response) => {
    const preview=request.path.endsWith('/preview');
    const file = await repository.read(state => owned(state.files, currentUser(), paramsId(request)));
    if(production){
      if(file.availability!=='confirmed'||!file.remote_reference||file.remote_reference.account_key!==scope().accountKey)throw new DomainError('SOURCE_UNAVAILABLE','Reconnect the original Telegram authorization to resolve this attachment.',409);
      const selected=await production.auth.listStorageChats(currentUser());
      if(!selected.some(chat=>chat.status==='available'&&chat.peerId===file.remote_reference!.peer_id))throw new DomainError('PERMISSION_DENIED','The source storage chat is unavailable.',403);
      try{parseRange(request.get('Range'),file.bytes);}catch(error){response.setHeader('Content-Range',`bytes */${file.bytes}`);throw error;}
      let safeMime:string|null=null;
      if(preview){
        const prefix=await production.worker.content(scope().accountKey!,providerReference(file.remote_reference),'bytes=0-511');
        const bytes=new Uint8Array(await prefix.arrayBuffer());safeMime=sniffPreview(bytes);
        if(!safeMime)throw new DomainError('UNSUPPORTED_PREVIEW','This format has no safe browser preview. Download the original to open it.',415);
      }
      const upstream=await production.worker.content(scope().accountKey!,providerReference(file.remote_reference),request.get('Range'));
      response.status(upstream.status);response.setHeader('Content-Type',safeMime||'application/octet-stream');response.setHeader('Content-Disposition',`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'",'%27')}`);
      for(const header of ['Content-Length','Content-Range','Accept-Ranges']){const value=upstream.headers.get(header);if(value)response.setHeader(header,value);}
      if(!upstream.body){response.end();return;}
      const stream=Readable.fromWeb(upstream.body as any);response.on('close',()=>stream.destroy());stream.on('error',()=>response.destroy());stream.pipe(response);return;
    }
    if (!file.local_blob_id || file.availability !== 'local') throw new DomainError('SOURCE_UNAVAILABLE', 'The original bytes are unavailable.', 404);
    const path = stagingPath(file.local_blob_id);
    const details = await stat(path).catch(() => { throw new DomainError('SOURCE_UNAVAILABLE', 'The staged original is unavailable.', 404); });
    let range;
    try { range = parseRange(request.get('Range'), details.size); }
    catch (error) { response.setHeader('Content-Range', `bytes */${details.size}`); throw error; }
    response.setHeader('Accept-Ranges', 'bytes');
    let safeMime:string|null=null;
    if(preview){
      const handle=await open(path,'r');
      try{const bytes=Buffer.alloc(512);const read=await handle.read(bytes,0,512,0);safeMime=sniffPreview(bytes.subarray(0,read.bytesRead));}finally{await handle.close();}
      if(!safeMime)throw new DomainError('UNSUPPORTED_PREVIEW','This format has no safe browser preview. Download the original to open it.',415);
    }
    response.setHeader('Content-Type',safeMime||'application/octet-stream');
    response.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.original_name).replaceAll("'", '%27')}`);
    response.setHeader('Content-Length', String(Math.max(0, range.end - range.start + 1)));
    if (range.partial) { response.status(206); response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${details.size}`); }
    if (details.size === 0) { response.end(); return; }
    const stream = createReadStream(path, { start: range.start, end: range.end });
    stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
  }));
  server.use((error: unknown, request: ErrorRequest, response: Response, _next: NextFunction) => {
    if (response.headersSent) { response.end(); return; }
    const known = error instanceof DomainError;
    const retry=error instanceof ProviderError?error.retryAfterSeconds:undefined;
    if(retry)response.setHeader('Retry-After',String(retry));
    const malformed = error instanceof SyntaxError;
    const tooLarge = Boolean(error && typeof error === 'object' && 'status' in error && error.status === 413);
    response.status(known ? error.status : tooLarge ? 413 : malformed ? 400 : 500).json({ error: { ...(retry?{retry_after_seconds:retry}:{}), code: known ? error.code : tooLarge ? 'PAYLOAD_TOO_LARGE' : malformed ? 'INVALID_JSON' : 'INTERNAL_ERROR', message: known ? error.message : tooLarge ? 'This request exceeds the permitted size.' : malformed ? 'The JSON request is invalid.' : 'This request could not be completed.' }, request_id: request.requestId });
  });
  await app.init();
  const close=app.close.bind(app);app.close=async()=>{await production?.close();await close();};
  return { app, server, repository:demo?localRepository:repository, production };
}
