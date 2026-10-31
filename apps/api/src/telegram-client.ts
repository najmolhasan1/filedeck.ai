import { DomainError } from '@cloudnest/domain';
import type { AuthorizationState, AuthorizationStep, AllowedChat, AttachmentRef, SendResult, Capabilities, RemoteAttachment } from '@cloudnest/contracts';

export class ProviderError extends DomainError {
  constructor(code: string, message: string, status = 503, readonly retryAfterSeconds?: number) { super(code, message, status); }
}

/** Internal worker transport. Credentials never cross the public API boundary. */
export class TelegramClient {
  constructor(readonly url: string, private readonly token: string) {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || token.length < 32) throw new Error('Invalid internal worker configuration.');
  }
  async rpc<T>(method: string, accountKey: string, input: object = {}): Promise<T> {
    let response: globalThis.Response;
    try { response = await fetch(new URL('/rpc', this.url), { method:'POST', headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'}, body:JSON.stringify({method,accountKey,input}), signal:AbortSignal.timeout(30000) }); }
    catch { throw new ProviderError('WORKER_UNAVAILABLE','The Telegram connection is temporarily unavailable.'); }
    const payload = await response.json().catch(() => null) as {result?:T;error?:{code?:string;message?:string;retryAfterSeconds?:number}} | null;
    if (!response.ok || payload?.error) {
      const code = payload?.error?.code || 'WORKER_UNAVAILABLE';
      const safeCodes = new Set(['AUTH_EXPIRED','ADAPTER_NOT_CONFIGURED','PROVIDER_WAIT','PERMISSION_DENIED','INVALID_CODE','CODE_INVALID','CODE_EXPIRED','PASSWORD_INVALID','AUTH_STEP_INVALID','FILE_TOO_LARGE','REMOTE_FILE_MISSING','SOURCE_UNAVAILABLE','UPLOAD_UNCERTAIN','ACCOUNT_MISMATCH','TWO_FACTOR_REQUIRED','INVALID_PASSWORD','INVALID_AUTH_STEP','WORKER_DISABLED','SESSION_STORAGE_NOT_APPROVED','WORKER_CAPACITY']);
      const safe = safeCodes.has(code) ? code : 'PROVIDER_ERROR';
      const messages: Record<string,string> = {PROVIDER_WAIT:'Telegram asked us to wait before continuing.',INVALID_CODE:'The verification code is invalid.',CODE_INVALID:'The verification code is invalid.',CODE_EXPIRED:'The verification code expired. Start a new connection.',INVALID_PASSWORD:'The two-step verification password is invalid.',INVALID_AUTH_STEP:'Telegram is waiting for a different verification step.',WORKER_DISABLED:'The Telegram worker is disabled.',SESSION_STORAGE_NOT_APPROVED:'Approved encrypted session storage must be configured before connecting Telegram.',WORKER_CAPACITY:'The Telegram service is busy. Wait before trying again.',PASSWORD_INVALID:'The two-step verification password is invalid.',AUTH_EXPIRED:'Your Telegram session expired. Connect again.',AUTH_STEP_INVALID:'Telegram is waiting for a different verification step.',ACCOUNT_MISMATCH:'This connection belongs to a different Telegram account.',PERMISSION_DENIED:'Telegram did not permit this action.',REMOTE_FILE_MISSING:'The original Telegram attachment is unavailable.',SOURCE_UNAVAILABLE:'The original file is unavailable.',FILE_TOO_LARGE:'This file exceeds the allowed size.',UPLOAD_UNCERTAIN:'The upload needs verification before another send.',ADAPTER_NOT_CONFIGURED:'The Telegram worker is not configured.'};
      const retry = Number(payload?.error?.retryAfterSeconds);
      throw new ProviderError(safe,messages[safe]||'Telegram could not complete this action.',[400,401,403,429].includes(response.status)?response.status:503,Number.isFinite(retry)&&retry>0?Math.ceil(retry):undefined);
    }
    return payload?.result as T;
  }
  state(accountKey:string) { return this.rpc<AuthorizationState>('auth.state',accountKey); }
  start(accountKey:string,phoneNumber:string) { return this.rpc<AuthorizationState>('auth.start',accountKey,{phoneNumber}); }
  step(accountKey:string,step:AuthorizationStep) { return this.rpc<AuthorizationState>('auth.step',accountKey,step); }
  capabilities(accountKey:string) { return this.rpc<Capabilities>('capabilities',accountKey); }
  chats(accountKey:string) { return this.rpc<AllowedChat[]>('chats.list',accountKey); }
  selectChat(accountKey:string,peerId:string) { return this.rpc<AllowedChat>('chats.select',accountKey,{peerId}); }
  send(accountKey:string,input:{path:string;peerId:string;operationId:string;originalName?:string}) { return this.rpc<SendResult>('files.send',accountKey,input); }
  result(accountKey:string,operationId:string) { return this.rpc<SendResult>('files.result',accountKey,{operationId}); }
  revoke(accountKey:string) { return this.rpc<'confirmed'|'pending'>('session.revoke',accountKey); }
  refresh(accountKey:string,reference:AttachmentRef) { return this.rpc<RemoteAttachment>('files.refresh',accountKey,{reference}); }
  async content(accountKey:string,reference:AttachmentRef,range?:string):Promise<globalThis.Response> {
    try {
      const response = await fetch(new URL('/content',this.url), {method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json',...(range?{Range:range}:{})},body:JSON.stringify({accountKey,reference}),signal:AbortSignal.timeout(120000)});
      if(!response.ok) throw new ProviderError(response.status===416?'RANGE_NOT_SATISFIABLE':'REMOTE_FILE_MISSING',response.status===416?'This byte range is unavailable.':'The original Telegram attachment is unavailable.',response.status);
      return response;
    } catch(error) {if(error instanceof ProviderError)throw error;throw new ProviderError('WORKER_UNAVAILABLE','The download connection was interrupted.');}
  }
}
