import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DomainError } from '@cloudnest/domain';
import type { RemoteAttachment, WorkerRpcMethods } from '@cloudnest/contracts';
import type { ProductionRuntime } from './production.js';
import { withTenant } from './auth-store.js';
import { ProviderError } from './telegram-client.js';
import { storedReference } from './dispatch.js';

export type SyncJobState = 'QUEUED' | 'RUNNING' | 'WAITING_PROVIDER' | 'WAITING_NETWORK' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export interface SyncJob {
  id: string; storage_chat_id: string; state: SyncJobState;
  scanned_files: number; imported_files: number; skipped_files: number; pages: number;
  error_code: string | null; retry_after: string | null;
  created_at: string; updated_at: string; completed_at: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activeStates = ['QUEUED', 'RUNNING', 'WAITING_PROVIDER', 'WAITING_NETWORK'];
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
const nullableIso = (value: unknown): string | null => value ? iso(value) : null;
const exact = (value: unknown): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new DomainError('SYNC_INCONSISTENT', 'Recovery progress is outside the supported range.', 503);
  return result;
};
const jobRow = (row: any): SyncJob => ({
  id: row.id, storage_chat_id: row.storage_chat_id, state: row.state,
  scanned_files: exact(row.scanned_files), imported_files: exact(row.imported_files), skipped_files: exact(row.skipped_files), pages: row.pages,
  error_code: row.error_code, retry_after: nullableIso(row.retry_after), created_at: iso(row.created_at), updated_at: iso(row.updated_at), completed_at: nullableIso(row.completed_at)
});
function identifier(value: unknown, positive = false): value is string {
  return typeof value === 'string' && (positive ? /^[1-9]\d{0,18}$/ : /^-?[1-9]\d{0,18}$/).test(value)
    && BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n;
}
/** A malformed page is rejected rather than indexing another account or chat. */
export function validateRecoveryPage(page: unknown, telegramUserId: string, peerId: string, inputCursor?: string): { items: RemoteAttachment[]; cursor?: string } {
  const value = page as { items?: unknown; cursor?: unknown };
  if (!value || !Array.isArray(value.items) || value.items.length > 100) throw new DomainError('SYNC_INVALID_PAGE', 'Telegram returned an invalid recovery page.', 502);
  if (value.cursor !== undefined && (!identifier(value.cursor, true) || value.cursor === inputCursor)) throw new DomainError('SYNC_CURSOR_STALLED', 'The scan did not advance. Check the connection and start another scan.', 502);
  const seen = new Set<string>(); const items: RemoteAttachment[] = [];
  for (const raw of value.items) {
    const item = raw as RemoteAttachment & { sending_state?: unknown }; const ref = item?.reference;
    if (!ref || ref.telegramUserId !== telegramUserId || ref.peerId !== peerId || !identifier(ref.messageId, true) || ref.attachmentIndex !== 0 || item.sending_state
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.originalName !== 'string' || typeof item.mime !== 'string' || item.mime.length > 255
      || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) {
      throw new DomainError('SYNC_INVALID_ATTACHMENT', 'Telegram returned an attachment outside the selected account or an invalid original.', 502);
    }
    const key = `${ref.messageId}:${ref.attachmentIndex}`; if (seen.has(key)) continue; seen.add(key);
    const originalName = [...item.originalName.replace(/[\x00-\x1f\x7f]/g, '').trim()].slice(0, 255).join('') || 'Untitled file';
    items.push({ ...item, originalName, mime: item.mime.replace(/[\x00-\x1f\x7f]/g, '') || 'application/octet-stream', createdAt: new Date(item.createdAt).toISOString() });
  }
  return { items, ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}) };
}
export function recoveryRetry(error: unknown, failures: number): { state: 'WAITING_PROVIDER' | 'WAITING_NETWORK' | 'FAILED'; code: string; retrySeconds?: number } {
  if (error instanceof ProviderError && error.code === 'PROVIDER_WAIT') return { state: 'WAITING_PROVIDER', code: 'PROVIDER_WAIT', retrySeconds: Math.max(1, error.retryAfterSeconds || 60) };
  if (error instanceof DomainError && ['AUTH_EXPIRED', 'PERMISSION_DENIED', 'ACCOUNT_MISMATCH', 'SYNC_INVALID_PAGE', 'SYNC_CURSOR_STALLED', 'SYNC_INVALID_ATTACHMENT', 'STORAGE_UNAVAILABLE'].includes(error.code)) return { state: 'FAILED', code: error.code };
  if (failures >= 10) return { state: 'FAILED', code: 'SYNC_RETRY_EXHAUSTED' };
  return { state: 'WAITING_NETWORK', code: 'WORKER_UNAVAILABLE', retrySeconds: Math.min(300, 5 * 2 ** Math.min(failures, 6)) };
}

/** Explicit selected-chat scans. Each page and its checkpoint commit atomically. */
export class SyncService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  constructor(private readonly runtime: ProductionRuntime, private readonly pool: Pool) {}
  start() { if (this.timer) return; this.timer = setInterval(() => void this.tick().catch(() => {}), 2000); this.timer.unref(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async startJob(userId: string, storageChatId?: string): Promise<SyncJob> {
    if (storageChatId !== undefined && !uuid.test(storageChatId)) throw new DomainError('INVALID_STORAGE', 'Choose a selected storage chat.', 400);
    const session = await this.runtime.auth.getTelegramSession(userId);
    if (!session || session.state !== 'connected') throw new DomainError('AUTH_EXPIRED', 'Connect Telegram before scanning storage.', 401);
    const chat = storageChatId ? (await this.runtime.auth.listStorageChats(userId)).find(item => item.id === storageChatId) : await this.runtime.auth.getSelectedChat(userId);
    if (!chat || chat.status !== 'available' || !chat.canSend) throw new DomainError('STORAGE_UNAVAILABLE', 'Select a writable storage chat before starting recovery.', 403);
    return withTenant(this.pool, userId, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [userId]);
      const existing = await client.query('SELECT * FROM sync_jobs WHERE user_id=$1 AND storage_chat_id=$2 AND state=ANY($3::text[]) ORDER BY created_at DESC LIMIT 1', [userId, chat.id, activeStates]);
      if (existing.rows[0]) return jobRow(existing.rows[0]);
      const result = await client.query("INSERT INTO sync_jobs(user_id,storage_chat_id,account_key,state) VALUES($1,$2,$3,'QUEUED') RETURNING *", [userId, chat.id, session.accountKey]);
      await client.query('INSERT INTO sync_checkpoints(user_id,storage_chat_id,history_cursor) VALUES($1,$2,NULL) ON CONFLICT(user_id,storage_chat_id) DO UPDATE SET history_cursor=NULL', [userId, chat.id]);
      return jobRow(result.rows[0]);
    });
  }
  async getJob(userId: string, jobId: string): Promise<SyncJob> {
    if (!uuid.test(jobId)) throw new DomainError('NOT_FOUND', 'This recovery scan is unavailable.', 404);
    return withTenant(this.pool, userId, async client => {
      const result = await client.query('SELECT * FROM sync_jobs WHERE user_id=$1 AND id=$2', [userId, jobId]);
      if (!result.rows[0]) throw new DomainError('NOT_FOUND', 'This recovery scan is unavailable.', 404);
      return jobRow(result.rows[0]);
    });
  }
  async listJobs(userId: string): Promise<SyncJob[]> {
    return withTenant(this.pool, userId, async client => (await client.query('SELECT * FROM sync_jobs WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20', [userId])).rows.map(jobRow));
  }
  async tick(): Promise<void> {
    if (this.running) return; this.running = true;
    try {
      const jobs = await this.pool.query('SELECT * FROM cloudnest_runnable_sync_jobs($1)', [20]);
      for (const job of jobs.rows) { try { await this.page(job.user_id, job.job_id); } catch { /* The durable lease expires after an interrupted request. */ } }
    } finally { this.running = false; }
  }
  private async page(userId: string, jobId: string): Promise<void> {
    const owner = randomUUID();
    const claimed = await withTenant(this.pool, userId, async client => {
      const result = await client.query("UPDATE sync_jobs SET state='RUNNING',lease_owner=$3,lease_expires_at=now()+interval '90 seconds',updated_at=now() WHERE user_id=$1 AND id=$2 AND state=ANY($4::text[]) AND (retry_after IS NULL OR retry_after<=now()) AND (lease_expires_at IS NULL OR lease_expires_at<=now()) RETURNING *", [userId, jobId, owner, activeStates]);
      return result.rows[0];
    });
    if (!claimed) return;
    try {
      const [session, chats, user] = await Promise.all([this.runtime.auth.getTelegramSession(userId), this.runtime.auth.listStorageChats(userId), this.runtime.auth.getUser(userId)]);
      if (!session || session.state !== 'connected' || session.accountKey !== claimed.account_key || !user || user.status !== 'active') throw new DomainError('AUTH_EXPIRED', 'The connection changed. Connect Telegram and start another scan.', 401);
      const chat = chats.find(value => value.id === claimed.storage_chat_id && value.status === 'available' && value.canSend);
      if (!chat) throw new DomainError('STORAGE_UNAVAILABLE', 'The selected storage chat is unavailable.', 403);
      await this.runtime.worker.selectChat(session.accountKey, chat.peerId);
      const result = await this.runtime.worker.rpc<WorkerRpcMethods['attachments.list']['result']>('attachments.list', session.accountKey, { peerId: chat.peerId, ...(claimed.history_cursor ? { cursor: claimed.history_cursor } : {}) });
      const page = validateRecoveryPage(result, user.telegramUserId, chat.peerId, claimed.history_cursor || undefined);
      await withTenant(this.pool, userId, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [userId]);
        const locked = await client.query("SELECT id FROM sync_jobs WHERE user_id=$1 AND id=$2 AND lease_owner=$3 AND state='RUNNING' AND lease_expires_at>now() FOR UPDATE", [userId, jobId, owner]);
        if (!locked.rows[0]) return;
        const current = await client.query("SELECT s.id FROM telegram_sessions s JOIN storage_chats c ON c.user_id=s.user_id WHERE s.user_id=$1 AND s.runtime_kind='server' AND s.state='connected' AND s.account_key=$2 AND c.id=$3 AND c.status='available'", [userId, session.accountKey, chat.id]);
        if (!current.rows[0]) throw new DomainError('AUTH_EXPIRED', 'The Telegram connection changed during recovery.', 401);
        let imported = 0;
        for (const item of page.items) if (await this.import(client, userId, chat.id, session.accountKey, item)) imported++;
        const complete = !page.cursor;
        await client.query('INSERT INTO sync_checkpoints(user_id,storage_chat_id,history_cursor,last_reconciled_at) VALUES($1,$2,$3,CASE WHEN $4 THEN now() ELSE NULL END) ON CONFLICT(user_id,storage_chat_id) DO UPDATE SET history_cursor=EXCLUDED.history_cursor,last_reconciled_at=CASE WHEN $4 THEN now() ELSE sync_checkpoints.last_reconciled_at END', [userId, chat.id, page.cursor || null, complete]);
        await client.query("UPDATE sync_jobs SET state=$4,history_cursor=$5,scanned_files=scanned_files+$6,imported_files=imported_files+$7,skipped_files=skipped_files+$8,pages=pages+1,failure_count=0,error_code=NULL,retry_after=NULL,lease_owner=NULL,lease_expires_at=NULL,completed_at=CASE WHEN $9 THEN now() ELSE NULL END,updated_at=now() WHERE user_id=$1 AND id=$2 AND lease_owner=$3", [userId, jobId, owner, complete ? 'COMPLETED' : 'QUEUED', page.cursor || null, page.items.length, imported, page.items.length - imported, complete]);
      });
    } catch (error) {
      const retry = recoveryRetry(error, claimed.failure_count + 1);
      await withTenant(this.pool, userId, client => client.query("UPDATE sync_jobs SET state=$4,error_code=$5,retry_after=CASE WHEN $6::integer IS NULL THEN NULL ELSE now()+make_interval(secs=>$6::integer) END,failure_count=failure_count+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE user_id=$1 AND id=$2 AND lease_owner=$3", [userId, jobId, owner, retry.state, retry.code, retry.retrySeconds ?? null]));
    }
  }
  private async import(client: PoolClient, userId: string, storageChatId: string, accountKey: string, item: RemoteAttachment): Promise<boolean> {
    const reference = storedReference(item.reference, accountKey);
    const canonical = JSON.stringify([item.reference.telegramUserId, item.reference.peerId, item.reference.messageId, item.reference.attachmentIndex]);
    const tombstone = await client.query("SELECT 1 FROM catalog_tombstones WHERE user_id=$1 AND (remote_attachment_key=$2 OR (coalesce(remote_reference->>'telegram_user_id',remote_reference->>'telegramUserId')=$3 AND coalesce(remote_reference->>'peer_id',remote_reference->>'peerId')=$4 AND coalesce(remote_reference->>'message_id',remote_reference->>'messageId')=$5 AND coalesce(remote_reference->>'attachment_index',remote_reference->>'attachmentIndex','0')=$6)) LIMIT 1", [userId, canonical, item.reference.telegramUserId, item.reference.peerId, item.reference.messageId, String(item.reference.attachmentIndex)]);
    if (tombstone.rows[0]) return false;
    const result = await client.query("INSERT INTO files(user_id,storage_chat_id,remote_message_id,attachment_index,display_name,original_name,mime,bytes,origin,availability,created_at,updated_at,remote_reference) VALUES($1,$2,$3,$4,$5,$5,$6,$7,'recovered','confirmed',$8,now(),$9) ON CONFLICT(user_id,storage_chat_id,remote_message_id,attachment_index) DO NOTHING RETURNING id", [userId, storageChatId, item.reference.messageId, item.reference.attachmentIndex, item.originalName, item.mime, item.bytes, item.createdAt, reference]);
    return result.rowCount === 1;
  }
}
