import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DomainError, type CatalogState, type FileRecord, type Folder, type Transfer } from '@cloudnest/domain';
import type { CatalogRepository } from './repository.js';
import { withTenant } from './auth-store.js';

const iso = (value: Date | string): string => new Date(value).toISOString();
const nullableIso = (value: Date | string | null): string | null => value ? iso(value) : null;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const safeNumber = (value: string | number): number => { const number = Number(value); if (!Number.isSafeInteger(number)) throw new DomainError('CATALOG_INCONSISTENT', 'Catalog numbers exceed the supported exact range.', 503); return number; };
const dbAvailability = (value: FileRecord['availability']): string => value === 'local' ? 'local_only' : value === 'device-reported' ? 'device_reported' : value;
const availability = (value: string): FileRecord['availability'] => value === 'local_only' ? 'local' : value === 'device_reported' ? 'device-reported' : value === 'confirmed' ? 'confirmed' : 'unavailable';

/** Normalized PostgreSQL persistence. Every call is scoped to a previously authenticated user. */
export class PgCatalogRepository implements CatalogRepository {
  constructor(readonly pool: Pool, readonly userId: string) {}

  async initialize(): Promise<void> {
    await withTenant(this.pool, this.userId, async client => {
      const result = await client.query('SELECT id FROM users WHERE id=$1 AND status=\'active\'', [this.userId]);
      if (!result.rows[0]) throw new DomainError('AUTH_EXPIRED', 'This account is unavailable.', 401);
      await client.query('SELECT remote_reference,local_blob_id FROM files LIMIT 0');
    });
  }
  async read<T>(callback: (state: CatalogState) => T | Promise<T>): Promise<T> {
    return withTenant(this.pool, this.userId, async client => {
      // A single snapshot prevents a read from combining two catalog versions.
      return callback(await this.load(client));
    }, { isolation: 'REPEATABLE READ' });
  }
  async transaction<T>(callback: (state: CatalogState) => T | Promise<T>): Promise<T> {
    return withTenant(this.pool, this.userId, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [this.userId]);
      const before = await this.load(client);
      const state = structuredClone(before);
      const result = await callback(state);
      this.validateScope(state);
      await this.persist(client, before, state);
      return result;
    });
  }
  private validateScope(state: CatalogState): void {
    for (const rows of [state.folders, state.files, state.transfers, state.tombstones, state.idempotency]) {
      if (rows.some(row => row.user_id !== this.userId)) throw new DomainError('PERMISSION_DENIED', 'Catalog ownership cannot change.', 403);
    }
    for (const rows of [state.folders, state.files, state.transfers]) {
      if (new Set(rows.map(row => row.id)).size !== rows.length) throw new DomainError('INVALID_CATALOG', 'Catalog item identifiers must be unique.');
    }
  }
  private async load(client: PoolClient): Promise<CatalogState> {
    const user = this.userId;
    const [folders, files, transfers, tags, tombstones, idempotency, chunks] = await Promise.all([
      client.query('SELECT * FROM folders WHERE user_id=$1 ORDER BY id', [user]),
      client.query('SELECT f.*,s.remote_peer_id,u.telegram_user_id FROM files f LEFT JOIN storage_chats s ON s.id=f.storage_chat_id AND s.user_id=f.user_id JOIN users u ON u.id=f.user_id WHERE f.user_id=$1 ORDER BY f.id', [user]),
      client.query('SELECT * FROM transfers WHERE user_id=$1 ORDER BY id', [user]),
      client.query('SELECT ft.file_id,t.name FROM file_tags ft JOIN tags t ON t.id=ft.tag_id AND t.user_id=ft.user_id WHERE ft.user_id=$1 ORDER BY t.name', [user]),
      client.query('SELECT * FROM catalog_tombstones WHERE user_id=$1 AND file_id IS NOT NULL ORDER BY file_id', [user]),
      client.query('SELECT * FROM idempotency_keys WHERE user_id=$1 AND expiry>now() ORDER BY route_scope,key', [user]),
      client.query('SELECT c.*,u.transfer_id FROM upload_chunks c JOIN uploads u ON u.id=c.upload_id AND u.user_id=c.user_id WHERE c.user_id=$1 AND c.state=\'verified\' ORDER BY c.offset_bytes', [user])
    ]);
    return {
      schema_version: 1,
      folders: folders.rows.map(row => ({ id: row.id, user_id: row.user_id, parent_id: row.parent_id, name: row.name, color: row.color, version: safeNumber(row.version), trashed_at: nullableIso(row.trashed_at), created_at: iso(row.created_at), updated_at: iso(row.updated_at) })),
      files: files.rows.map(row => ({ id: row.id, user_id: row.user_id, folder_id: row.folder_id, name: row.display_name, original_name: row.original_name, mime: row.mime, bytes: safeNumber(row.bytes), sha256: row.sha256, favorite: row.favorite, tags: tags.rows.filter(tag => tag.file_id === row.id).map(tag => tag.name), created_at: iso(row.created_at), updated_at: iso(row.updated_at), trashed_at: nullableIso(row.trashed_at), availability: availability(row.availability), version: safeNumber(row.version), ...(row.local_blob_id ? { local_blob_id: row.local_blob_id } : {}), ...(row.remote_reference ? { remote_reference: row.remote_reference } : row.remote_message_id && row.remote_peer_id ? { remote_reference: { telegramUserId: String(row.telegram_user_id), peerId: String(row.remote_peer_id), messageId: String(row.remote_message_id), attachmentIndex: String(row.attachment_index) } } : {}) })),
      transfers: transfers.rows.map(row => ({ id: row.id, user_id: row.user_id, operation_id: row.operation_id, file_id: row.file_id, folder_id: row.folder_id, name: row.name, mime: row.mime, expected_bytes: safeNumber(row.expected_bytes), stage_bytes: safeNumber(row.stage_bytes), state: row.state, attempts: row.attempts, error_code: row.error_code, created_at: iso(row.created_at), updated_at: iso(row.updated_at), sha256: row.sha256, ...(row.account_key ? {account_key:row.account_key} : {}), retry_after: nullableIso(row.retry_after), remote_result: row.remote_result, verified_chunks: chunks.rows.filter(chunk => chunk.transfer_id === row.id).map(chunk => ({ offset: safeNumber(chunk.offset_bytes), length: chunk.length_bytes, checksum: chunk.checksum })) })),
      tombstones: tombstones.rows.map(row => ({ user_id: row.user_id, file_id: row.file_id, ...(row.remote_reference ? { remote_reference: row.remote_reference } : {}), created_at: iso(row.created_at) })),
      idempotency: idempotency.rows.map(row => ({ user_id: row.user_id, scope: row.route_scope, key: row.key, digest: row.request_digest, result: row.response_ref, expires_at: iso(row.expiry) }))
    };
  }
  private folderDepth(folders: Folder[], folder: Folder): number {
    let depth = 0; let current: Folder | undefined = folder; const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id)) throw new DomainError('FOLDER_CYCLE', 'A folder cannot contain itself.');
      seen.add(current.id); depth++;
      if (depth > 10) throw new DomainError('FOLDER_DEPTH', 'Folders can be nested up to 10 levels.');
      if (current.parent_id && !folders.some(f => f.id === current!.parent_id)) throw new DomainError('INVALID_FOLDER', 'A parent folder is unavailable.');
      current = folders.find(f => f.id === current!.parent_id);
    }
    return depth;
  }
  private async persist(client: PoolClient, before: CatalogState, state: CatalogState): Promise<void> {
    const user = this.userId;
    const oldFolders = new Map(before.folders.map(row => [row.id, row]));
    const changedFolders = state.folders.filter(row => !same(oldFolders.get(row.id), row));
    const removedFolderRows = before.folders.filter(row => !state.folders.some(next => next.id === row.id));
    // Temporarily detach and uniquely name changed rows so valid multi-folder
    // moves do not fail against intermediate names or hierarchy positions.
    for (const row of changedFolders.filter(row => oldFolders.has(row.id))) await client.query('UPDATE folders SET name=$1,parent_id=NULL WHERE id=$2 AND user_id=$3', [`.moving-${randomUUID()}`, row.id, user]);
    for (const row of removedFolderRows) await client.query('UPDATE folders SET name=$1,parent_id=NULL WHERE id=$2 AND user_id=$3', [`.removing-${randomUUID()}`, row.id, user]);
    changedFolders.sort((a, b) => this.folderDepth(state.folders, a) - this.folderDepth(state.folders, b));
    for (const row of changedFolders) {
      await client.query('INSERT INTO folders(id,user_id,parent_id,name,color,version,trashed_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET parent_id=EXCLUDED.parent_id,name=EXCLUDED.name,color=EXCLUDED.color,version=EXCLUDED.version,trashed_at=EXCLUDED.trashed_at,updated_at=EXCLUDED.updated_at WHERE folders.user_id=EXCLUDED.user_id', [row.id,user,row.parent_id,row.name,row.color,row.version,row.trashed_at,row.created_at,row.updated_at]);
    }
    const oldFiles = new Map(before.files.map(row => [row.id, row]));
    for (const row of state.files.filter(row => !same(oldFiles.get(row.id), row))) {
      const reference = row.remote_reference;
      const peerId = reference?.peerId ?? reference?.peer_id;
      const messageId = reference?.messageId ?? reference?.message_id;
      const telegramId = reference?.telegramUserId ?? reference?.telegram_user_id;
      let storageChatId: string | null = null;
      const index = Number(reference?.attachmentIndex ?? reference?.attachment_index ?? 0);
      if (peerId || messageId || row.availability === 'confirmed') {
        if (!peerId || !messageId || !/^-?\d{1,19}$/.test(peerId) || !/^[1-9]\d{0,18}$/.test(messageId) || !Number.isSafeInteger(index) || index < 0 || BigInt(peerId) < -9223372036854775808n || BigInt(peerId) > 9223372036854775807n || BigInt(messageId) > 9223372036854775807n) throw new DomainError('INVALID_REMOTE_REFERENCE', 'A verified remote attachment is required.');
        const selected = await client.query('SELECT s.id,s.status,u.telegram_user_id FROM storage_chats s JOIN users u ON u.id=s.user_id WHERE s.user_id=$1 AND s.remote_peer_id=$2', [user,peerId]);
        const chat = selected.rows[0];
        if (!chat || (telegramId && telegramId !== String(chat.telegram_user_id)) || (row.availability === 'confirmed' && !same(oldFiles.get(row.id)?.remote_reference, reference) && chat.status !== 'available')) throw new DomainError('PERMISSION_DENIED', 'The attachment does not belong to a selected account storage chat.', 403);
        storageChatId = chat.id;
      }
      if (row.tags.some(tag => tag.length > 64) || row.tags.length > 20) throw new DomainError('INVALID_TAGS', 'Use up to 20 tags of at most 64 characters.');
      await client.query('INSERT INTO files(id,user_id,folder_id,storage_chat_id,remote_message_id,attachment_index,display_name,original_name,mime,bytes,sha256,origin,availability,favorite,version,trashed_at,created_at,updated_at,local_blob_id,remote_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,\'web\',$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(id) DO UPDATE SET folder_id=EXCLUDED.folder_id,storage_chat_id=EXCLUDED.storage_chat_id,remote_message_id=EXCLUDED.remote_message_id,attachment_index=EXCLUDED.attachment_index,display_name=EXCLUDED.display_name,mime=EXCLUDED.mime,bytes=EXCLUDED.bytes,sha256=EXCLUDED.sha256,availability=EXCLUDED.availability,favorite=EXCLUDED.favorite,version=EXCLUDED.version,trashed_at=EXCLUDED.trashed_at,updated_at=EXCLUDED.updated_at,local_blob_id=EXCLUDED.local_blob_id,remote_reference=EXCLUDED.remote_reference WHERE files.user_id=EXCLUDED.user_id', [row.id,user,row.folder_id,storageChatId,messageId ?? null,index,row.name,row.original_name,row.mime,row.bytes,row.sha256,dbAvailability(row.availability),row.favorite,row.version,row.trashed_at,row.created_at,row.updated_at,row.local_blob_id ?? null,reference ?? null]);
      await client.query('DELETE FROM file_tags WHERE user_id=$1 AND file_id=$2', [user,row.id]);
      for (const tag of row.tags) {
        const result = await client.query('INSERT INTO tags(user_id,name) VALUES($1,$2) ON CONFLICT(user_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [user,tag]);
        await client.query('INSERT INTO file_tags(user_id,file_id,tag_id) VALUES($1,$2,$3)', [user,row.id,result.rows[0].id]);
      }
    }
    const oldTransfers = new Map(before.transfers.map(row => [row.id,row]));
    for (const row of state.transfers.filter(row => !same(oldTransfers.get(row.id),row))) {
      await client.query('INSERT INTO transfers(id,user_id,file_id,operation_id,state,expected_bytes,stage_bytes,attempts,retry_after,error_code,remote_result,created_at,updated_at,folder_id,name,mime,sha256,account_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(id) DO UPDATE SET file_id=EXCLUDED.file_id,state=EXCLUDED.state,expected_bytes=EXCLUDED.expected_bytes,stage_bytes=EXCLUDED.stage_bytes,attempts=EXCLUDED.attempts,retry_after=EXCLUDED.retry_after,error_code=EXCLUDED.error_code,remote_result=EXCLUDED.remote_result,updated_at=EXCLUDED.updated_at,folder_id=EXCLUDED.folder_id,name=EXCLUDED.name,mime=EXCLUDED.mime,sha256=EXCLUDED.sha256,account_key=EXCLUDED.account_key WHERE transfers.user_id=EXCLUDED.user_id', [row.id,user,row.file_id,row.operation_id,row.state,row.expected_bytes,row.stage_bytes,row.attempts,row.retry_after ?? null,row.error_code,row.remote_result ?? null,row.created_at,row.updated_at,row.folder_id,row.name,row.mime,row.sha256,row.account_key ?? null]);
      await client.query('INSERT INTO uploads(id,user_id,transfer_id,staging_ref,expected_bytes,offset_bytes) VALUES($1::uuid,$2::uuid,$1::uuid,$5,$3,$4) ON CONFLICT(id) DO UPDATE SET offset_bytes=EXCLUDED.offset_bytes,expires_at=now()+interval \'24 hours\' WHERE uploads.user_id=EXCLUDED.user_id', [row.id,user,row.expected_bytes,row.stage_bytes,row.account_key ? `${row.account_key}/${row.id}` : row.id]);
      for (const chunk of row.verified_chunks ?? []) {
        await client.query('INSERT INTO upload_chunks(user_id,upload_id,offset_bytes,length_bytes,checksum,state) VALUES($1,$2,$3,$4,$5,\'verified\') ON CONFLICT(user_id,upload_id,offset_bytes) DO UPDATE SET length_bytes=EXCLUDED.length_bytes,checksum=EXCLUDED.checksum,state=\'verified\'', [user,row.id,chunk.offset,chunk.length,chunk.checksum]);
      }
      // Dispatch persistence is atomic with the transfer state. A reconciler can
      // replay this after process loss without relying on an in-memory queue.
      if (row.state === 'QUEUED' && oldTransfers.get(row.id)?.state !== 'QUEUED') await client.query("INSERT INTO outbox_events(user_id,event_type,payload_ref) VALUES($1,'transfer.queued',$2)", [user,{ transfer_id: row.id,operation_id: row.operation_id }]);
    }
    for (const row of before.transfers.filter(row => !state.transfers.some(next => next.id === row.id))) {
      await client.query('DELETE FROM uploads WHERE user_id=$1 AND transfer_id=$2', [user,row.id]);
      await client.query('DELETE FROM transfers WHERE user_id=$1 AND id=$2', [user,row.id]);
    }
    for (const row of before.files.filter(row => !state.files.some(next => next.id === row.id))) await client.query('DELETE FROM files WHERE user_id=$1 AND id=$2', [user,row.id]);
    const removedFolders = before.folders.filter(row => !state.folders.some(next => next.id === row.id)).sort((a,b) => this.folderDepth(before.folders,b)-this.folderDepth(before.folders,a));
    for (const row of removedFolders) await client.query('DELETE FROM folders WHERE user_id=$1 AND id=$2', [user,row.id]);
    for (const row of state.tombstones.filter(row => !before.tombstones.some(previous => same(previous,row)))) {
      const ref = row.remote_reference;
      const key = ref ? JSON.stringify(Object.fromEntries(Object.entries(ref).sort(([a],[b])=>a.localeCompare(b)))) : `catalog:${row.file_id}`;
      await client.query('INSERT INTO catalog_tombstones(user_id,remote_attachment_key,reason,created_at,file_id,remote_reference) VALUES($1,$2,\'catalog_removed\',$3,$4,$5) ON CONFLICT(user_id,remote_attachment_key) DO UPDATE SET file_id=EXCLUDED.file_id,remote_reference=EXCLUDED.remote_reference', [user,key,row.created_at,row.file_id,ref ?? null]);
    }
    for (const row of before.tombstones.filter(row => !state.tombstones.some(next => next.file_id===row.file_id))) await client.query('DELETE FROM catalog_tombstones WHERE user_id=$1 AND file_id=$2', [user,row.file_id]);
    await client.query('DELETE FROM idempotency_keys WHERE user_id=$1 AND expiry<=now()', [user]);
    for (const row of state.idempotency.filter(row => !before.idempotency.some(previous => same(previous,row)))) await client.query('INSERT INTO idempotency_keys(user_id,route_scope,key,request_digest,response_ref,expiry) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,route_scope,key) DO UPDATE SET request_digest=EXCLUDED.request_digest,response_ref=EXCLUDED.response_ref,expiry=EXCLUDED.expiry', [user,row.scope,row.key,row.digest,row.result,row.expires_at]);
  }
}
