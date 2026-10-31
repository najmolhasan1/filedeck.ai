import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { parseRange } from '@cloudnest/domain';
export const workerToken='integration-worker-token-with-at-least-32-characters';
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startProviderFixture() {
  const accounts=new Map<string,{id:string;state:string;twoFactor:boolean}>();
  const operations=new Map<string,{accountKey:string;bytes:Buffer;reference:any;confirmed:boolean}>();
  let sendCount=0;
  const runId=String(Date.now()).slice(-9);
  const server=createServer(async(request,response)=>{
    try {
      if(request.url==='/health'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({status:'ok',configured:true}));return;}
      if(request.headers.authorization!==`Bearer ${workerToken}`){response.writeHead(401);response.end();return;}
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const account=accounts.get(body.accountKey);
      if(request.url==='/content') {
        const operation=[...operations.values()].find(item=>item.accountKey===body.accountKey&&item.reference.messageId===body.reference.messageId);
        if(!operation){response.writeHead(404);response.end();return;}
        const range=parseRange(request.headers.range,operation.bytes.length);
        response.statusCode=range.partial?206:200;
        response.setHeader('Content-Type','application/octet-stream');
        response.setHeader('Accept-Ranges','bytes');
        response.setHeader('Content-Length',String(range.end-range.start+1));
        if(range.partial)response.setHeader('Content-Range',`bytes ${range.start}-${range.end}/${operation.bytes.length}`);
        response.end(operation.bytes.subarray(range.start,range.end+1));return;
      }
      let result:any;
      const state=()=>account?.state==='ready'?{state:'ready',telegramUserId:account.id}:account?.state==='password_required'?{state:'password_required',hint:'Fixture only'}:{state:'code_required',delivery:'Telegram'};
      switch(body.method) {
        case 'auth.start': {
          const twoFactor=body.input.phoneNumber.endsWith('01');
          accounts.set(body.accountKey,{id:`7${runId}${twoFactor?'01':'02'}`,state:'code_required',twoFactor});
          result={state:'code_required',delivery:'Telegram'};break;
        }
        case 'auth.state':result=state();break;
        case 'auth.step': {
          if(!account)throw new Error('Missing test account');
          if(body.input.type==='code'&&body.input.value==='12345'&&account.state==='code_required')account.state=account.twoFactor?'password_required':'ready';
          else if(body.input.type==='password'&&body.input.value==='fixture-password'&&account.state==='password_required')account.state='ready';
          else {response.statusCode=400;response.setHeader('Content-Type','application/json');response.end(JSON.stringify({error:{code:'INVALID_CODE',message:'The verification code is incorrect.'}}));return;}
          result=state();break;
        }
        case 'capabilities':result={productMaxBytes:524288000,providerLimitVerified:false,premium:false};break;
        case 'chats.list':result=[{peerId:account!.id,title:'Saved Messages',kind:'saved_messages',canSend:true,canDelete:true}];break;
        case 'chats.select':result={peerId:account!.id,title:'Saved Messages',kind:'saved_messages',canSend:true,canDelete:true};break;
        case 'files.send': {
          sendCount++;
          const bytes=await readFile(body.input.path);
          const reference={telegramUserId:account!.id,peerId:account!.id,messageId:String(10000+operations.size),attachmentIndex:0};
          operations.set(body.input.operationId,{accountKey:body.accountKey,bytes,reference,confirmed:false});
          result={state:'pending',operationId:body.input.operationId};break;
        }
        case 'files.result': {
          const operation=operations.get(body.input.operationId);
          result=operation?.confirmed?{state:'confirmed',reference:operation.reference,bytes:operation.bytes.length}:{state:'pending',operationId:body.input.operationId};break;
        }
        case 'files.refresh': {
          const operation=[...operations.values()].find(item=>item.reference.messageId===body.input.reference.messageId);
          result={reference:operation!.reference,originalName:'original.txt',mime:'text/plain',bytes:operation!.bytes.length,createdAt:new Date().toISOString()};break;
        }
        case 'attachments.list':result={items:[...operations.values()].filter(item=>item.accountKey===body.accountKey&&item.confirmed).map(item=>({reference:item.reference,originalName:'original.txt',mime:'text/plain',bytes:item.bytes.length,createdAt:new Date().toISOString()}))};break;
        case 'session.revoke':if(account)account.state='closed';result='confirmed';break;
        default:throw new Error('Unexpected fixture method');
      }
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify({result}));
    } catch {
      response.statusCode=500;response.setHeader('Content-Type','application/json');response.end(JSON.stringify({error:{code:'FIXTURE_ERROR',message:'Test fixture could not complete the call.'}}));
    }
  });
  return {server,url:await listen(server),operations,get sendCount(){return sendCount;}};
}

