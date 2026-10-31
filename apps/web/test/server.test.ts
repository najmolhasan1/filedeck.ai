import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {APIError,normalizeAuthState,normalizeTransfer,ServerGateway} from '../lib/server';

const json=(body:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}});
const bootstrap={authenticated:true,csrf_token:'csrf-only-in-memory',user:{id:'owner-one',telegram_connected:true}};
const me={id:'owner-one',telegram_connected:true,csrf_token:'csrf-only-in-memory'};
function memoryStorage() {
  const values=new Map<string,string>();
  return {getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);},values};
}

test('provider-driven authorization uses cookie credentials and keeps CSRF/login values out of browser storage',async()=>{
  const storage=memoryStorage();const calls:{path:string;init?:RequestInit}[]=[];
  const gateway=new ServerGateway({storage,fetcher:async(path,init)=>{
    calls.push({path,init});
    if(path.endsWith('/auth/bootstrap'))return json(bootstrap);
    if(path.endsWith('/auth/telegram/start'))return json({state:'code_required',delivery:'Telegram'});
    if(path.endsWith('/auth/telegram/step'))return json({state:'password_required',hint:'A hint'});
    return json({state:'ready'});
  }});
  assert.equal((await gateway.authStart('+880123456789',true)).state,'code_required');
  assert.equal((await gateway.authStep('code','12345')).state,'password_required');
  const mutation=calls[1];assert.equal(mutation.init?.credentials,'same-origin');
  assert.equal(new Headers(mutation.init?.headers).get('X-CSRF-Token'),'csrf-only-in-memory');
  assert.ok(new Headers(mutation.init?.headers).get('Idempotency-Key'));
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)),{step:{type:'code',value:'12345'}});
  assert.equal([...storage.values.values()].join(''),'');
  assert.equal(normalizeAuthState({state:'waiting_password'}).state,'password_required');
});

test('browser staging and queued transfers never imply confirmed Telegram backup',()=>{
  for(const state of ['CREATED','STAGING','STAGED','QUEUED','SENDING','VERIFYING','RECONCILING','WAITING_PROVIDER']){
    const normalized=normalizeTransfer({id:'upload',state,expected_bytes:12,stage_bytes:12});
    assert.notEqual(normalized.status,'completed');assert.equal(normalized.remoteConfirmed,false);
  }
  assert.equal(normalizeTransfer({state:'COMPLETED',telegram_confirmed:false}).remoteConfirmed,false);
  assert.equal(normalizeTransfer({state:'COMPLETED'}).remoteConfirmed,true);
});

test('catalog pagination visits all pages and mutations send row versions and ownership-bound cookies',async()=>{
  const calls:{path:string;init?:RequestInit}[]=[];
  const rawFile={id:'file-one',name:'original.txt',original_name:'original.txt',mime:'text/plain',bytes:4,version:7,availability:'remote',created_at:'2026-10-30T00:00:00Z'};
  const gateway=new ServerGateway({storage:null,fetcher:async(path,init)=>{
    calls.push({path,init});
    if(path.endsWith('/auth/bootstrap'))return json(bootstrap);
    if(path==='/v1/files/file-one')return json({...rawFile,name:'renamed.txt',version:8});
    if(path==='/v1/folders')return json({items:[{id:'folder',name:'Folder',version:2,parent_id:null}]});
    if(path==='/v1/transfers')return json({items:[]});
    const query=new URL(path,'https://app.test').searchParams;
    if(query.get('trash')==='true')return json({items:[]});
    return json(query.get('cursor')?{items:[{...rawFile,id:'file-two'}],next_cursor:null}:{items:[rawFile],next_cursor:'page-two'});
  }});
  const catalog=await gateway.loadCatalog();assert.equal(catalog.files.length,2);assert.equal(catalog.files[0].version,7);
  await gateway.patchFile(catalog.files[0],{name:'renamed.txt',folderId:null});
  const patch=calls.find(call=>call.init?.method==='PATCH')!;
  assert.equal(new Headers(patch.init?.headers).get('If-Match'),'7');
  assert.deepEqual(JSON.parse(String(patch.init?.body)),{name:'renamed.txt',folder_id:null});
});

test('a lost chunk acknowledgement resumes at the server offset without another upload or changed bytes',async()=>{
  const storage=memoryStorage();const bytes=new Uint8Array(4*1024*1024+17).fill(41);
  const file=new File([bytes],'original.bin',{type:'application/octet-stream',lastModified:19});
  let offset=0;let loseAcknowledgement=true;let initialized=0;const patchOffsets:number[]=[];
  const fetcher=async(path:string,init?:RequestInit):Promise<Response>=>{
    if(path.endsWith('/me'))return json(me);
    if(path.endsWith('/auth/bootstrap'))return json(bootstrap);
    if(path==='/v1/uploads'){initialized++;return json({id:'server-upload'});}
    if(init?.method==='HEAD')return new Response(null,{status:204,headers:{'Upload-Offset':String(offset),'Upload-Length':String(file.size)}});
    if(init?.method==='PATCH'){
      const current=Number(new Headers(init.headers).get('Upload-Offset'));patchOffsets.push(current);assert.equal(current,offset);
      const body=init.body as Blob;const chunk=Buffer.from(await body.arrayBuffer());
      assert.deepEqual(chunk,Buffer.from(bytes.slice(offset,offset+chunk.byteLength)));offset+=chunk.byteLength;
      if(loseAcknowledgement){loseAcknowledgement=false;throw new Error('Network acknowledgement lost');}
      return new Response(null,{status:204,headers:{'Upload-Offset':String(offset)}});
    }
    if(path.endsWith('/commit'))return json({transfer:{id:'server-upload',state:'QUEUED',expected_bytes:file.size,stage_bytes:file.size},telegram_confirmed:false},202);
    throw new Error(`Unexpected route ${path}`);
  };
  const first=new ServerGateway({storage,fetcher});
  await assert.rejects(first.upload(file),error=>error instanceof APIError&&error.code==='NETWORK_ERROR');
  const descriptor=first.pendingUploads()[0];assert.equal(descriptor.uploadId,'server-upload');
  const second=new ServerGateway({storage,fetcher});await second.me();
  const result=await second.upload(file,{resumeId:descriptor.id});
  assert.deepEqual(patchOffsets,[0,4*1024*1024]);assert.equal(initialized,1);assert.equal(result.transfer.state,'QUEUED');
  assert.equal(result.transfer.remoteConfirmed,false);assert.equal(second.pendingUploads().length,0);
  assert.equal([...storage.values.values()].join('').includes('csrf-only-in-memory'),false);
});

test('reselected files with identical metadata but changed contents cannot resume an original',async()=>{
  const storage=memoryStorage();let patchCount=0;
  const fetcher=async(path:string,init?:RequestInit):Promise<Response>=>{
    if(path.endsWith('/me'))return json(me);
    if(path.endsWith('/auth/bootstrap'))return json(bootstrap);
    if(path==='/v1/uploads')return json({id:'upload'});
    if(init?.method==='HEAD')return new Response(null,{status:204,headers:{'Upload-Offset':'0','Upload-Length':'4'}});
    if(init?.method==='PATCH'){patchCount++;throw new Error('Disconnected');}
    throw new Error('Unexpected route');
  };
  const gateway=new ServerGateway({storage,fetcher});
  await assert.rejects(gateway.upload(new File(['same'],'same.txt',{lastModified:5})));
  const descriptor=gateway.pendingUploads()[0];
  await assert.rejects(gateway.upload(new File(['edit'],'same.txt',{lastModified:5}),{resumeId:descriptor.id}),error=>error instanceof APIError&&error.code==='SOURCE_CHANGED');
  assert.equal(patchCount,1);
});

test('provider flood waits remain actionable and errors do not expose HTML responses',async()=>{
  const gateway=new ServerGateway({storage:null,fetcher:async(path)=>path.endsWith('/auth/bootstrap')?json(bootstrap):json({error:{code:'PROVIDER_WAIT',message:'Telegram asked us to wait.',retry_after_seconds:90},request_id:'request-one'},429)});
  await assert.rejects(gateway.authStart('+880123456789',true),error=>error instanceof APIError&&error.code==='PROVIDER_WAIT'&&error.retryAfterSeconds===90&&error.requestId==='request-one');
  const invalid=new ServerGateway({storage:null,fetcher:async()=>new Response('<html>Internal error</html>',{status:502})});
  await assert.rejects(invalid.me(),error=>error instanceof APIError&&!error.message.includes('<html>'));
});

test('lost upload initialization reuses its idempotency key, including empty originals',async()=>{
  const storage=memoryStorage();let first=true;const keys:string[]=[];let patches=0;
  const fetcher=async(path:string,init?:RequestInit):Promise<Response>=>{
    if(path.endsWith('/me'))return json(me);
    if(path.endsWith('/auth/bootstrap'))return json(bootstrap);
    if(path==='/v1/uploads'){
      keys.push(new Headers(init?.headers).get('Idempotency-Key')!);
      if(first){first=false;throw new Error('Lost initialization acknowledgement');}
      return json({id:'empty-upload'});
    }
    if(init?.method==='HEAD')return new Response(null,{status:204,headers:{'Upload-Offset':'0','Upload-Length':'0'}});
    if(init?.method==='PATCH'){patches++;throw new Error('Empty files must not send a chunk');}
    if(path.endsWith('/commit'))return json({transfer:{id:'empty-upload',state:'QUEUED',expected_bytes:0,stage_bytes:0}},202);
    throw new Error('Unexpected route');
  };
  const file=new File([],'empty.txt');const firstGateway=new ServerGateway({fetcher,storage});
  await assert.rejects(firstGateway.upload(file));const descriptor=firstGateway.pendingUploads()[0];
  assert.equal(descriptor.uploadId,undefined);
  const secondGateway=new ServerGateway({fetcher,storage});await secondGateway.me();
  await secondGateway.upload(file,{resumeId:descriptor.id});
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(patches,0);
});

test('missing server upload offsets cannot be mistaken for a safe zero offset',async()=>{
  let patches=0;
  const gateway=new ServerGateway({storage:null,fetcher:async(path,init)=>{
    if(path.endsWith('/me'))return json(me);
    if(path.endsWith('/auth/bootstrap'))return json(bootstrap);
    if(path==='/v1/uploads')return json({id:'upload'});
    if(init?.method==='HEAD')return new Response(null,{status:204});
    if(init?.method==='PATCH')patches++;
    return json({});
  }});
  await assert.rejects(gateway.upload(new File(['bytes'],'data.txt')),error=>error instanceof APIError&&error.code==='INVALID_UPLOAD_OFFSET');
  assert.equal(patches,0);
});
