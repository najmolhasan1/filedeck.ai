import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {initialCatalog} from '../lib/catalog';
import {parseCatalogImport} from '../lib/catalog-import';
test('metadata import keeps known originals and does not trust claimed cloud status or hashes',()=>{
 const current=initialCatalog(),exported=structuredClone(current);exported.files[0].name='Renamed original.jpg';const imported=parseCatalogImport(exported,current);assert.equal(imported.files[0].asset,current.files[0].asset);assert.equal(imported.files[0].name,'Renamed original.jpg');
 exported.files[0].id='unknown';exported.files[0].sha256='a'.repeat(64);exported.files[0].source='server';const untrusted=parseCatalogImport(exported,current).files[0];assert.equal(untrusted.source,'browser');assert.equal(untrusted.sha256,undefined);assert.equal(untrusted.asset,undefined);assert.equal(untrusted.availability,'missing');
});
test('metadata import rejects cycles, unsafe names and duplicate IDs',()=>{
 const current=initialCatalog(),cycle=structuredClone(current);cycle.folders[0].parentId=cycle.folders[0].id;assert.throws(()=>parseCatalogImport(cycle,current),/cycle/);
 const duplicate=structuredClone(current);duplicate.files.push(duplicate.files[0]);assert.throws(()=>parseCatalogImport(duplicate,current),/duplicate file IDs/);
 const invalid=structuredClone(current);invalid.files[0].name='bad\u0000name';assert.throws(()=>parseCatalogImport(invalid,current),/filename/);
});
