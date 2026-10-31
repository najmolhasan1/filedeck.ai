import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { copyFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { AdapterError, type AttachmentRef } from '@cloudnest/contracts';
import { configFromEnv, createTdlibAdapter } from './adapter.js';

// Deliberately not an HTTP server. Never expose this developer harness publicly.
async function main() {
  const config=configFromEnv(process.env);
  const account=process.env.CLOUDNEST_SPIKE_ACCOUNT || 'isolated-test-account';
  console.log('CloudNest TDLib feasibility harness — isolated developer accounts only.');
  console.log('The web product does not yet use this session. Session scope extends beyond selected chats.');
  console.log('State storage requires an encrypted volume; the application cannot verify that mount.');
  const worker=await createTdlibAdapter(account,config);
  let rl=createInterface({input:stdin,output:stdout});
  let selectedPeer:string|undefined;
  const safeOutput=(value:unknown)=>console.log(JSON.stringify(value,null,2));
  try {
    console.log('Commands: state | login | code | password | chats | select <peer> | upload <absolute path> | result <operation> | download <message> <output path> | logout | quit');
    while(true) {
      const command=await rl.question('cloudnest> ');
      const [verb,...args]=command.trim().split(' ');
      try {
        if(verb==='quit'||verb==='exit')break;
        if(verb==='state')safeOutput(await worker.adapter.getAuthorizationState(account));
        else if(verb==='login') {
          const phoneNumber=await rl.question('International phone number (not logged): ');
          safeOutput(await worker.adapter.startAuthorization(account,{phoneNumber}));
        } else if(verb==='code'||verb==='password') {
          // Prompt via a separate hidden terminal invocation instead of echoing secrets.
          if(!stdin.isTTY)throw new AdapterError('TTY_REQUIRED','An interactive terminal is required for hidden code/password entry.');
          rl.close();
          let value:string;
          try { value=await hiddenPrompt(verb==='code'?'Telegram code: ':'Telegram two-step password: '); }
          finally { rl=createInterface({input:stdin,output:stdout}); }
          safeOutput(await worker.adapter.submitAuthorizationStep(account,{type:verb,value}));
        } else if(verb==='chats')safeOutput(await worker.adapter.listAllowedChats(account));
        else if(verb==='select') {const chat=await worker.adapter.selectStorageChat(account,args[0]||'');selectedPeer=chat.peerId;safeOutput(chat);}
        else if(verb==='upload') {
          if(!selectedPeer)throw new AdapterError('STORAGE_REQUIRED','Run chats and select your Saved Messages destination first.');
          const path=args.join(' ');const operationId=randomUUID();
          console.log(`Stable operation ID: ${operationId}. Keep it for reconciliation; never retry an uncertain send with a new ID.`);
          safeOutput(await worker.adapter.sendOriginalFile(account,{path,peerId:selectedPeer,operationId}));
        } else if(verb==='result')safeOutput(await worker.adapter.lookupSendResult(account,args[0]||''));
        else if(verb==='download') {
          if(!selectedPeer)throw new AdapterError('STORAGE_REQUIRED','Select the same Saved Messages destination first.');
          const auth=await worker.adapter.getAuthorizationState(account);if(auth.state!=='ready')throw new AdapterError('AUTH_REQUIRED','Connect the isolated test account first.');
          const ref:AttachmentRef={telegramUserId:auth.telegramUserId,peerId:selectedPeer,messageId:args[0]||'',attachmentIndex:0};
          const file=await worker.adapter.fetchOriginal(account,ref);
          const destination=args.slice(1).join(' ');if(!destination)throw new AdapterError('OUTPUT_REQUIRED','Provide an output path.');
          await copyFile(file.path,destination);
          const hasher=createHash('sha256');for await(const chunk of createReadStream(destination))hasher.update(chunk);
          const digest=hasher.digest('hex');
          safeOutput({bytes:(await stat(destination)).size,sha256:digest});
        } else if(verb==='logout')safeOutput({revocation:await worker.adapter.revokeAuthorization(account)});
        else if(verb)console.log('Unknown command. Use state, login, code, password, chats, select, upload, result, download, logout or quit.');
      } catch(error) {report(error);}
    }
  } finally {rl.close();await worker.close();}
}
function hiddenPrompt(label:string):Promise<string> {
  // readline's regular input would echo OTPs; raw mode collects them silently.
  stdout.write(label);stdin.setRawMode(true);stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    const listener=(data:Buffer)=>{
      for(const char of data.toString()) {
        if(char==='\u0003'){cleanup();reject(new AdapterError('CANCELLED','Secret entry cancelled.'));return;}
        if(char==='\r'||char==='\n'){cleanup();resolve(value);return;}
        if(char==='\u007f'){value=value.slice(0,-1);continue;}
        if(char>=' ')value+=char;
      }
    };
    function cleanup(){stdin.off('data',listener);stdin.setRawMode(false);stdout.write('\n');}
    stdin.on('data',listener);
  });
}
function report(error:unknown) {
  if(error instanceof AdapterError)console.error(JSON.stringify({error:{code:error.code,message:error.message,retryAfterSeconds:error.retryAfterSeconds}}));
  else console.error(JSON.stringify({error:{code:'WORKER_FAILED',message:'Worker could not complete this operation. Check native TDLib installation and the encrypted state volume.'}}));
}
main().catch(error=>{report(error);process.exitCode=1;});
