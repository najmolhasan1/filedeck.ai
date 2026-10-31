import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApi } from '../src/app.js';

test('API local feasibility: original-byte staging, offsets, idempotency, range and reversible organization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloudnest-api-'));
  const { app } = await createApi({ demo: true, directory, logger: false });
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const request = (path: string, init: RequestInit = {}) => fetch(origin + '/v1' + path, init);
  const json = (body: unknown, key = randomUUID()) => ({ 'Content-Type': 'application/json', 'Idempotency-Key': key });
  try {
    const health = await request('/health'); assert.equal(health.status, 200); assert.equal((await health.json()).mode, 'local-demo');
    const login = await request('/auth/telegram/start', { method: 'POST', headers: json({}), body: JSON.stringify({ phone: '+880123456789', code: '123456' }) });
    assert.equal(login.status, 503); assert.equal((await login.json()).error.code, 'ADAPTER_NOT_CONFIGURED');
    const key = randomUUID();
    let response = await request('/folders', { method: 'POST', headers: json({}, key), body: JSON.stringify({ name: 'University' }) });
    assert.equal(response.status, 201); const folder = await response.json();
    response = await request('/folders', { method: 'POST', headers: json({}, key), body: JSON.stringify({ name: 'University' }) });
    assert.equal((await response.json()).id, folder.id);
    response = await request('/folders', { method: 'POST', headers: json({}, key), body: JSON.stringify({ name: 'Changed' }) });
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'IDEMPOTENCY_CONFLICT');
    response = await request('/folders/' + folder.id, { method: 'PATCH', headers: { ...json({}), 'If-Match': '1' }, body: JSON.stringify({ name: 'University archive' }) });
    assert.equal(response.status, 200);
    response = await request('/folders', { method: 'POST', headers: json({}, key), body: JSON.stringify({ name: 'University' }) });
    const replay = await response.json(); assert.equal(replay.name, 'University'); assert.equal(replay.version, 1);
    response = await request('/files/bulk', { method: 'POST', headers: json({}), body: JSON.stringify({ items: [null, { id: 'bad', version: 1, patch: {} }] }) });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).items.map((item: any) => item.ok), [false, false]);
    const bytes = Buffer.from('Original bytes. No image compression. বাংলা\n');
    response = await request('/uploads', { method: 'POST', headers: json({}), body: JSON.stringify({ name: 'lecture.txt', mime: 'text/plain', bytes: bytes.length, folder_id: folder.id }) });
    assert.equal(response.status, 201); const transfer = await response.json();
    const checksum = createHash('sha256').update(bytes).digest('base64');
    response = await request('/uploads/' + transfer.id, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0', 'Upload-Checksum': 'sha256 ' + checksum }, body: bytes });
    assert.equal(response.status, 204); assert.equal(response.headers.get('Upload-Offset'), String(bytes.length));
    response = await request('/uploads/' + transfer.id, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' }, body: bytes });
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'OFFSET_MISMATCH');
    response = await request('/uploads/' + transfer.id, { method: 'HEAD' });
    assert.equal(response.status, 204); assert.equal(response.headers.get('Upload-Offset'), String(bytes.length));
    response = await request('/uploads/' + transfer.id + '/commit', { method: 'POST', headers: json({}), body: '{}' });
    assert.equal(response.status, 202); const committed = await response.json();
    assert.equal(committed.telegram_confirmed, false); assert.equal(committed.transfer.state, 'QUEUED'); assert.equal(committed.file.availability, 'local');
    assert.equal(committed.file.sha256, createHash('sha256').update(bytes).digest('hex'));
    response = await request('/files/' + committed.file.id + '/content');
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.match(response.headers.get('Content-Disposition')!, /^attachment/); assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
    response = await request('/files/' + committed.file.id + '/content', { headers: { Range: 'bytes=2-8' } });
    assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(2, 9));
    response = await request('/files/' + committed.file.id + '/content', { headers: { Range: 'bytes=999999-' } });
    assert.equal(response.status, 416); assert.equal(response.headers.get('Content-Range'), `bytes */${bytes.length}`);
    response = await request('/files/' + committed.file.id, { method: 'PATCH', headers: { ...json({}), 'If-Match': '1' }, body: JSON.stringify({ name: 'Lecture notes.txt', favorite: true }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).version, 2);
    response = await request('/files/' + committed.file.id, { method: 'PATCH', headers: { ...json({}), 'If-Match': '1' }, body: JSON.stringify({ name: 'stale.txt' }) });
    assert.equal(response.status, 409);
    response = await request('/files/' + committed.file.id + '/trash', { method: 'POST', headers: json({}), body: '{}' });
    assert.equal(response.status, 200);
    response = await request('/files'); assert.equal((await response.json()).items.length, 0);
    response = await request('/files/' + committed.file.id + '/restore', { method: 'POST', headers: json({}), body: '{}' }); assert.equal(response.status, 200);
    response = await request('/exports/catalog'); const exported = await response.json(); assert.equal(exported.schema_version, 1); assert.equal(exported.files.length, 1); assert.equal(exported.files[0].local_blob_id, undefined);
    response = await request('/files/' + randomUUID()); assert.equal(response.status, 404);
    response = await request('/files/' + committed.file.id + '/delete-remote', { method: 'POST', headers: json({}), body: '{}' }); assert.equal(response.status, 503);
    response = await request('/folders', { method: 'POST', headers: { ...json({}), Origin: 'https://evil.test' }, body: JSON.stringify({ name: 'CSRF' }) }); assert.equal(response.status, 403);
    const stored = await readFile(join(directory, 'catalog.json'), 'utf8'); assert.ok(!stored.includes('+880123456789')); assert.ok(!stored.includes('123456'));
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('default API fails closed and does not trust claimed user headers', async () => {
  const { app } = await createApi({ demo: false, logger: false });
  await app.listen(0, '127.0.0.1'); const origin = await app.getUrl();
  try {
    const response = await fetch(origin + '/v1/files', { headers: { 'X-User-Id': 'claimed-admin', Authorization: 'Bearer unverified' } });
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'AUTH_NOT_CONFIGURED');
  } finally { await app.close(); }
});

test('checksum failures never advance staged offset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloudnest-checksum-'));
  const { app } = await createApi({ demo: true, directory, logger: false });
  await app.listen(0, '127.0.0.1'); const origin = await app.getUrl();
  try {
    const initialized = await fetch(origin + '/v1/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ name: 'a.txt', bytes: 4 }) });
    const transfer = await initialized.json();
    const response = await fetch(origin + '/v1/uploads/' + transfer.id, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0', 'Upload-Checksum': 'sha256 ' + Buffer.alloc(32).toString('base64') }, body: Buffer.from('test') });
    assert.equal(response.status, 460);
    const head = await fetch(origin + '/v1/uploads/' + transfer.id, { method: 'HEAD' }); assert.equal(head.headers.get('Upload-Offset'), '0');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
