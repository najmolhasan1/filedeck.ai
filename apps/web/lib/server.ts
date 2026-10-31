import { Catalog, DriveFile, Folder, kindFor, MAX_FILE_BYTES, Transfer } from './catalog';

type JsonObject = Record<string, unknown>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type AuthState = {
  state: 'phone_required' | 'code_required' | 'password_required' | 'connecting' | 'ready' | 'closed' | 'unavailable';
  delivery?: string; hint?: string; retryAfterSeconds?: number; transaction_id?: string;
};
export type ServerUser = {
  id: string; telegram_user_id?: string; name?: string; mode?: string; telegram_connected: boolean;
  csrf_token?: string; storage_selected?: boolean; capabilities?: {file_limit_bytes?: number; remote_deletion?: boolean; [key: string]: unknown};
};
export type Bootstrap = {authenticated: boolean; csrf_token: string; user?: ServerUser};
export type StorageChat = {id?: string; peer_id?: string; type: string; title?: string; status?: string; can_send?:boolean; can_delete?:boolean; selected?:boolean; [key: string]: unknown};
export type ServerFile = DriveFile & {version: number; availability: string; source: 'server'; remoteConfirmed: boolean};
export type ServerFolder = Folder & {version: number};
export type ServerTransfer = Transfer & {
  state: string; stageBytes: number; providerBytes: number; operationId?: string; retryAfterSeconds?: number;
  remoteConfirmed: boolean;
};
export type ServerCatalog = Catalog & {files: ServerFile[]; folders: ServerFolder[]; transfers: ServerTransfer[]};
export type UploadDescriptor = {
  id: string; uploadId?: string; operationKey: string; userId: string; name: string; bytes: number;
  mime: string; lastModified: number; folderId: string | null; fingerprint: string; chunkHashes: string[];
  chunkBytes: number; offset: number; createdAt: string;
};
export type UploadProgress = {
  phase: 'preparing' | 'staging' | 'queued'; bytes: number; expectedBytes: number;
  uploadId?: string; descriptorId: string; transfer?: ServerTransfer;
};
export class APIError extends Error {
  constructor(message: string, public code: string, public status = 0, public retryAfterSeconds?: number, public requestId?: string) {
    super(message); this.name = 'APIError';
  }
}

const DESCRIPTORS_KEY = 'cloudnest-server-uploads-v1';
const CHUNK_BYTES = 4 * 1024 * 1024;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const number = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const safeMessage = (value: unknown, fallback: string) => typeof value === 'string' && value.length < 500 && !/[<>]/.test(value) ? value : fallback;
const id = () => crypto.randomUUID();
const encoded = (value: string) => encodeURIComponent(value);
const activeStates = new Set(['CREATED','STAGING','STAGED','QUEUED','SENDING','VERIFYING','WAITING_PROVIDER','WAITING_NETWORK','RETRY_SCHEDULED','RECONCILING','CANCEL_REQUESTED']);

export function normalizeAuthState(value: unknown): AuthState {
  const raw = object(value); const state = string(raw.state);
  const aliases: Record<string, AuthState['state']> = {
    phone_required:'phone_required', waiting_phone:'phone_required', code_required:'code_required', waiting_code:'code_required',
    password_required:'password_required', waiting_password:'password_required', connecting:'connecting', ready:'ready', closed:'closed', unsupported:'unavailable', unavailable:'unavailable'
  };
  return {state:aliases[state] || 'unavailable', delivery:string(raw.delivery ?? raw.codeDelivery) || undefined, hint:string(raw.hint) || undefined,
    retryAfterSeconds:number(raw.retryAfterSeconds ?? raw.retry_after_seconds) || undefined, transaction_id:string(raw.transaction_id) || undefined};
}
export function normalizeFile(value: unknown): ServerFile {
  const raw = object(value); const name = string(raw.name ?? raw.display_name, 'Untitled'); const mime = string(raw.mime,'application/octet-stream');
  const availability = string(raw.availability,'unavailable');
  return {id:string(raw.id),name,originalName:string(raw.original_name,name),mime,bytes:number(raw.bytes),kind:kindFor(mime,name),
    folderId:typeof raw.folder_id === 'string' ? raw.folder_id : null, favorite:raw.favorite === true,
    createdAt:string(raw.created_at,new Date(0).toISOString()),trashedAt:typeof raw.trashed_at === 'string'?raw.trashed_at:null,
    sha256:typeof raw.sha256==='string'?raw.sha256:undefined,tags:Array.isArray(raw.tags)?raw.tags.filter((tag):tag is string=>typeof tag==='string'):[],
    version:number(raw.version,1),availability,source:'server',remoteConfirmed:availability==='confirmed' || availability==='available' || availability==='remote'};
}
export function normalizeFolder(value: unknown, index = 0): ServerFolder {
  const raw = object(value);
  return {id:string(raw.id),name:string(raw.name,'Untitled'),parentId:typeof raw.parent_id==='string'?raw.parent_id:null,
    color:['green','blue','peach','purple'][index%4],version:number(raw.version,1)};
}
export function normalizeTransfer(value: unknown): ServerTransfer {
  const raw = object(value); const state = string(raw.state,'NEEDS_ATTENTION');
  const confirmed = state==='COMPLETED' && raw.telegram_confirmed !== false;
  const status: Transfer['status'] = confirmed?'completed':state==='CANCELLED'?'cancelled':
    state==='QUEUED'||state==='RETRY_SCHEDULED'?'queued':state==='SENDING'?'sending':state==='VERIFYING'?'verifying':
    state==='RECONCILING'?'reconciling':state==='WAITING_PROVIDER'||state==='WAITING_NETWORK'||state==='CANCEL_REQUESTED'?'waiting':activeStates.has(state)?'saving':'failed';
  return {id:string(raw.id),name:string(raw.name,'File transfer'),bytes:number(raw.expected_bytes),status,state,
    createdAt:string(raw.created_at,new Date(0).toISOString()),error:typeof raw.error_message==='string'?safeMessage(raw.error_message,'This transfer needs attention.'):typeof raw.error_code==='string'?raw.error_code:undefined,
    stageBytes:number(raw.stage_bytes),providerBytes:number(raw.provider_bytes),operationId:string(raw.operation_id)||undefined,
    retryAfterSeconds:number(raw.retry_after_seconds ?? raw.retryAfterSeconds)||(typeof raw.retry_after==='string'?Math.max(0,Math.ceil((Date.parse(raw.retry_after)-Date.now())/1000))||undefined:undefined),remoteConfirmed:confirmed,source:'server'};
}

export class ServerGateway {
  private fetcher: Fetcher;
  private csrfToken?: string;
  private sessionGeneration=0;
  private userId?: string;
  private storage: StorageLike | null;
  private descriptors = new Map<string,UploadDescriptor>();
  private bootstrapPending?: Promise<Bootstrap>;
  constructor(options: {fetcher?: Fetcher; storage?: StorageLike | null} = {}) {
    this.fetcher=options.fetcher || ((input,init)=>fetch(input,init));
    try {this.storage=options.storage===undefined?(typeof window!=='undefined'?window.localStorage:null):options.storage;} catch {this.storage=null;}
  }
  private async request<T>(path: string, options: {method?: string; body?: unknown; headers?: HeadersInit; signal?: AbortSignal; key?: string; raw?: boolean} = {}): Promise<T> {
    const generation=this.sessionGeneration;
    const method=options.method || 'GET'; const mutating=!['GET','HEAD','OPTIONS'].includes(method);
    if(mutating&&!this.csrfToken) await this.bootstrap();
    if(mutating&&!this.csrfToken) throw new APIError('The secure session could not be initialized. Refresh and try again.','CSRF_UNAVAILABLE',503);
    const headers=new Headers(options.headers);
    if(mutating) {headers.set('X-CSRF-Token',this.csrfToken!);headers.set('Idempotency-Key',options.key || id());}
    let body: BodyInit | undefined;
    if(options.body!==undefined) {
      if(options.raw) body=options.body as BodyInit;
      else {headers.set('Content-Type','application/json');body=JSON.stringify(options.body);}
    }
    let response: Response;
    try {response=await this.fetcher(`/v1${path}`,{method,headers,body,signal:options.signal,credentials:'same-origin',cache:'no-store'});}
    catch(error) {
      if(options.signal?.aborted)throw new APIError('The upload is paused. Resume it or cancel the server transfer.','UPLOAD_PAUSED');
      throw new APIError('The service could not be reached. Your files have not been marked as backed up.','NETWORK_ERROR');
    }
    if(generation!==this.sessionGeneration)throw new APIError('The session changed. Refresh your drive.','SESSION_CHANGED',409);
    if(!response.ok) {
      if(response.status===401) {this.csrfToken=undefined;this.userId=undefined;}
      const data=object(await response.json().catch(()=>null)); const error=object(data.error);
      const retry=number(error.retry_after_seconds) || Number(response.headers.get('Retry-After')) || undefined;
      throw new APIError(safeMessage(error.message, response.status===401?'Your session has expired. Connect Telegram again.':'This request could not be completed.'),string(error.code,response.status===401?'AUTH_EXPIRED':'REQUEST_FAILED'),response.status,retry,string(data.request_id)||undefined);
    }
    if(options.raw)return response as T;
    if(response.status===204)return undefined as T;
    const data=await response.json().catch(()=>{throw new APIError('The service returned an invalid response.','INVALID_RESPONSE',502);});
    const token=object(data).csrf_token;if(typeof token==='string')this.csrfToken=token;
    return data as T;
  }
  resetSession():void {this.sessionGeneration++;this.csrfToken=undefined;this.userId=undefined;this.bootstrapPending=undefined;}
  bootstrap(): Promise<Bootstrap> {
    if(!this.bootstrapPending) this.bootstrapPending=this.request<Bootstrap>('/auth/bootstrap').then(data=>{
      if(typeof data.csrf_token!=='string')throw new APIError('The secure session could not be initialized.','CSRF_UNAVAILABLE',503);
      this.csrfToken=data.csrf_token;this.userId=data.authenticated?data.user?.id:undefined;return data;
    }).finally(()=>{this.bootstrapPending=undefined;});
    return this.bootstrapPending;
  }
  async me(): Promise<ServerUser> {const user=await this.request<ServerUser>('/me');this.userId=user.id;if(user.csrf_token)this.csrfToken=user.csrf_token;return user;}
  async authStart(phone: string, disclosureAccepted: boolean): Promise<AuthState> {return normalizeAuthState(await this.request('/auth/telegram/start',{method:'POST',body:{phone,disclosureAccepted}}));}
  async authStep(type:'code'|'password', value:string): Promise<AuthState> {return normalizeAuthState(await this.request('/auth/telegram/step',{method:'POST',body:{step:{type,value}}}));}
  async authState(): Promise<AuthState> {return normalizeAuthState(await this.request('/auth/telegram/state'));}
  async logout(): Promise<unknown> {const result=await this.request('/auth/logout',{method:'POST',body:{}});this.resetSession();return result;}
  async disconnect(): Promise<unknown> {return this.request('/me/telegram-session',{method:'DELETE',body:{}});}
  async storageChats(): Promise<{items:StorageChat[];connected?:boolean}> {return this.request('/storage-chats');}
  async selectStorage(peerId?:string): Promise<StorageChat> {return this.request('/storage-chats',{method:'POST',body:peerId?{peer_id:peerId}:{type:'saved_messages'}});}
  async beginSync(): Promise<JsonObject> {return this.request('/sync-jobs',{method:'POST',body:{}});}
  async getSync(syncId:string): Promise<JsonObject> {return this.request(`/sync-jobs/${encoded(syncId)}`);}
  private async allFiles(trash:boolean): Promise<ServerFile[]> {
    const files:ServerFile[]=[];let cursor:string|undefined;const seen=new Set<string>();
    do {
      const query=new URLSearchParams({limit:'100',trash:String(trash)});if(cursor)query.set('cursor',cursor);
      const page=await this.request<{items:unknown[];next_cursor?:string|null}>(`/files?${query}`);
      if(!Array.isArray(page.items))throw new APIError('The catalog response was invalid.','INVALID_RESPONSE',502);
      files.push(...page.items.map(normalizeFile));cursor=page.next_cursor || undefined;
      if(cursor&&seen.has(cursor))throw new APIError('The catalog cursor did not advance. Refresh and try again.','INVALID_RESPONSE',502);
      if(cursor)seen.add(cursor);
    }while(cursor);
    return files;
  }
  async loadCatalog(): Promise<ServerCatalog> {
    const [active,trashed,folders,transfers]=await Promise.all([this.allFiles(false),this.allFiles(true),this.request<{items:unknown[]}>('/folders'),this.request<{items:unknown[]}>('/transfers')]);
    if(!Array.isArray(folders.items)||!Array.isArray(transfers.items))throw new APIError('The catalog response was invalid.','INVALID_RESPONSE',502);
    return {schemaVersion:1,files:[...new Map([...active,...trashed].map(file=>[file.id,file])).values()],folders:folders.items.map(normalizeFolder),transfers:transfers.items.map(normalizeTransfer)};
  }
  async patchFile(file: DriveFile & {version?:number}, patch:{name?:string;folderId?:string|null;favorite?:boolean;tags?:string[]}): Promise<ServerFile> {
    const body:JsonObject={};if(patch.name!==undefined)body.name=patch.name;if(patch.folderId!==undefined)body.folder_id=patch.folderId;if(patch.favorite!==undefined)body.favorite=patch.favorite;if(patch.tags!==undefined)body.tags=patch.tags;
    return normalizeFile(await this.request(`/files/${encoded(file.id)}`,{method:'PATCH',body,headers:{'If-Match':String(file.version || 1)}}));
  }
  async createFolder(name:string,parentId:string|null): Promise<ServerFolder> {return normalizeFolder(await this.request('/folders',{method:'POST',body:{name,parent_id:parentId}}));}
  async patchFolder(folder: Folder & {version?:number},patch:{name?:string;parentId?:string|null}): Promise<ServerFolder> {
    const body:JsonObject={};if(patch.name!==undefined)body.name=patch.name;if(patch.parentId!==undefined)body.parent_id=patch.parentId;
    return normalizeFolder(await this.request(`/folders/${encoded(folder.id)}`,{method:'PATCH',body,headers:{'If-Match':String(folder.version || 1)}}));
  }
  async deleteFolder(folder:Folder & {version?:number},contents:'root'|'trash'): Promise<unknown> {return this.request(`/folders/${encoded(folder.id)}`,{method:'DELETE',body:{contents},headers:{'If-Match':String(folder.version || 1)}});}
  async trash(fileId:string): Promise<ServerFile> {return normalizeFile(await this.request(`/files/${encoded(fileId)}/trash`,{method:'POST',body:{}}));}
  async restore(fileId:string): Promise<ServerFile> {return normalizeFile(await this.request(`/files/${encoded(fileId)}/restore`,{method:'POST',body:{}}));}
  async remove(fileId:string): Promise<unknown> {return this.request(`/files/${encoded(fileId)}/catalog`,{method:'DELETE',body:{}});}
  contentUrl(fileId:string): string {return `/v1/files/${encoded(fileId)}/content`;}
  previewUrl(fileId:string): string {return `/v1/files/${encoded(fileId)}/preview`;}
  async original(fileId:string,range?:string): Promise<Response> {return this.request(`/files/${encoded(fileId)}/content`,{raw:true,headers:range?{Range:range}:undefined});}
  async exportCatalog(): Promise<Blob> {const response=await this.request<Response>('/exports/catalog',{raw:true});return response.blob();}
  async retryTransfer(transferId:string): Promise<ServerTransfer> {return normalizeTransfer(await this.request(`/transfers/${encoded(transferId)}/retry`,{method:'POST',body:{}}));}
  async cancelTransfer(transferId:string): Promise<ServerTransfer> {
    const result=normalizeTransfer(await this.request(`/transfers/${encoded(transferId)}/cancel`,{method:'POST',body:{}}));
    if(result.state==='CANCELLED')for(const item of this.pendingUploads())if(item.uploadId===transferId)this.discardUpload(item.id);
    return result;
  }
  pendingUploads(): UploadDescriptor[] {
    let saved:unknown;try{saved=JSON.parse(this.storage?.getItem(DESCRIPTORS_KEY)||'[]');}catch{saved=[];}
    if(Array.isArray(saved))for(const item of saved) {
      const raw=object(item);
      if(typeof raw.id==='string'&&typeof raw.userId==='string'&&typeof raw.operationKey==='string'&&raw.operationKey.length<=64&&
        typeof raw.name==='string'&&typeof raw.mime==='string'&&Number.isSafeInteger(raw.bytes)&&number(raw.bytes)>=0&&number(raw.bytes)<=MAX_FILE_BYTES&&
        typeof raw.lastModified==='number'&&typeof raw.createdAt==='string'&&(raw.folderId===null||typeof raw.folderId==='string')&&
        raw.chunkBytes===CHUNK_BYTES&&Number.isSafeInteger(raw.offset)&&number(raw.offset)>=0&&number(raw.offset)<=number(raw.bytes)&&
        typeof raw.fingerprint==='string'&&/^[0-9a-f]{64}$/.test(raw.fingerprint)&&Array.isArray(raw.chunkHashes)&&
        raw.chunkHashes.length===Math.ceil(number(raw.bytes)/CHUNK_BYTES)&&raw.chunkHashes.every(hash=>typeof hash==='string'&&/^[0-9a-f]{64}$/.test(hash)))this.descriptors.set(raw.id,item as UploadDescriptor);
    }
    return [...this.descriptors.values()].filter(item=>item.userId===this.userId);
  }
  private saveUpload(item:UploadDescriptor): void {
    this.descriptors.set(item.id,item);this.persistUploads();
  }
  private persistUploads(): void {try{this.storage?.setItem(DESCRIPTORS_KEY,JSON.stringify([...this.descriptors.values()]));}catch{/* Resume remains available in this open tab if browser storage is full. */}}
  discardUpload(descriptorId:string): void {this.descriptors.delete(descriptorId);this.persistUploads();}
  private async fingerprint(file:Blob,signal?:AbortSignal,onProgress?:(bytes:number)=>void): Promise<{fingerprint:string;chunkHashes:string[]}> {
    if(!crypto.subtle)throw new APIError('Use a secure HTTPS connection before uploading originals.','SECURE_CONTEXT_REQUIRED');
    const hashes:string[]=[];
    for(let offset=0;offset<file.size;offset+=CHUNK_BYTES) {
      if(signal?.aborted)throw new APIError('The upload is paused.','UPLOAD_PAUSED');
      const buffer=await file.slice(offset,Math.min(offset+CHUNK_BYTES,file.size)).arrayBuffer();
      const hash=await crypto.subtle.digest('SHA-256',buffer);
      hashes.push(Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join(''));onProgress?.(Math.min(offset+CHUNK_BYTES,file.size));
    }
    const manifest=new TextEncoder().encode(`${file.size}:${CHUNK_BYTES}:${hashes.join(':')}`);
    const digest=await crypto.subtle.digest('SHA-256',manifest);
    return {fingerprint:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join(''),chunkHashes:hashes};
  }
  async upload(file:File, options:{folderId?:string|null;resumeId?:string;signal?:AbortSignal;onProgress?:(value:UploadProgress)=>void} = {}): Promise<{transfer:ServerTransfer;file?:ServerFile}> {
    if(file.size>MAX_FILE_BYTES)throw new APIError('The product limit is 500 MiB per file.','FILE_TOO_LARGE',413);
    if(!this.userId)await this.me();
    const existing=options.resumeId?this.pendingUploads().find(item=>item.id===options.resumeId||item.uploadId===options.resumeId):undefined;
    if(options.resumeId&&!existing)throw new APIError('This upload cannot be resumed in this browser. Start a new upload.','RESUME_NOT_FOUND',404);
    const descriptorId=existing?.id || id();
    const hashes=await this.fingerprint(file,options.signal,bytes=>options.onProgress?.({phase:'preparing',bytes,expectedBytes:file.size,descriptorId,uploadId:existing?.uploadId}));
    if(existing&&(existing.bytes!==file.size||existing.fingerprint!==hashes.fingerprint))throw new APIError('The selected file does not match the original bytes. Choose the original file to resume.','SOURCE_CHANGED',409);
    const descriptor:UploadDescriptor=existing || {id:descriptorId,userId:this.userId!,operationKey:id(),name:file.name,bytes:file.size,mime:file.type||'application/octet-stream',lastModified:file.lastModified,folderId:options.folderId||null,...hashes,chunkBytes:CHUNK_BYTES,offset:0,createdAt:new Date().toISOString()};
    this.saveUpload(descriptor);
    if(!descriptor.uploadId) {
      const created=object(await this.request('/uploads',{method:'POST',body:{name:descriptor.name,bytes:descriptor.bytes,mime:descriptor.mime,folder_id:descriptor.folderId},key:`${descriptor.operationKey}:create`,signal:options.signal}));
      descriptor.uploadId=string(created.id);if(!descriptor.uploadId)throw new APIError('The upload could not be initialized.','INVALID_RESPONSE',502);this.saveUpload(descriptor);
    }
    const uploadId=descriptor.uploadId;
    const status=await this.request<Response>(`/uploads/${encoded(uploadId)}`,{method:'HEAD',raw:true,signal:options.signal});
    const offsetHeader=status.headers.get('Upload-Offset');const lengthHeader=status.headers.get('Upload-Length');
    const offset=Number(offsetHeader);const length=Number(lengthHeader);
    if(offsetHeader===null||lengthHeader===null||!Number.isSafeInteger(offset)||offset<0||offset>file.size||length!==file.size||(offset!==file.size&&offset%CHUNK_BYTES!==0))throw new APIError('The stored upload offset needs verification before continuing.','INVALID_UPLOAD_OFFSET',409);
    descriptor.offset=offset;this.saveUpload(descriptor);
    options.onProgress?.({phase:'staging',bytes:offset,expectedBytes:file.size,uploadId,descriptorId});
    for(let current=offset;current<file.size;) {
      if(options.signal?.aborted)throw new APIError('The upload is paused. Resume it or cancel the server transfer.','UPLOAD_PAUSED');
      const next=Math.min(current+CHUNK_BYTES,file.size);const chunk=file.slice(current,next);
      const hex=descriptor.chunkHashes[Math.floor(current/CHUNK_BYTES)];
      const checksum=btoa(String.fromCharCode(...new Uint8Array(hex.match(/../g)!.map(part=>parseInt(part,16)))));
      const response=await this.request<Response>(`/uploads/${encoded(uploadId)}`,{method:'PATCH',raw:true,body:chunk,
        headers:{'Content-Type':'application/offset+octet-stream','Upload-Offset':String(current),'Upload-Checksum':`sha256 ${checksum}`},key:`${descriptor.operationKey}:chunk:${current}`,signal:options.signal});
      const actual=Number(response.headers.get('Upload-Offset'));
      if(actual!==next)throw new APIError('The server did not confirm the expected upload offset. Resume to verify it.','OFFSET_MISMATCH',409);
      current=next;descriptor.offset=current;this.saveUpload(descriptor);options.onProgress?.({phase:'staging',bytes:current,expectedBytes:file.size,uploadId,descriptorId});
    }
    const committed=object(await this.request(`/uploads/${encoded(uploadId)}/commit`,{method:'POST',body:{},key:`${descriptor.operationKey}:commit`,signal:options.signal}));
    const transfer=normalizeTransfer(committed.transfer || committed);
    if(!transfer.id)throw new APIError('The upload result needs verification. Open Transfers before trying again.','UPLOAD_UNCERTAIN',409);
    options.onProgress?.({phase:'queued',bytes:file.size,expectedBytes:file.size,uploadId,descriptorId,transfer});
    // Staged bytes are durable on the server. Provider dispatch owns subsequent retries.
    this.discardUpload(descriptor.id);
    return {transfer,file:committed.file?normalizeFile(committed.file):undefined};
  }
}
