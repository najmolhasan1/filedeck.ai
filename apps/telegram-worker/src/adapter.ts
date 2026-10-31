import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { AdapterError, type AccountKey, type AllowedChat, type AttachmentRef, type AuthorizationState, type AuthorizationStep, type RemoteAttachment, type SendResult, type TelegramAdapter } from '@cloudnest/contracts';

/** Small transport seam: tests do not load native code or open Telegram sessions. */
export interface TdTransport {
  invoke(input: Record<string, unknown>): Promise<any>;
  on(event: 'update', listener: (update: any) => void): unknown;
  close(): Promise<unknown>;
}
export interface WorkerConfig {
  apiId: number;
  apiHash: string;
  databaseKey: string;
  stateDirectory: string;
  useTestDc: boolean;
}
export function configFromEnv(env: NodeJS.ProcessEnv): WorkerConfig {
  if (env.CLOUDNEST_SPIKE_ENABLE !== 'true') throw new AdapterError('SPIKE_DISABLED', 'Set CLOUDNEST_SPIKE_ENABLE=true only for an isolated developer-account feasibility test.');
  return providerConfigFromEnv(env);
}
export function providerConfigFromEnv(env: NodeJS.ProcessEnv): WorkerConfig {
  const apiId = Number(env.TELEGRAM_API_ID);
  if (!Number.isInteger(apiId) || apiId <= 0 || !env.TELEGRAM_API_HASH || !env.TDLIB_DATABASE_KEY || !env.TDLIB_STATE_DIR) {
    throw new AdapterError('ADAPTER_NOT_CONFIGURED', 'Telegram developer credentials, a database key and an encrypted state directory are required.');
  }
  if (!env.TDLIB_STATE_DIR.startsWith('/')) throw new AdapterError('INVALID_CONFIGURATION', 'TDLIB_STATE_DIR must be an absolute encrypted-volume path.');
  return {apiId, apiHash: env.TELEGRAM_API_HASH, databaseKey: env.TDLIB_DATABASE_KEY, stateDirectory: resolve(env.TDLIB_STATE_DIR), useTestDc: env.TDLIB_USE_TEST_DC === 'true'};
}
export function remoteId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  throw new AdapterError('INVALID_REMOTE_ID', 'Provider returned an invalid or imprecise identifier.');
}
function tdNumber(value: string): number {
  const n = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n)) throw new AdapterError('INVALID_REMOTE_ID', 'Identifier cannot be represented safely by this TDLib binding.');
  return n;
}
export function mapAuthorization(value: any): AuthorizationState {
  switch (value?._) {
    case 'authorizationStateWaitPhoneNumber': return {state:'phone_required'};
    case 'authorizationStateWaitCode': return {state:'code_required', delivery: String(value.code_info?.type?._ ?? 'Telegram')};
    case 'authorizationStateWaitPassword': return {state:'password_required', hint: value.password_hint || undefined};
    case 'authorizationStateLoggingOut': return {state:'logging_out'};
    case 'authorizationStateClosed': return {state:'closed'};
    case 'authorizationStateWaitTdlibParameters':
    case 'authorizationStateWaitEncryptionKey':
    case 'authorizationStateClosing': return {state:'connecting'};
    default: return {state:'unsupported',providerState:String(value?._ ?? 'unknown')};
  }
}
function safeProviderError(error: unknown): AdapterError {
  const e = error as {code?: number; message?: string};
  const wait = /FLOOD_WAIT_(\d+)|retry after (\d+)/i.exec(e.message ?? '');
  if (wait) return new AdapterError('PROVIDER_WAIT','Telegram asked this account to wait.',Number(wait[1] ?? wait[2]));
  if (e.code === 404) return new AdapterError('REMOTE_FILE_MISSING','The requested Telegram message is unavailable.');
  if (e.code === 401) return new AdapterError('AUTH_EXPIRED','Telegram authorization has expired.');
  if (/PHONE_CODE_INVALID/.test(e.message ?? '')) return new AdapterError('INVALID_CODE','The verification code is incorrect.');
  if (/PHONE_CODE_EXPIRED/.test(e.message ?? '')) return new AdapterError('CODE_EXPIRED','The verification code has expired.');
  if (/PASSWORD_HASH_INVALID/.test(e.message ?? '')) return new AdapterError('INVALID_PASSWORD','The two-step verification password is incorrect.');
  return new AdapterError('PROVIDER_ERROR','Telegram could not complete this request. Check account state before retrying.');
}
interface JournalEntry { operationId: string; digest: string; state: 'pending'|'unknown'|'confirmed'; peerId: string; temporaryId?: string; reference?: AttachmentRef; bytes: number; originalName?: string; preparedSource?: boolean; }
export class TdlibAdapter implements TelegramAdapter {
  private selected = new Map<string, AllowedChat>();
  private journal = new Map<string, JournalEntry>();
  private identity?: string;
  private expectedIdentity?: string;
  private pendingUpdates = new Map<string, any>();
  private current?: any;
  private revocationRequested=false;
  private revocationAccepted=false;
  private revocationConfirmed=false;
  private writing: Promise<void> = Promise.resolve();
  private constructor(private readonly accountKey: string, private readonly transport: TdTransport, private readonly directory: string) {
    transport.on('update',(update) => { void this.handleUpdate(update).catch(() => { /* No provider payloads in logs. Next lookup remains uncertain. */ }); });
  }
  static async open(accountKey: string, transport: TdTransport, directory: string): Promise<TdlibAdapter> {
    const adapter = new TdlibAdapter(accountKey,transport,directory);
    await mkdir(directory,{recursive:true,mode:0o700});
    try {
      const stored=JSON.parse(await readFile(join(directory,'operations.json'),'utf8'));
      if(stored.accountKey!==accountKey) throw new AdapterError('ACCOUNT_MISMATCH','State directory belongs to another account.');
      adapter.expectedIdentity = stored.telegramUserId;
      adapter.revocationRequested=stored.revocationRequested===true;
      adapter.revocationAccepted=stored.revocationAccepted===true;
      adapter.revocationConfirmed=stored.revocationConfirmed===true;
      for(const entry of stored.operations as JournalEntry[]) adapter.journal.set(entry.operationId,entry);
      for(const chat of stored.selectedChats ?? []) adapter.selected.set(chat.peerId,chat);
      for(const entry of adapter.journal.values())if(entry.state==='confirmed')await adapter.cleanupPrepared(entry);
    } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return adapter;
  }
  private check(accountKey: string) { if(accountKey !== this.accountKey) throw new AdapterError('PERMISSION_DENIED','Account does not own this adapter.'); }
  private async call(input: Record<string,unknown>): Promise<any> { try { return await this.transport.invoke(input); } catch(error) { throw safeProviderError(error); } }
  private persist(): Promise<void> {
    this.writing=this.writing.then(async()=>{
      const temp=join(this.directory,`operations.${randomUUID()}.tmp`);
      const handle=await open(temp,'wx',0o600);
      try {await handle.writeFile(JSON.stringify({accountKey:this.accountKey,revocationRequested:this.revocationRequested,revocationAccepted:this.revocationAccepted,revocationConfirmed:this.revocationConfirmed,telegramUserId:this.identity??this.expectedIdentity,selectedChats:[...this.selected.values()],operations:[...this.journal.values()]}));await handle.sync();}finally{await handle.close();}
      await rename(temp,join(this.directory,'operations.json'));
      const parent=await open(this.directory,'r');try{await parent.sync();}finally{await parent.close();}
    });
    return this.writing;
  }
  private async me(): Promise<string> {
    if(!this.identity) {
      const identity=remoteId((await this.call({_: 'getMe'})).id);
      if(this.expectedIdentity&&identity!==this.expectedIdentity)throw new AdapterError('ACCOUNT_MISMATCH','This state directory is bound to another Telegram account. Use a new isolated account directory.');
      this.identity=identity;await this.persist();
    }
    return this.identity;
  }
  private async allowed(peerId: string) { if(this.revocationRequested)throw new AdapterError('AUTH_EXPIRED','This Telegram session is being revoked.');await this.me();const selected=this.selected.get(peerId); if(!selected?.canSend) throw new AdapterError('PERMISSION_DENIED','Select and validate a writable storage destination first.'); return selected; }
  async startAuthorization(accountKey: AccountKey,input:{phoneNumber:string}):Promise<AuthorizationState> {
    this.check(accountKey);
    const state=await this.getAuthorizationState(accountKey);
    if(state.state!=='phone_required') return state;
    if(!/^\+[1-9]\d{6,14}$/.test(input.phoneNumber)) throw new AdapterError('INVALID_PHONE','Enter an international phone number including country code.');
    await this.call({_: 'setAuthenticationPhoneNumber',phone_number:input.phoneNumber,settings:{_: 'phoneNumberAuthenticationSettings',allow_flash_call:false,allow_missed_call:false,is_current_phone_number:false,allow_sms_retriever_api:false}});
    return this.getAuthorizationState(accountKey);
  }
  async submitAuthorizationStep(accountKey: AccountKey,input:AuthorizationStep):Promise<AuthorizationState> {
    this.check(accountKey);
    const state=await this.getAuthorizationState(accountKey);
    if(input.type==='code' && state.state==='code_required') await this.call({_: 'checkAuthenticationCode',code:input.value});
    else if(input.type==='password' && state.state==='password_required') await this.call({_: 'checkAuthenticationPassword',password:input.value});
    else throw new AdapterError('INVALID_AUTH_STEP','Telegram did not request this authorization step.');
    return this.getAuthorizationState(accountKey);
  }
  async getAuthorizationState(accountKey:AccountKey):Promise<AuthorizationState> {
    this.check(accountKey); if(this.current?._==='authorizationStateClosed')return {state:'closed'};
    this.current=await this.call({_: 'getAuthorizationState'});
    if(this.current._==='authorizationStateReady') return {state:'ready',telegramUserId:await this.me()};
    return mapAuthorization(this.current);
  }
  async getAccountCapabilities(accountKey:AccountKey) {
    this.check(accountKey); await this.me();const user=await this.call({_: 'getMe'});
    return {productMaxBytes:500*1024*1024,providerLimitVerified:false,premium:!!user.is_premium};
  }
  async listAllowedChats(accountKey:AccountKey):Promise<AllowedChat[]> {
    this.check(accountKey); const id=await this.me();
    const chat=await this.call({_: 'createPrivateChat',user_id:tdNumber(id),force:true});
    return [{peerId:remoteId(chat.id),title:'Saved Messages',kind:'saved_messages',canSend:true,canDelete:true}];
  }
  async selectStorageChat(accountKey:AccountKey,peerId:string):Promise<AllowedChat> {
    this.check(accountKey); const candidate=(await this.listAllowedChats(accountKey)).find(chat=>chat.peerId===peerId);
    if(!candidate) throw new AdapterError('PERMISSION_DENIED','This feasibility adapter supports only the authenticated account’s Saved Messages.');
    this.selected.set(peerId,candidate);await this.persist();return candidate;
  }
  private async attachment(message:any):Promise<RemoteAttachment|undefined> {
    if(message?.content?._!=='messageDocument'||message.sending_state) return undefined;
    const doc=message.content.document;
    return {reference:{telegramUserId:await this.me(),peerId:remoteId(message.chat_id),messageId:remoteId(message.id),attachmentIndex:0},originalName:doc.file_name,mime:doc.mime_type||'application/octet-stream',bytes:doc.document.size,createdAt:new Date(message.date*1000).toISOString()};
  }
  async listAttachments(accountKey:AccountKey,peerId:string,cursor?:string) {
    this.check(accountKey);await this.allowed(peerId);
    const page=await this.call({_: 'getChatHistory',chat_id:tdNumber(peerId),from_message_id:cursor?tdNumber(cursor):0,offset:0,limit:100,only_local:false});
    const messages=(page.messages as any[]).filter(m=>remoteId(m.id)!==cursor);
    const items=(await Promise.all(messages.map(m=>this.attachment(m)))).filter((x):x is RemoteAttachment=>!!x);
    return {items,cursor:messages.length?remoteId(messages[messages.length-1].id):undefined};
  }
  async sendOriginalFile(accountKey:AccountKey,input:{path:string;peerId:string;operationId:string;originalName?:string}):Promise<SendResult> {
    this.check(accountKey);await this.allowed(input.peerId);
    if(!/^[a-zA-Z0-9_-]{8,100}$/.test(input.operationId)) throw new AdapterError('INVALID_OPERATION','Use a stable opaque operation ID.');
    const active=[...this.journal.values()].find(entry=>entry.state==='pending'&&entry.operationId!==input.operationId);
    if(active)throw new AdapterError('ACCOUNT_BUSY','Another Telegram transfer is still pending for this account.',3);
    const originalName=input.originalName??basename(input.path);
    if(!originalName||originalName.length>255||originalName==='.'||originalName==='..'||/[\\/\x00-\x1f\x7f]/.test(originalName))throw new AdapterError('INVALID_FILENAME','The original filename is invalid.');
    const info=await stat(input.path);if(!info.isFile()||info.size>500*1024*1024) throw new AdapterError('FILE_TOO_LARGE','The product file cap is 500 MiB.');
    const hash=createHash('sha256');for await(const chunk of createReadStream(input.path)) hash.update(chunk);
    const digest=hash.digest('hex');const existing=this.journal.get(input.operationId);
    if(existing) {
      if(existing.digest!==digest||existing.peerId!==input.peerId||(existing.originalName&&existing.originalName!==originalName)) throw new AdapterError('IDEMPOTENCY_CONFLICT','Operation ID was already used for another file or destination.');
      return this.lookupSendResult(accountKey,input.operationId);
    }
    const entry:JournalEntry={operationId:input.operationId,digest,state:'unknown',peerId:input.peerId,bytes:info.size,originalName};
    let sendPath=resolve(input.path);
    if(basename(sendPath)!==originalName){
      const prepared=join(this.directory,'send-sources',input.operationId);await rm(prepared,{recursive:true,force:true});await mkdir(prepared,{recursive:true,mode:0o700});sendPath=join(prepared,originalName);
      try{await link(resolve(input.path),sendPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='EXDEV')throw error;await copyFile(resolve(input.path),sendPath);}
      entry.preparedSource=true;
    }
    this.journal.set(input.operationId,entry);await this.persist();
    try {
      const message=await this.call({_: 'sendMessage',chat_id:tdNumber(input.peerId),input_message_content:{_: 'inputMessageDocument',document:{_: 'inputFileLocal',path:sendPath},disable_content_type_detection:true,caption:{_: 'formattedText',text:'',entities:[]}}});
      // A temporary local message is not a confirmed remote attachment.
      entry.temporaryId=remoteId(message.id);
      if(!message.sending_state) { const attachment=await this.attachment(message);if(attachment){entry.state='confirmed';entry.reference=attachment.reference;} }
      else entry.state='pending';
      await this.persist();
      if(entry.state==='confirmed')await this.cleanupPrepared(entry);
      const update=this.pendingUpdates.get(`${input.peerId}:${entry.temporaryId}`);
      if(update){this.pendingUpdates.delete(`${input.peerId}:${entry.temporaryId}`);await this.handleUpdate(update);}
    } catch(error) { entry.state='unknown';await this.persist(); if(error instanceof AdapterError && error.code==='PROVIDER_WAIT') throw error; }
    return this.lookupSendResult(accountKey,input.operationId);
  }
  private async handleUpdate(update:any) {
    if(update._==='updateAuthorizationState'){
      this.current=update.authorization_state;
      if(this.current?._==='authorizationStateClosed'&&this.revocationAccepted){this.revocationConfirmed=true;await this.persist();}
    }
    if(update._!=='updateMessageSendSucceeded'&&update._!=='updateMessageSendFailed')return;
    const oldId=remoteId(update.old_message_id);
    const entry=[...this.journal.values()].find(e=>e.temporaryId===oldId&&e.peerId===remoteId(update.message.chat_id));
    if(!entry){
      const key=`${remoteId(update.message.chat_id)}:${oldId}`;
      if(this.pendingUpdates.size>=1000)this.pendingUpdates.delete(this.pendingUpdates.keys().next().value!);
      this.pendingUpdates.set(key,update);return;
    }
    if(update._==='updateMessageSendSucceeded') { const attachment=await this.attachment(update.message);if(attachment){entry.state='confirmed';entry.reference=attachment.reference;} }
    else entry.state='unknown';
    await this.persist();
    if(entry.state==='confirmed')await this.cleanupPrepared(entry);
  }
  private async cleanupPrepared(entry:JournalEntry){
    if(entry.preparedSource)try{await rm(join(this.directory,'send-sources',entry.operationId),{recursive:true,force:true});}catch{/* Cleanup failure never reverses a confirmed provider result. The next lookup/open can retry. */}
  }
  async lookupSendResult(accountKey:AccountKey,operationId:string):Promise<SendResult> {
    this.check(accountKey);await this.me();const entry=this.journal.get(operationId);
    // Query only the known pending message. Never scan unrelated chats or issue another send.
    if(entry&&entry.state!=='confirmed'&&entry.temporaryId) {
      try {
        const message=await this.call({_: 'getMessage',chat_id:tdNumber(entry.peerId),message_id:tdNumber(entry.temporaryId)});
        if(!message.sending_state) {
          const attachment=await this.attachment(message);
          if(attachment&&attachment.bytes===entry.bytes&&attachment.reference.peerId===entry.peerId){entry.state='confirmed';entry.reference=attachment.reference;await this.persist();await this.cleanupPrepared(entry);}
        } else if(message.sending_state._==='messageSendingStateFailed') {entry.state='unknown';await this.persist();}
      } catch(error) {
        if(error instanceof AdapterError&&(error.code==='PROVIDER_WAIT'||error.code==='AUTH_EXPIRED'))throw error;
        if(error instanceof AdapterError&&error.code==='REMOTE_FILE_MISSING'){entry.state='unknown';await this.persist();}
      }
    }
    if(entry?.state==='confirmed'&&entry.reference)return {state:'confirmed',reference:entry.reference,bytes:entry.bytes};
    return {state:entry?.state==='pending'?'pending':'unknown',operationId,reason:'Unconfirmed sends are never blindly resent. Inspect Saved Messages and reconcile before continuing.'};
  }
  async refreshReference(accountKey:AccountKey,reference:AttachmentRef):Promise<RemoteAttachment> {
    this.check(accountKey);await this.allowed(reference.peerId);
    if(reference.telegramUserId!==await this.me()||reference.attachmentIndex!==0)throw new AdapterError('PERMISSION_DENIED','Attachment is outside this account.');
    const message=await this.call({_: 'getMessage',chat_id:tdNumber(reference.peerId),message_id:tdNumber(reference.messageId)});
    const attachment=await this.attachment(message);if(!attachment)throw new AdapterError('REMOTE_FILE_MISSING','The original document is unavailable.');return attachment;
  }
  async fetchOriginal(accountKey:AccountKey,reference:AttachmentRef) {
    const attachment=await this.refreshReference(accountKey,reference);
    const message=await this.call({_: 'getMessage',chat_id:tdNumber(reference.peerId),message_id:tdNumber(reference.messageId)});
    const file=await this.call({_: 'downloadFile',file_id:message.content.document.document.id,priority:16,offset:0,limit:0,synchronous:true});
    if(!file.local?.is_downloading_completed||!file.local.path)throw new AdapterError('SOURCE_UNAVAILABLE','Original download is not complete.');
    const info=await stat(file.local.path);if(info.size!==attachment.bytes)throw new AdapterError('SOURCE_UNAVAILABLE','Downloaded byte count differs from the remote original.');
    return {path:file.local.path as string,bytes:info.size};
  }
  async removeMessages(_accountKey:AccountKey,_peerId:string,_messageIds:string[]):Promise<{messageId:string;outcome:'confirmed'|'unknown'|'failed'}[]> {
    throw new AdapterError('DESTRUCTIVE_ACTION_DISABLED','Remote deletion is deliberately disabled in the feasibility CLI.');
  }
  async revokeAuthorization(accountKey:AccountKey):Promise<'confirmed'|'pending'> {
    this.check(accountKey);
    if(this.revocationConfirmed)return 'confirmed';
    if(this.expectedIdentity&&!this.identity){try{await this.me();}catch{return 'pending';}}
    this.revocationRequested=true;await this.persist();
    // A closed client alone is not evidence that Telegram revoked its authorization.
    if(this.current?._==='authorizationStateClosed'&&!this.revocationAccepted)return 'pending';
    try {
      await this.call({_: 'logOut'});this.revocationAccepted=true;await this.persist();
      const until=Date.now()+1500;
      while(Date.now()<until&&this.current?._!=='authorizationStateClosed')await new Promise(resolve=>setTimeout(resolve,25));
      if(this.current?._==='authorizationStateClosed'){this.revocationConfirmed=true;await this.persist();return 'confirmed';}
      return 'pending';
    } catch{return this.revocationConfirmed?'confirmed':'pending';}
  }
  async close() {await this.writing;await this.transport.close();await this.writing;}
}

let nativeRuntime:Promise<typeof import('tdl')>|undefined;
async function loadNativeRuntime(){
  if(!nativeRuntime)nativeRuntime=(async()=>{
    const tdl=await import('tdl');const prebuilt=await import('prebuilt-tdlib');
    tdl.configure({tdjson:prebuilt.getTdjson(),verbosityLevel:0});return tdl;
  })();
  return nativeRuntime;
}
/** Native loading is lazy: importing this module never opens a session. */
export async function createTdlibAdapter(accountKey:string,config:WorkerConfig):Promise<{adapter:TdlibAdapter;close:()=>Promise<void>}> {
  if(!/^[a-zA-Z0-9_-]{3,80}$/.test(accountKey))throw new AdapterError('INVALID_ACCOUNT_KEY','Use an opaque local account key.');
  const directory=join(config.stateDirectory,accountKey);await mkdir(directory,{recursive:true,mode:0o700});
  const lock=join(directory,'worker.lock');
  try{await mkdir(lock,{mode:0o700});}catch{throw new AdapterError('WORKER_LEASE_BUSY','Another worker owns this account or a crashed worker left a lock. Verify no worker is running before removing the lock.');}
  let client:import('tdl').Client|undefined;
  try {
    const tdl=await loadNativeRuntime();
    client=tdl.createClient({apiId:config.apiId,apiHash:config.apiHash,databaseDirectory:join(directory,'database'),filesDirectory:join(directory,'files'),databaseEncryptionKey:config.databaseKey,tdlibParameters:{use_test_dc:config.useTestDc,use_message_database:true,use_secret_chats:false}});
    // Native errors must not dump provider payloads or credentials into the process log.
    client.on('error',()=>{});
    const adapter=await TdlibAdapter.open(accountKey,client as unknown as TdTransport,directory);
    return {adapter,close:async()=>{try{await adapter.close();}finally{await rm(lock,{recursive:true,force:true});}}};
  } catch(error) {if(client)await client.close().catch(()=>{});await rm(lock,{recursive:true,force:true});throw error;}
}
