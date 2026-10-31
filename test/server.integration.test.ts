/** Real PostgreSQL + HTTP integration. The provider fixture exists only in this test. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { parseRange } from '@cloudnest/domain';
import { createApi } from '../apps/api/src/app.js';

import { startProviderFixture as testWorker, workerToken } from './fixtures/provider.js';
const origin = 'http://localhost:3000';
const sleep = (ms: number) => new Promise(resolve=>setTimeout(resolve,ms));


class BrowserClient {
  readonly cookies = new Map<string,string>();
  csrf = '';
  constructor(readonly base: string) {}
  async request(path: string, options: RequestInit = {}, csrf = true) {
    const headers = new Headers(options.headers);
    headers.set('Cookie',[...this.cookies].map(([key,value])=>`${key}=${value}`).join('; '));
    if(options.method && !['GET','HEAD'].includes(options.method)) {
      headers.set('Origin',origin);
      headers.set('Idempotency-Key',randomUUID());
      if(csrf && this.csrf) headers.set('X-CSRF-Token',this.csrf);
    }
    const response=await fetch(`${this.base}${path}`,{...options,headers});
    for(const cookie of response.headers.getSetCookie()) {
      const [pair]=cookie.split(';'); const at=pair.indexOf('=');
      if(at>=0) this.cookies.set(pair.slice(0,at),pair.slice(at+1));
    }
    return response;
  }
  async json(path: string, body?: unknown, method = 'POST', csrf = true) {
    const response=await this.request(path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)},csrf);
    return {response,body:await response.json() as any};
  }
  async bootstrap() {
    const response=await this.request('/v1/auth/bootstrap');
    assert.equal(response.status,200); const body=await response.json() as any;
    assert.equal(typeof body.csrf_token,'string'); this.csrf=body.csrf_token; return body;
  }
}


test('server drive binds verified identity, requires CSRF, isolates tenants, and waits for provider confirmation', {skip:!process.env.TEST_DATABASE_URL},async()=>{
  const worker=await testWorker();const directory=await mkdtemp(join(tmpdir(),'cloudnest-server-test-'));
  const previous={...process.env};
  const alicePhone=`+880${Date.now().toString().slice(-8)}01`,bobPhone=`+880${Date.now().toString().slice(-8)}02`;
  Object.assign(process.env,{CLOUDNEST_API_ENABLE:'true',CLOUDNEST_DEMO:'0',DATABASE_URL:process.env.TEST_DATABASE_URL,AUTH_DATABASE_URL:process.env.TEST_DATABASE_URL,TELEGRAM_WORKER_URL:worker.url,CLOUDNEST_WORKER_TOKEN:workerToken,CLOUDNEST_COOKIE_SECRET:randomUUID()+randomUUID(),APP_ORIGIN:origin,STAGING_ROOT:directory,CLOUDNEST_DISPATCH_AUTO:'false'});
  let application: Awaited<ReturnType<typeof createApi>>|undefined;
  try {
    application=await createApi({logger:false});await application.app.listen(0,'127.0.0.1');
    const base=`http://127.0.0.1:${(application.app.getHttpServer().address() as AddressInfo).port}`;
    const alice=new BrowserClient(base); const bob=new BrowserClient(base); const anonymous=new BrowserClient(base);
    const blocked=await anonymous.request('/v1/files');assert.equal(blocked.status,401);
    await alice.bootstrap();
    const csrfDenied=await alice.json('/v1/auth/telegram/start',{phone:alicePhone,disclosureAccepted:true},'POST',false);
    assert.equal(csrfDenied.response.status,403);
    const start=await alice.json('/v1/auth/telegram/start',{phone:alicePhone,disclosureAccepted:true});assert.equal(start.body.state,'code_required');
    const wrong=await alice.json('/v1/auth/telegram/step',{step:{type:'code',value:'wrong'}});assert.equal(wrong.body.error.code,'INVALID_CODE');
    const code=await alice.json('/v1/auth/telegram/step',{step:{type:'code',value:'12345'}});assert.equal(code.body.state,'password_required');
    const password=await alice.json('/v1/auth/telegram/step',{step:{type:'password',value:'fixture-password'}});assert.equal(password.body.state,'ready');
    assert.match(password.response.headers.getSetCookie().join(';'),/HttpOnly/i);
    await alice.bootstrap();
    const me=await (await alice.request('/v1/me')).json() as any;assert.equal(typeof me.id,'string');
    const storage=await alice.json('/v1/storage-chats',{type:'saved_messages'});assert.ok(storage.response.ok,JSON.stringify(storage.body));
    const original=Buffer.from('Exact original bytes. বাংলা লেখা.\n');
    const upload=await alice.json('/v1/uploads',{name:'original.txt',bytes:original.length,mime:'text/plain'});assert.equal(upload.response.status,201);
    const id=upload.body.id;assert.equal(typeof id,'string');
    const checksum=createHash('sha256').update(original).digest('base64');
    const patch=await alice.request(`/v1/uploads/${id}`,{method:'PATCH',headers:{'Content-Type':'application/offset+octet-stream','Upload-Offset':'0','Upload-Checksum':`sha256 ${checksum}`},body:original});assert.equal(patch.status,204);
    const commit=await alice.json(`/v1/uploads/${id}/commit`,{});assert.equal(commit.response.status,202);
    const before=await (await alice.request('/v1/files')).json() as any;assert.equal(before.items.length,0,'Staging must never create a confirmed file');
    const runtime=(application as any).production;assert.ok(runtime?.dispatcher?.tick,'Production dispatcher test seam must be available');
    await runtime.dispatcher.tick(); await runtime.dispatcher.tick();
    assert.equal(worker.sendCount,1,'Pending sends must not be blindly sent again');
    const stillPending=await (await alice.request('/v1/files')).json() as any;assert.equal(stillPending.items.length,0);
    for(const operation of worker.operations.values())operation.confirmed=true;
    let catalog:any;
    for(let attempt=0;attempt<4;attempt++){await runtime.dispatcher.tick();catalog=await (await alice.request('/v1/files')).json();if(catalog.items.length)break;await sleep(20);}
    assert.equal(catalog.items.length,1);const file=catalog.items[0];assert.equal(file.availability,'confirmed');
    assert.equal(file.sha256,createHash('sha256').update(original).digest('hex'));
    const download=await alice.request(`/v1/files/${file.id}/content`);assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),original);
    const range=await alice.request(`/v1/files/${file.id}/content`,{headers:{Range:'bytes=2-8'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),original.subarray(2,9));
    await bob.bootstrap();await bob.json('/v1/auth/telegram/start',{phone:bobPhone,disclosureAccepted:true});await bob.json('/v1/auth/telegram/step',{step:{type:'code',value:'12345'}});await bob.bootstrap();
    const other=await (await bob.request('/v1/files')).json() as any;assert.equal(other.items.length,0);
    assert.equal((await bob.request(`/v1/files/${file.id}/content`)).status,404);
    const foreignMutation=await bob.json(`/v1/files/${file.id}/trash`,{});assert.equal(foreignMutation.response.status,404);
    const trash=await alice.json(`/v1/files/${file.id}/trash`,{});assert.ok(trash.response.ok);
    const restore=await alice.json(`/v1/files/${file.id}/restore`,{});assert.ok(restore.response.ok);
    const logout=await alice.json('/v1/auth/logout',{});assert.ok(logout.response.ok);
    assert.equal((await alice.request('/v1/files')).status,401);
    // A fresh verified login to the same Telegram identity reuses only an independently verified canonical worker.
    const reconnected=new BrowserClient(base);await reconnected.bootstrap();
    await reconnected.json('/v1/auth/telegram/start',{phone:alicePhone,disclosureAccepted:true});
    await reconnected.json('/v1/auth/telegram/step',{step:{type:'code',value:'12345'}});
    await reconnected.json('/v1/auth/telegram/step',{step:{type:'password',value:'fixture-password'}});await reconnected.bootstrap();
    const afterReconnect=await reconnected.request(`/v1/files/${file.id}/content`);assert.equal(afterReconnect.status,200);
    assert.deepEqual(Buffer.from(await afterReconnect.arrayBuffer()),original,'Re-login must preserve access through a verified canonical TDLib database');
    const invalidRange=await reconnected.request(`/v1/files/${file.id}/content`,{headers:{Range:'bytes=999999-'}});
    assert.equal(invalidRange.status,416);assert.equal(invalidRange.headers.get('Content-Range'),`bytes */${original.length}`);
    // Recovery imports a provider-only original once, then respects its catalog tombstone.
    const first=[...worker.operations.values()][0];
    worker.operations.set('recovery-fixture',{...first,reference:{...first.reference,messageId:'20000'},confirmed:true});
    const scan=await reconnected.json('/v1/sync-jobs',{});assert.equal(scan.response.status,202);
    await runtime.sync.tick();
    const scanResult=await (await reconnected.request(`/v1/sync-jobs/${scan.body.id}`)).json() as any;
    assert.equal(scanResult.state,'COMPLETED');assert.equal(scanResult.imported_files,1);
    assert.equal((await bob.request(`/v1/sync-jobs/${scan.body.id}`)).status,404);
    let recovered=await (await reconnected.request('/v1/files')).json() as any;assert.equal(recovered.items.length,2);
    const onlyRecovered=recovered.items.find((item:any)=>item.id!==file.id);
    const removed=await reconnected.json(`/v1/files/${onlyRecovered.id}/catalog`,{},'DELETE');assert.ok(removed.response.ok);
    await reconnected.json('/v1/sync-jobs',{});await runtime.sync.tick();
    recovered=await (await reconnected.request('/v1/files')).json();assert.equal(recovered.items.length,1,'A rescan must not resurrect catalog tombstones');
    const malformed=new BrowserClient(base);malformed.cookies.set('cn_session','%ZZ');
    assert.equal((await malformed.request('/v1/files')).status,401,'Malformed cookie must be unauthenticated rather than a server error');
    const forged=new BrowserClient(base);
    assert.equal((await forged.request('/v1/files',{headers:{'X-User-Id':me.id}})).status,401);

  } finally {
    if(application)await application.app.close();
    worker.server.closeAllConnections();await new Promise<void>(resolve=>worker.server.close(()=>resolve()));
    for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
    await rm(directory,{recursive:true,force:true});
  }
});
