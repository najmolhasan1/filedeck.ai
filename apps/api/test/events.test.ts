import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { emptyCatalog } from '@cloudnest/domain';
import { createApi } from '../src/app.js';
import type { ProductionRuntime } from '../src/production.js';

test('an open event stream stops before reading more account data after session revocation',async()=>{
  const userId='11111111-1111-4111-8111-111111111111';
  let active=true,reads=0;
  const repository={read:async(callback:any)=>{reads++;return callback(emptyCatalog());},transaction:async(callback:any)=>callback(emptyCatalog())};
  const runtime={origin:'http://localhost:3000',cookieSecret:'test-cookie-secret-at-least-32-characters',stagingRoot:'/tmp',
    auth:{authenticateSession:async(token:string)=>active&&token==='test-session'?{user:{id:userId,telegramUserId:'12345',locale:'en',status:'active'},session:{id:userId,userId,deviceId:userId,expiresAt:new Date(Date.now()+60000).toISOString()},csrfTokenHash:'unused'}:null,
      getTelegramSession:async()=>({accountKey:'test-account',state:'connected'})},
    repositoryFor:()=>repository,close:async()=>{},worker:{},dispatcher:{},sync:{}} as unknown as ProductionRuntime;
  const {app}=await createApi({demo:false,production:runtime,logger:false});
  try{
    await app.listen(0,'127.0.0.1');
    const base=`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const response=await fetch(`${base}/v1/events`,{headers:{Cookie:'cn_session=test-session'},signal:AbortSignal.timeout(6000)});
    assert.equal(response.status,200);const reader=response.body!.getReader();
    const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/event: status/);assert.equal(reads,1);
    active=false;let remaining='';
    for(;;){const chunk=await reader.read();if(chunk.done)break;remaining+=new TextDecoder().decode(chunk.value);}
    assert.match(remaining,/event: auth_expired/);assert.doesNotMatch(remaining,/event: status/);assert.equal(reads,1);
  }finally{app.getHttpServer().closeAllConnections();await app.close();}
});
