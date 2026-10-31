import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { transition, type CatalogState, type FileRecord, type Transfer } from '@cloudnest/domain';
import type { AttachmentRef, SendResult } from '@cloudnest/contracts';
import type { ProductionRuntime } from './production.js';
import { ProviderError } from './telegram-client.js';

export const storedReference=(reference:AttachmentRef,accountKey:string):Record<string,string>=>({telegram_user_id:reference.telegramUserId,peer_id:reference.peerId,message_id:reference.messageId,attachment_index:String(reference.attachmentIndex),account_key:accountKey});
export function providerReference(reference:Record<string,string>):AttachmentRef {
  return {telegramUserId:reference.telegram_user_id,peerId:reference.peer_id,messageId:reference.message_id,attachmentIndex:Number(reference.attachment_index||0)};
}
/** PostgreSQL records are the durable queue. Worker journals reconcile the send effect after a lost acknowledgement. */
export class TransferDispatcher {
  private timer:ReturnType<typeof setInterval>|undefined;
  private running=false;
  private readonly lastSweep=new Map<string,number>();
  constructor(private readonly runtime:ProductionRuntime,private readonly pool:Pool){}
  start(){if(this.timer)return;this.timer=setInterval(()=>{void this.tick().catch(()=>{});},2000);this.timer.unref();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  async tick():Promise<void>{
    if(this.running)return;this.running=true;
    try{
      for(const pending of await this.runtime.auth.listPendingRevocations()){
        try{
          const outcome=await this.runtime.worker.revoke(pending.accountKey);
          if(outcome==='confirmed'){
            await this.runtime.auth.completeRevocation(pending.userId,pending.accountKey);
            const current=await this.runtime.auth.getTelegramSession(pending.userId);
            if(current?.accountKey===pending.accountKey&&current.state==='revocation_pending')await this.runtime.auth.setTelegramSessionState(pending.userId,'disconnected');
          }else await this.runtime.auth.deferRevocation(pending.userId,pending.accountKey);
        }catch(error){await this.runtime.auth.deferRevocation(pending.userId,pending.accountKey,error instanceof ProviderError?error.retryAfterSeconds:undefined,error instanceof ProviderError?error.code:'WORKER_UNAVAILABLE');}
      }
      const accounts=await this.runtime.auth.listConnectedUsers();
      for(const account of accounts){
        const lease=await this.pool.connect();let locked=false;
        try{
          const result=await lease.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[`cloudnest:dispatch:${account.userId}`]);locked=result.rows[0].locked;
          if(locked){await this.sweepAccount(account.userId,account.accountKey);await this.account(account.userId,account.accountKey);}
        }finally{if(locked)await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`cloudnest:dispatch:${account.userId}`]).catch(()=>{});lease.release();}
      }
    }finally{this.running=false;}
  }
  private async sweepAccount(userId:string,accountKey:string):Promise<void>{
    const now=Date.now();if(now-(this.lastSweep.get(userId)||0)<30000)return;this.lastSweep.set(userId,now);
    const repository=this.runtime.repositoryFor(userId);
    const candidates=await repository.read(state=>state.transfers.filter(transfer=>{
      const age=now-Date.parse(transfer.updated_at);
      return transfer.state==='COMPLETED'?age>=60*60*1000:age>=24*60*60*1000;
    }));
    for(const transfer of candidates){
      await repository.transaction(async state=>{
        // The tenant transaction serializes this check with chunk appends, so a resumed active upload cannot be swept from a stale snapshot.
        const current=state.transfers.find(item=>item.id===transfer.id);if(!current||current.updated_at!==transfer.updated_at)return;
        try{await unlink(join(this.runtime.stagingRoot,transfer.account_key||accountKey,transfer.id));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return;}
        if(current.state==='COMPLETED'||current.state==='CANCELLED')return;
        if(['CREATED','STAGING','STAGED','QUEUED','WAITING_NETWORK','WAITING_PROVIDER','RETRY_SCHEDULED','FAILED'].includes(current.state)&&current.attempts===0)current.state='FAILED';
        else current.state='NEEDS_ATTENTION';
        current.error_code='STAGING_EXPIRED';current.updated_at=new Date().toISOString();
      });
    }
  }
  private async account(userId:string,accountKey:string):Promise<void>{
    const repo=this.runtime.repositoryFor(userId),chat=await this.runtime.auth.getSelectedChat(userId);
    // A disconnect stops dispatch immediately; metadata and staged originals remain intact.
    const connection=await this.runtime.auth.getTelegramSession(userId);
    if(!chat?.canSend||connection?.state!=='connected'||connection.accountKey!==accountKey)return;
    const pending=await repo.read(state=>state.transfers.filter(t=>t.user_id===userId&&!['COMPLETED','CANCELLED','FAILED','NEEDS_ATTENTION','CREATED','STAGING','STAGED'].includes(t.state)).sort((a,b)=>a.created_at.localeCompare(b.created_at)));
    const transfer=pending[0];if(!transfer)return;
    if(transfer.account_key&&transfer.account_key!==accountKey){
      await repo.transaction(state=>{const current=state.transfers.find(item=>item.id===transfer.id);if(current){current.state='NEEDS_ATTENTION';current.error_code='ACCOUNT_SESSION_CHANGED';current.updated_at=new Date().toISOString();}});return;
    }
    if(transfer.retry_after&&Date.parse(transfer.retry_after)>Date.now())return;
    if(transfer.state==='CANCEL_REQUESTED'){
      // If no effect is possible, local cancellation is final. A started send must be reconciled.
      const result=await this.runtime.worker.result(accountKey,transfer.operation_id).catch(()=>({state:'unknown',operationId:transfer.operation_id}) as SendResult);
      if(result.state==='confirmed'){await this.confirm(userId,accountKey,transfer.id,result);return;}
      await repo.transaction(state=>{const current=state.transfers.find(t=>t.id===transfer.id);if(current?.state==='CANCEL_REQUESTED'){if(result.state==='unknown')current.state='NEEDS_ATTENTION';current.error_code='CANCEL_UNCERTAIN';current.updated_at=new Date().toISOString();}});return;
    }
    try{
      let result:SendResult;
      if(['QUEUED','RETRY_SCHEDULED','WAITING_PROVIDER','WAITING_NETWORK'].includes(transfer.state)){
        const path=join(this.runtime.stagingRoot,transfer.account_key||accountKey,transfer.id);
        const details=await stat(path);
        if(!details.isFile()||details.size!==transfer.expected_bytes)throw new ProviderError('SOURCE_UNAVAILABLE','The staged original is unavailable.',409);
        await repo.transaction(state=>{const current=state.transfers.find(t=>t.id===transfer.id)!;if(current.state==='WAITING_PROVIDER'||current.state==='WAITING_NETWORK'||current.state==='RETRY_SCHEDULED')transition(current,'QUEUED');transition(current,'SENDING');current.attempts++;current.error_code=null;current.retry_after=null;});
        result=await this.runtime.worker.send(accountKey,{path,peerId:chat.peerId,operationId:transfer.operation_id,originalName:transfer.name});
      }else{
        // SENDING persisted before dispatch, so a restarted API always asks the worker journal before considering another effect.
        result=await this.runtime.worker.result(accountKey,transfer.operation_id);
      }
      if(result.state==='confirmed'){await this.confirm(userId,accountKey,transfer.id,result);return;}
      await repo.transaction(state=>{
        const current=state.transfers.find(t=>t.id===transfer.id);if(!current||current.state==='CANCELLED')return;
        if(result.state==='pending'){
          if(current.state==='SENDING')transition(current,'VERIFYING');
          current.error_code=null;
        }else{
          if(current.state==='SENDING'||current.state==='VERIFYING')transition(current,'RECONCILING');
          if(current.state==='RECONCILING')transition(current,'NEEDS_ATTENTION');
          current.error_code='UPLOAD_UNCERTAIN';
        }
        current.updated_at=new Date().toISOString();
      });
    }catch(error){
      await repo.transaction(state=>{
        const current=state.transfers.find(t=>t.id===transfer.id);if(!current||['COMPLETED','CANCELLED'].includes(current.state))return;
        if(error instanceof ProviderError&&['PROVIDER_WAIT','WORKER_CAPACITY','WORKER_DISABLED','SESSION_STORAGE_NOT_APPROVED','ADAPTER_NOT_CONFIGURED'].includes(error.code)){
          current.state='WAITING_PROVIDER';current.retry_after=new Date(Date.now()+(error.retryAfterSeconds||60)*1000).toISOString();current.error_code=error.code;
        }else if(error instanceof ProviderError&&['SOURCE_UNAVAILABLE','PERMISSION_DENIED','AUTH_EXPIRED','FILE_TOO_LARGE'].includes(error.code)){
          current.state='FAILED';current.error_code=error.code;
        }else{
          // A network timeout may hide a successful send. Never put this operation back into QUEUED.
          current.state='RECONCILING';current.error_code='UPLOAD_UNCERTAIN';
        }
        current.updated_at=new Date().toISOString();
      });
    }
  }
  private async confirm(userId:string,accountKey:string,transferId:string,result:Extract<SendResult,{state:'confirmed'}>):Promise<void>{
    const repo=this.runtime.repositoryFor(userId),user=await this.runtime.auth.getUser(userId),selected=await this.runtime.auth.getSelectedChat(userId);
    if(!user||!selected||result.reference.telegramUserId!==user.telegramUserId||result.reference.peerId!==selected.peerId)throw new ProviderError('ACCOUNT_MISMATCH','The provider result did not match the selected account and chat.',409);
    await repo.transaction(state=>{
      const current=state.transfers.find(t=>t.id===transferId&&t.user_id===userId);if(!current||current.state==='COMPLETED')return;
      if(result.bytes!==current.expected_bytes)throw new ProviderError('SOURCE_UNAVAILABLE','The provider attachment size did not match the original.',409);
      const remote=storedReference(result.reference,accountKey);
      const existing=state.files.find(f=>f.user_id===userId&&f.remote_reference?.account_key===accountKey&&f.remote_reference?.peer_id===remote.peer_id&&f.remote_reference?.message_id===remote.message_id&&f.remote_reference?.attachment_index===remote.attachment_index);
      const tombstoned=state.tombstones.some(t=>t.user_id===userId&&t.remote_reference?.account_key===accountKey&&t.remote_reference?.peer_id===remote.peer_id&&t.remote_reference?.message_id===remote.message_id);
      const now=new Date().toISOString();
      if(current.state==='SENDING')transition(current,'VERIFYING');
      if(!['VERIFYING','RECONCILING','CANCEL_REQUESTED'].includes(current.state))current.state='RECONCILING';
      if(!existing&&!tombstoned){
        const file:FileRecord={id:randomUUID(),user_id:userId,folder_id:current.folder_id,name:current.name,original_name:current.name,mime:current.mime,bytes:current.expected_bytes,sha256:current.sha256,favorite:false,tags:[],created_at:now,updated_at:now,trashed_at:null,availability:'confirmed',version:1,remote_reference:remote};
        state.files.push(file);current.file_id=file.id;
      }else current.file_id=existing?.id||null;
      transition(current,'COMPLETED',remote);current.remote_result=remote;current.error_code=null;current.retry_after=null;
    });
    // Removing staged bytes does not remove the confirmed Telegram original.
    await unlink(join(this.runtime.stagingRoot,accountKey,transferId)).catch(()=>{});
  }
}
