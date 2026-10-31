import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  DomainError, catalogExport, cleanName, createFolder, deleteFolder, emptyCatalog, listFiles, owned,
  parseRange, patchFile, patchFolder, removeCatalogFile, setTrashed, transition, validateOffset,
  type CatalogState, type FileRecord, type Transfer
} from '../src/index.js';

const alice = 'user-alice'; const bob = 'user-bob';
const file = (userId = alice, extra: Partial<FileRecord> = {}): FileRecord => ({ id: randomUUID(), user_id: userId, folder_id: null, name: 'lecture.pdf', original_name: 'lecture.pdf', mime: 'application/pdf', bytes: 128, sha256: null, favorite: false, tags: [], created_at: '2026-10-30T00:00:00.000Z', updated_at: '2026-10-30T00:00:00.000Z', trashed_at: null, availability: 'local', version: 1, ...extra });
const transfer = (extra: Partial<Transfer> = {}): Transfer => ({ id: randomUUID(), user_id: alice, operation_id: randomUUID(), file_id: null, folder_id: null, name: 'test', mime: 'application/octet-stream', expected_bytes: 10, stage_bytes: 0, state: 'CREATED', attempts: 0, error_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), sha256: null, ...extra });
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

test('known resource IDs do not cross tenant boundary on reads, mutation or export', () => {
  const state = emptyCatalog(); const bobsFile = file(bob); state.files.push(bobsFile);
  const bobsFolder = createFolder(state, bob, { name: 'Private' });
  assert.throws(() => owned(state.files, alice, bobsFile.id), code('NOT_FOUND'));
  assert.throws(() => patchFile(state, alice, bobsFile.id, { name: 'stolen' }, 1), code('NOT_FOUND'));
  assert.throws(() => createFolder(state, alice, { name: 'child', parent_id: bobsFolder.id }), code('NOT_FOUND'));
  assert.deepEqual(listFiles(state, alice, {}).items, []);
  assert.deepEqual((catalogExport(state, alice) as any).files, []);
});

test('folder cycles and moves that make descendant depth exceed ten are rejected', () => {
  const state = emptyCatalog();
  const a = createFolder(state, alice, { name: 'A' });
  const b = createFolder(state, alice, { name: 'B', parent_id: a.id });
  assert.throws(() => patchFolder(state, alice, a.id, { parent_id: b.id }, a.version), code('FOLDER_CYCLE'));
  let parent = createFolder(state, alice, { name: 'level1' });
  for (let index = 2; index <= 10; index++) parent = createFolder(state, alice, { name: `level${index}`, parent_id: parent.id });
  assert.throws(() => createFolder(state, alice, { name: 'level11', parent_id: parent.id }), code('FOLDER_DEPTH'));
  assert.throws(() => patchFolder(state, alice, a.id, { parent_id: parent.id }, a.version), code('FOLDER_DEPTH'));
});

test('duplicate folder names conflict within a parent; identical names across parents remain usable', () => {
  const state = emptyCatalog(); const folder = createFolder(state, alice, { name: 'Photos' });
  assert.throws(() => createFolder(state, alice, { name: 'photos' }), code('NAME_CONFLICT'));
  assert.doesNotThrow(() => createFolder(state, alice, { name: 'Photos', parent_id: folder.id }));
});

test('optimistic versions reject stale metadata changes without touching remote identity', () => {
  const state = emptyCatalog(); const original = file(alice, { remote_reference: { message_id: '9007199254740993', peer_id: '100' } }); state.files.push(original);
  const renamed = patchFile(state, alice, original.id, { name: 'renamed.pdf' }, 1);
  assert.equal(renamed.original_name, 'lecture.pdf'); assert.equal(renamed.version, 2);
  assert.equal(renamed.remote_reference!.message_id, '9007199254740993');
  assert.throws(() => patchFile(state, alice, original.id, { favorite: true }, 1), code('VERSION_CONFLICT'));
});

test('trash is reversible and catalog removal makes a tombstone without provider deletion', () => {
  const state = emptyCatalog(); const item = file(alice, { remote_reference: { message_id: '42', peer_id: '100' } }); state.files.push(item);
  setTrashed(state, alice, item.id, true); assert.equal(listFiles(state, alice, {}).items.length, 0);
  assert.equal(listFiles(state, alice, { trash: true }).items.length, 1);
  setTrashed(state, alice, item.id, false); assert.equal(item.trashed_at, null);
  removeCatalogFile(state, alice, item.id); assert.equal(state.files.length, 0); assert.equal(state.tombstones[0].remote_reference?.message_id, '42');
});

test('missing remote originals cannot be falsely restored', () => {
  const state = emptyCatalog(); const item = file(alice, { availability: 'unavailable', trashed_at: new Date().toISOString() }); state.files.push(item);
  assert.throws(() => setTrashed(state, alice, item.id, false), code('REMOTE_FILE_MISSING'));
});

test('folder removal moves nested files to root or app trash without deleting other tenants', () => {
  const state = emptyCatalog(); const root = createFolder(state, alice, { name: 'A' }); const nested = createFolder(state, alice, { name: 'B', parent_id: root.id });
  const item = file(alice, { folder_id: nested.id }); state.files.push(item, file(bob));
  const pending = transfer({ folder_id: nested.id }); state.transfers.push(pending);
  deleteFolder(state, alice, root.id, 'trash', root.version);
  assert.equal(state.folders.length, 0); assert.equal(item.folder_id, null); assert.ok(item.trashed_at); assert.equal(state.files.length, 2);
  assert.equal(pending.folder_id, null);
});

test('catalog removal clears transfer links so later local cancellation still works', () => {
  const state = emptyCatalog(); const item = file(); const pending = transfer({ state: 'QUEUED', file_id: item.id }); state.files.push(item); state.transfers.push(pending);
  removeCatalogFile(state, alice, item.id); assert.equal(pending.file_id, null);
  transition(pending, 'CANCEL_REQUESTED'); transition(pending, 'CANCELLED'); assert.equal(pending.state, 'CANCELLED');
});

test('stable cursor pagination does not skip or repeat equal timestamp rows', () => {
  const state = emptyCatalog(); state.files.push(...Array.from({ length: 11 }, () => file()));
  const ids: string[] = []; let cursor: string | undefined;
  do { const page = listFiles(state, alice, { limit: 3, cursor }); ids.push(...page.items.map(f => f.id)); cursor = page.next_cursor ?? undefined; } while (cursor);
  assert.equal(ids.length, 11); assert.equal(new Set(ids).size, 11);
  assert.throws(() => listFiles(state, alice, { cursor: 'not-json' }), code('INVALID_CURSOR'));
});

test('range handling supports open/suffix/clamped ranges and rejects invalid boundaries', () => {
  assert.deepEqual(parseRange(undefined, 10), { start: 0, end: 9, partial: false });
  assert.deepEqual(parseRange('bytes=2-4', 10), { start: 2, end: 4, partial: true });
  assert.deepEqual(parseRange('bytes=8-', 10), { start: 8, end: 9, partial: true });
  assert.deepEqual(parseRange('bytes=-4', 10), { start: 6, end: 9, partial: true });
  assert.deepEqual(parseRange('bytes=8-99', 10), { start: 8, end: 9, partial: true });
  for (const header of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=1-2,4-5', 'bytes=-', 'items=0-1']) assert.throws(() => parseRange(header, 10), code('RANGE_NOT_SATISFIABLE'));
  assert.throws(() => parseRange('bytes=0-', 0), code('RANGE_NOT_SATISFIABLE'));
});

test('transfer completion requires a confirmed provider reference and unknown sends only reconcile', () => {
  const item = transfer({ state: 'SENDING' });
  assert.throws(() => transition(item, 'COMPLETED', { message_id: '1', peer_id: '2' }), code('INVALID_TRANSITION'));
  transition(item, 'RECONCILING');
  assert.throws(() => transition(item, 'QUEUED'), code('INVALID_TRANSITION'));
  assert.throws(() => transition(item, 'COMPLETED'), code('UNCONFIRMED_UPLOAD'));
  transition(item, 'COMPLETED', { message_id: '1', peer_id: '2' });
  assert.equal(item.state, 'COMPLETED');
});

test('upload offsets reject repeats, oversize chunks and bytes after staging closes', () => {
  const item = transfer({ stage_bytes: 4, state: 'STAGING' });
  assert.doesNotThrow(() => validateOffset(item, 4, 6));
  assert.throws(() => validateOffset(item, 0, 6), code('OFFSET_MISMATCH'));
  assert.throws(() => validateOffset(item, 4, 7), code('INVALID_CHUNK'));
  item.state = 'QUEUED'; assert.throws(() => validateOffset(item, 4, 1), code('UPLOAD_CLOSED'));
});

test('malicious filenames and control characters are rejected; Bangla is preserved', () => {
  for (const name of ['../private', 'x\\y', 'name\r\nInjected: yes', '\u0000test', '\uD800', '.', ' ']) assert.throws(() => cleanName(name), code('INVALID_NAME'));
  assert.equal(cleanName('  আমার ছবি.png  '), 'আমার ছবি.png');
  assert.equal(cleanName('photo🌤️.png'), 'photo🌤️.png');
});

test('tags use the same 64-character limit as the normalized database', () => {
  const state=emptyCatalog();const item=file();state.files.push(item);
  assert.throws(()=>patchFile(state,alice,item.id,{tags:['x'.repeat(65)]},1),code('INVALID_TAGS'));
  assert.doesNotThrow(()=>patchFile(state,alice,item.id,{tags:['x'.repeat(64)]},1));
});
