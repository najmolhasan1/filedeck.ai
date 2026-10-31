import { randomUUID } from 'node:crypto';

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

export type Availability = 'local' | 'confirmed' | 'unavailable' | 'device-reported';
export type TransferState = 'CREATED' | 'STAGING' | 'STAGED' | 'QUEUED' | 'SENDING' | 'VERIFYING' | 'COMPLETED' | 'WAITING_PROVIDER' | 'WAITING_NETWORK' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'RETRY_SCHEDULED' | 'RECONCILING' | 'NEEDS_ATTENTION' | 'FAILED';

export interface Folder {
  id: string; user_id: string; parent_id: string | null; name: string; color: string;
  version: number; trashed_at: string | null; created_at: string; updated_at: string;
}
export interface FileRecord {
  id: string; user_id: string; folder_id: string | null; name: string; original_name: string;
  mime: string; bytes: number; sha256: string | null; favorite: boolean; tags: string[];
  created_at: string; updated_at: string; trashed_at: string | null; availability: Availability;
  version: number; local_blob_id?: string; remote_reference?: Record<string, string>;
}
export interface Transfer {
  id: string; user_id: string; operation_id: string; file_id: string | null; folder_id: string | null;
  name: string; mime: string; expected_bytes: number; stage_bytes: number; state: TransferState;
  attempts: number; error_code: string | null; created_at: string; updated_at: string; sha256: string | null;
  retry_after?: string | null; remote_result?: Record<string, string> | null; account_key?: string;
  verified_chunks?: { offset: number; length: number; checksum: string }[];
}
export interface CatalogState {
  schema_version: 1;
  folders: Folder[];
  files: FileRecord[];
  transfers: Transfer[];
  tombstones: { user_id: string; file_id: string; remote_reference?: Record<string, string>; created_at: string }[];
  idempotency: { user_id: string; scope: string; key: string; digest: string; result: unknown; expires_at: string }[];
}
export const emptyCatalog = (): CatalogState => ({ schema_version: 1, folders: [], files: [], transfers: [], tombstones: [], idempotency: [] });
export const MAX_FILE_BYTES = 500 * 1024 * 1024;

export function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw new DomainError('INVALID_NAME', 'A name is required.');
  const name = value.trim().normalize('NFC');
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f\uD800-\uDFFF/\\]/u.test(name) || name === '.' || name === '..') {
    throw new DomainError('INVALID_NAME', 'Use a name from 1 to 255 characters without slashes or control characters.');
  }
  return name;
}

export function owned<T extends { id: string; user_id: string }>(rows: T[], userId: string, id: string): T {
  const row = rows.find(item => item.id === id && item.user_id === userId);
  if (!row) throw new DomainError('NOT_FOUND', 'This item is unavailable.', 404);
  return row;
}

function folderDepth(state: CatalogState, userId: string, id: string | null): number {
  const seen = new Set<string>();
  let depth = 0;
  while (id) {
    if (seen.has(id)) throw new DomainError('FOLDER_CYCLE', 'A folder cannot contain itself.');
    seen.add(id);
    const folder = owned(state.folders, userId, id);
    if (folder.trashed_at) throw new DomainError('INVALID_FOLDER', 'Choose an active folder.');
    id = folder.parent_id;
    depth++;
  }
  return depth;
}

function checkFolderDestination(state: CatalogState, userId: string, id: string | null, parentId: string | null): void {
  let current = parentId;
  const seen = new Set<string>();
  while (current) {
    if (current === id) throw new DomainError('FOLDER_CYCLE', 'A folder cannot be moved into itself or its descendants.');
    if (seen.has(current)) throw new DomainError('FOLDER_CYCLE', 'This folder hierarchy needs repair before it can be changed.');
    seen.add(current);
    current = owned(state.folders, userId, current).parent_id;
  }
  const targetDepth = folderDepth(state, userId, parentId) + 1;
  let subtreeHeight = 0;
  if (id) {
    const visit = (folderId: string, height: number): void => {
      subtreeHeight = Math.max(subtreeHeight, height);
      for (const child of state.folders.filter(f => f.user_id === userId && f.parent_id === folderId && !f.trashed_at)) visit(child.id, height + 1);
    };
    visit(id, 0);
  }
  if (targetDepth + subtreeHeight > 10) throw new DomainError('FOLDER_DEPTH', 'Folders can be nested up to 10 levels.');
}

function checkDuplicateFolder(state: CatalogState, userId: string, name: string, parentId: string | null, exceptId?: string): void {
  if (state.folders.some(f => f.user_id === userId && f.parent_id === parentId && !f.trashed_at && f.id !== exceptId && f.name.toLocaleLowerCase('en') === name.toLocaleLowerCase('en'))) {
    throw new DomainError('NAME_CONFLICT', 'A folder with this name already exists here.', 409);
  }
}

export function requireVersion(row: { version: number }, expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== row.version) throw new DomainError('VERSION_CONFLICT', 'This item changed. Refresh it and try again.', 409);
}

export function createFolder(state: CatalogState, userId: string, input: { name: unknown; parent_id?: string | null; color?: string }): Folder {
  const name = cleanName(input.name);
  const parentId = input.parent_id ?? null;
  checkFolderDestination(state, userId, null, parentId);
  checkDuplicateFolder(state, userId, name, parentId);
  const now = new Date().toISOString();
  const folder: Folder = { id: randomUUID(), user_id: userId, parent_id: parentId, name, color: /^#[a-f0-9]{6}$/i.test(input.color ?? '') ? input.color! : '#319b7a', version: 1, trashed_at: null, created_at: now, updated_at: now };
  state.folders.push(folder);
  return folder;
}

export function patchFolder(state: CatalogState, userId: string, id: string, input: { name?: unknown; parent_id?: string | null; color?: string }, expectedVersion: number): Folder {
  const folder = owned(state.folders, userId, id);
  requireVersion(folder, expectedVersion);
  const name = input.name === undefined ? folder.name : cleanName(input.name);
  const parentId = input.parent_id === undefined ? folder.parent_id : input.parent_id;
  checkFolderDestination(state, userId, id, parentId);
  checkDuplicateFolder(state, userId, name, parentId, id);
  Object.assign(folder, { name, parent_id: parentId, version: folder.version + 1, updated_at: new Date().toISOString() });
  if (input.color && /^#[a-f0-9]{6}$/i.test(input.color)) folder.color = input.color;
  return folder;
}

export function deleteFolder(state: CatalogState, userId: string, id: string, mode: 'root' | 'trash', expectedVersion: number): void {
  const folder = owned(state.folders, userId, id);
  requireVersion(folder, expectedVersion);
  const descendantIds = new Set([folder.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of state.folders) if (f.user_id === userId && f.parent_id && descendantIds.has(f.parent_id) && !descendantIds.has(f.id)) { descendantIds.add(f.id); changed = true; }
  }
  const now = new Date().toISOString();
  for (const f of state.files.filter(f => f.user_id === userId && f.folder_id && descendantIds.has(f.folder_id))) {
    f.folder_id = null;
    if (mode === 'trash') f.trashed_at = now;
    f.updated_at = now; f.version++;
  }
  // Uploads selected this virtual destination before it was removed. Keep their
  // original bytes and rehome their eventual catalog entry instead of orphaning it.
  for (const transfer of state.transfers.filter(t => t.user_id === userId && t.folder_id && descendantIds.has(t.folder_id))) {
    transfer.folder_id = null; transfer.updated_at = now;
  }
  state.folders = state.folders.filter(f => f.user_id !== userId || !descendantIds.has(f.id));
}

export function patchFile(state: CatalogState, userId: string, id: string, input: { name?: unknown; folder_id?: string | null; favorite?: boolean; tags?: string[] }, expectedVersion: number): FileRecord {
  const file = owned(state.files, userId, id);
  requireVersion(file, expectedVersion);
  if (input.name !== undefined) file.name = cleanName(input.name);
  if (input.folder_id !== undefined) {
    folderDepth(state, userId, input.folder_id);
    file.folder_id = input.folder_id;
  }
  if (input.favorite !== undefined) {
    if (typeof input.favorite !== 'boolean') throw new DomainError('INVALID_INPUT', 'Favorite must be true or false.');
    file.favorite = input.favorite;
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 20) throw new DomainError('INVALID_TAGS', 'Use up to 20 tags.');
    const tags = input.tags.map(cleanName);
    if (tags.some(tag => tag.length > 64)) throw new DomainError('INVALID_TAGS', 'Each tag can contain up to 64 characters.');
    file.tags = [...new Set(tags)];
  }
  file.version++; file.updated_at = new Date().toISOString();
  return file;
}

export function setTrashed(state: CatalogState, userId: string, id: string, trashed: boolean): FileRecord {
  const file = owned(state.files, userId, id);
  if (!trashed && file.availability === 'unavailable') throw new DomainError('REMOTE_FILE_MISSING', 'The original is unavailable; restoring the catalog cannot restore its bytes.', 409);
  file.trashed_at = trashed ? new Date().toISOString() : null;
  file.version++; file.updated_at = new Date().toISOString();
  return file;
}

export function removeCatalogFile(state: CatalogState, userId: string, id: string): void {
  const file = owned(state.files, userId, id);
  state.tombstones.push({ user_id: userId, file_id: id, remote_reference: file.remote_reference, created_at: new Date().toISOString() });
  state.files = state.files.filter(f => f.id !== id || f.user_id !== userId);
  for (const transfer of state.transfers.filter(t => t.user_id === userId && t.file_id === id)) transfer.file_id = null;
}

export interface FileQuery { q?: string; type?: string; folder_id?: string | null; favorite?: boolean; trash?: boolean; after?: string; before?: string; cursor?: string; limit?: number }
export function listFiles(state: CatalogState, userId: string, query: FileQuery): { items: FileRecord[]; next_cursor: string | null } {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('INVALID_LIMIT', 'Page size must be between 1 and 100.');
  let items = state.files.filter(f => f.user_id === userId && Boolean(f.trashed_at) === Boolean(query.trash));
  if (query.q) items = items.filter(f => f.name.toLocaleLowerCase().includes(query.q!.toLocaleLowerCase()));
  if (query.type) items = items.filter(f => query.type === 'documents' ? !/^(image|video|audio)\//.test(f.mime) : f.mime.startsWith(query.type + '/'));
  if (query.folder_id !== undefined) { if (query.folder_id) owned(state.folders, userId, query.folder_id); items = items.filter(f => f.folder_id === query.folder_id); }
  if (query.favorite !== undefined) items = items.filter(f => f.favorite === query.favorite);
  if (query.after) { if (Number.isNaN(Date.parse(query.after))) throw new DomainError('INVALID_DATE', 'Choose a valid start date.'); const date = new Date(query.after).toISOString(); items = items.filter(f => f.created_at >= date); }
  if (query.before) { if (Number.isNaN(Date.parse(query.before))) throw new DomainError('INVALID_DATE', 'Choose a valid end date.'); const date = new Date(query.before).toISOString(); items = items.filter(f => f.created_at <= date); }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  if (query.cursor) {
    let cursor: { created_at: string; id: string };
    try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()); if (typeof cursor.created_at !== 'string' || typeof cursor.id !== 'string') throw new Error(); }
    catch { throw new DomainError('INVALID_CURSOR', 'This page cursor is invalid.'); }
    items = items.filter(f => f.created_at < cursor.created_at || (f.created_at === cursor.created_at && f.id < cursor.id));
  }
  const page = items.slice(0, limit);
  const last = page.at(-1);
  return { items: page, next_cursor: items.length > limit && last ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString('base64url') : null };
}

const transitions: Record<TransferState, TransferState[]> = {
  CREATED: ['STAGING', 'CANCEL_REQUESTED', 'FAILED'], STAGING: ['STAGED', 'WAITING_NETWORK', 'CANCEL_REQUESTED', 'FAILED'],
  STAGED: ['QUEUED', 'CANCEL_REQUESTED'], QUEUED: ['SENDING', 'WAITING_PROVIDER', 'WAITING_NETWORK', 'CANCEL_REQUESTED', 'FAILED'],
  SENDING: ['VERIFYING', 'RECONCILING', 'WAITING_PROVIDER', 'WAITING_NETWORK', 'CANCEL_REQUESTED', 'FAILED'],
  VERIFYING: ['COMPLETED', 'RECONCILING', 'CANCEL_REQUESTED', 'FAILED'], COMPLETED: [],
  WAITING_PROVIDER: ['QUEUED', 'CANCEL_REQUESTED', 'FAILED'], WAITING_NETWORK: ['STAGING', 'QUEUED', 'CANCEL_REQUESTED', 'FAILED'],
  CANCEL_REQUESTED: ['CANCELLED', 'RECONCILING', 'COMPLETED'], CANCELLED: [], RETRY_SCHEDULED: ['QUEUED', 'CANCEL_REQUESTED'],
  RECONCILING: ['COMPLETED', 'NEEDS_ATTENTION', 'CANCEL_REQUESTED'], NEEDS_ATTENTION: ['RECONCILING', 'CANCEL_REQUESTED'], FAILED: ['RETRY_SCHEDULED', 'CANCEL_REQUESTED']
};
export function transition(transfer: Transfer, next: TransferState, confirmedRemoteReference?: Record<string, string>): void {
  if (!transitions[transfer.state].includes(next)) throw new DomainError('INVALID_TRANSITION', `A ${transfer.state.toLowerCase()} transfer cannot become ${next.toLowerCase()}.`, 409);
  if (next === 'COMPLETED' && (!confirmedRemoteReference?.message_id || !confirmedRemoteReference?.peer_id)) throw new DomainError('UNCONFIRMED_UPLOAD', 'A verified Telegram attachment is required before success.', 409);
  if (next === 'COMPLETED') transfer.remote_result = confirmedRemoteReference;
  transfer.state = next; transfer.updated_at = new Date().toISOString();
}

export function parseRange(header: string | undefined, total: number): { start: number; end: number; partial: boolean } {
  if (!header) return { start: 0, end: total - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || total === 0) throw new DomainError('RANGE_NOT_SATISFIABLE', 'This byte range is unavailable.', 416);
  let start: number; let end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new DomainError('RANGE_NOT_SATISFIABLE', 'This byte range is unavailable.', 416); start = Math.max(0, total - suffix); end = total - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : total - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || start > end) throw new DomainError('RANGE_NOT_SATISFIABLE', 'This byte range is unavailable.', 416);
  return { start, end: Math.min(end, total - 1), partial: true };
}

export function validateOffset(transfer: Transfer, offset: number, chunkBytes: number): void {
  if (!Number.isSafeInteger(offset) || offset !== transfer.stage_bytes) throw new DomainError('OFFSET_MISMATCH', 'Resume from the server upload offset.', 409);
  if (chunkBytes <= 0 || chunkBytes > 8 * 1024 * 1024 || offset + chunkBytes > transfer.expected_bytes) throw new DomainError('INVALID_CHUNK', 'The upload chunk has an invalid size.');
  if (!['CREATED', 'STAGING'].includes(transfer.state)) throw new DomainError('UPLOAD_CLOSED', 'This upload no longer accepts bytes.', 409);
}

export function catalogExport(state: CatalogState, userId: string): object {
  return { schema_version: 1, exported_at: new Date().toISOString(), organization_requires_metadata: true,
    folders: state.folders.filter(f => f.user_id === userId).map(({ user_id: _, ...f }) => f),
    files: state.files.filter(f => f.user_id === userId).map(({ user_id: _, local_blob_id: __, ...f }) => f),
    tombstones: state.tombstones.filter(f => f.user_id === userId).map(({ user_id: _, ...f }) => f) };
}
