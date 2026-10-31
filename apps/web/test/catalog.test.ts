import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { canMoveFolder, formatBytes, initialCatalog, kindFor, MAX_FILE_BYTES, safePreview } from '../lib/catalog';

test('active uploaded content cannot execute through SVG or HTML previews',()=>{
  const sample=initialCatalog().files[0];
  for(const mime of ['text/html','image/svg+xml','application/javascript','application/octet-stream']) assert.equal(safePreview({...sample,mime}),null);
  assert.equal(safePreview({...sample,mime:'image/png'}),'image');
});
test('folders cannot move into themselves or descendants; ten levels remain the cap',()=>{
  const folders=Array.from({length:10},(_,i)=>({id:String(i),name:String(i),color:'green',parentId:i?String(i-1):null}));
  assert.equal(canMoveFolder(folders,'0','1'),false);
  assert.equal(canMoveFolder(folders,'3','3'),false);
  assert.equal(canMoveFolder(folders,'9',null),true);
  assert.equal(canMoveFolder([...folders,{id:'extra',name:'extra',color:'green',parentId:null}],'extra','9'),false);
});
test('sizes and limits retain exact byte semantics',()=>{
  assert.equal(MAX_FILE_BYTES,524288000);
  assert.equal(formatBytes(0),'0 B');
  assert.equal(formatBytes(1024),'1 KB');
  assert.equal(formatBytes(1048576),'1 MB');
});
test('document names and MIME determine filtering without enabling unsafe previews',()=>{
  assert.equal(kindFor('','meeting-notes.md'),'document');
  assert.equal(kindFor('video/mp4','original.mp4'),'video');
  assert.equal(kindFor('application/zip','archive.zip'),'other');
});
