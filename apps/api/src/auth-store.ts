import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DomainError } from '@cloudnest/domain';

export interface AuthUser { id: string; telegramUserId: string; locale: 'en' | 'bn'; status: string }
export interface AuthSession { id: string; userId: string; deviceId: string; expiresAt: string }
export interface SessionIssue { token: string; refreshToken: string; csrfToken: string; session: AuthSession; user: AuthUser; previousAccountKey?: string; unusedAccountKey?: string }
export interface AuthenticatedSession { user: AuthUser; session: AuthSession; csrfTokenHash: string }
export interface LoginTransaction { id: string; accountKey: string; state: Record<string, unknown>; expiresAt: string; consumedAt: string | null }
export interface LoginTransactionIssue extends LoginTransaction { token: string }
export interface SelectedChat { id: string; peerId: string; kind: 'saved_messages' | 'private_channel' | 'private_chat'; title: string; canSend: boolean; canDelete: boolean; status: string }
export interface SessionOptions { deviceId?: string; deviceLabel?: string; ttlSeconds?: number }
export interface CompleteLoginInput { telegramUserId: string; locale?: 'en' | 'bn'; deviceLabel?: string; reuseAccountKey?: string }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const secret = (): string => randomBytes(40).toString('base64url');
const iso = (value: Date | string): string => new Date(value).toISOString();
const userRow = (row: any): AuthUser => ({ id: row.id, telegramUserId: String(row.telegram_user_id), locale: row.locale, status: row.status });
const sessionRow = (row: any): AuthSession => ({ id: row.id, userId: row.user_id, deviceId: row.device_id, expiresAt: iso(row.expires_at) });
const loginRow = (row: any): LoginTransaction => ({ id: row.id, accountKey: row.account_key, state: row.state, expiresAt: iso(row.expires_at), consumedAt: row.consumed_at ? iso(row.consumed_at) : null });

export async function withTenant<T>(pool: Pool, userId: string, callback: (client: PoolClient) => Promise<T>, options: { isolation?: 'REPEATABLE READ' } = {}): Promise<T> {
  if (!uuid.test(userId)) throw new DomainError('AUTH_EXPIRED', 'The account session is invalid.', 401);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (options.isolation === 'REPEATABLE READ') await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await client.query("SELECT set_config('cloudnest.user_id', $1, true)", [userId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export class PgAuthStore {
  constructor(readonly pool: Pool) {}

  async upsertVerifiedUser(telegramUserId: string, locale: 'en' | 'bn' = 'en'): Promise<AuthUser> {
    return this.upsert(this.pool, telegramUserId, locale);
  }
  private async upsert(client: Pick<PoolClient, 'query'> | Pool, telegramUserId: string, locale: 'en' | 'bn'): Promise<AuthUser> {
    if (!/^[1-9]\d{0,18}$/.test(telegramUserId) || BigInt(telegramUserId) > 9223372036854775807n || !['en', 'bn'].includes(locale)) throw new DomainError('INVALID_IDENTITY', 'A verified Telegram identity is required.', 400);
    const result = await client.query('SELECT * FROM cloudnest_upsert_verified_user($1::bigint,$2::text)', [telegramUserId, locale]);
    return userRow(result.rows[0]);
  }

  async getUser(userId: string): Promise<AuthUser | null> {
    return withTenant(this.pool, userId, async client => { const result = await client.query('SELECT id,telegram_user_id,locale,status FROM users WHERE id=$1', [userId]); return result.rows[0] ? userRow(result.rows[0]) : null; });
  }

  async createSession(userId: string, options: SessionOptions = {}): Promise<SessionIssue> {
    return withTenant(this.pool, userId, client => this.issueSession(client, userId, options));
  }
  private async issueSession(client: PoolClient, userId: string, options: SessionOptions = {}): Promise<SessionIssue> {
    const users = await client.query('SELECT id,telegram_user_id,locale,status FROM users WHERE id=$1 FOR SHARE', [userId]);
    if (!users.rows[0] || users.rows[0].status !== 'active') throw new DomainError('AUTH_EXPIRED', 'This account is unavailable.', 401);
    let deviceId = options.deviceId;
    if (deviceId) {
      const devices = await client.query('SELECT id FROM devices WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [deviceId, userId]);
      if (!devices.rows[0]) throw new DomainError('AUTH_EXPIRED', 'This device is unavailable.', 401);
    } else {
      deviceId = randomUUID();
      await client.query('INSERT INTO devices(id,user_id,public_key,platform,label) VALUES($1,$2,$3,\'web\',$4)', [deviceId, userId, `web:${secret()}`, String(options.deviceLabel ?? 'Web browser').slice(0, 120)]);
    }
    const id = randomUUID(); const token = `${userId}.${id}.${secret()}`; const csrfToken = secret();
    const ttl = options.ttlSeconds ?? 30 * 86400;
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 30 * 86400) throw new DomainError('INVALID_SESSION', 'The requested session duration is invalid.');
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    await client.query('INSERT INTO product_sessions(id,user_id,device_id,hashed_refresh_token,hashed_csrf_token,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [id, userId, deviceId, hashToken(token), hashToken(csrfToken), expiresAt]);
    return { token, refreshToken: token, csrfToken, user: userRow(users.rows[0]), session: { id, userId, deviceId, expiresAt } };
  }

  private parseSession(token: string): { userId: string; sessionId: string } | null {
    if (typeof token !== 'string' || token.length > 300) return null;
    const parts = token.split('.');
    return parts.length === 3 && uuid.test(parts[0]) && uuid.test(parts[1]) && /^[A-Za-z0-9_-]{54}$/.test(parts[2]) ? { userId: parts[0], sessionId: parts[1] } : null;
  }

  async authenticateSession(token: string): Promise<AuthenticatedSession | null> {
    const parsed = this.parseSession(token); if (!parsed) return null;
    return withTenant(this.pool, parsed.userId, async client => {
      const result = await client.query('SELECT s.*,u.telegram_user_id,u.locale,u.status FROM product_sessions s JOIN users u ON u.id=s.user_id JOIN devices d ON d.id=s.device_id AND d.user_id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.hashed_refresh_token=$3 AND s.revoked_at IS NULL AND s.expires_at>now() AND d.revoked_at IS NULL AND u.status=\'active\'', [parsed.sessionId, parsed.userId, hashToken(token)]);
      const row = result.rows[0];
      return row ? { user: userRow({ ...row, id: row.user_id }), session: sessionRow(row), csrfTokenHash: row.hashed_csrf_token } : null;
    });
  }

  async rotateSession(token: string): Promise<SessionIssue> {
    const parsed = this.parseSession(token); if (!parsed) throw new DomainError('AUTH_EXPIRED', 'Sign in again to continue.', 401);
    const outcome = await withTenant(this.pool, parsed.userId, async client => {
      const found = await client.query('SELECT s.*,u.telegram_user_id,u.locale,u.status,d.revoked_at AS device_revoked_at FROM product_sessions s JOIN users u ON u.id=s.user_id JOIN devices d ON d.id=s.device_id AND d.user_id=s.user_id WHERE s.id=$1 AND s.user_id=$2 FOR UPDATE OF s', [parsed.sessionId, parsed.userId]);
      const row = found.rows[0];
      if (!row || row.revoked_at || row.device_revoked_at || row.status !== 'active' || new Date(row.expires_at).getTime() <= Date.now()) return { error: 'AUTH_EXPIRED' as const };
      const digest = hashToken(token);
      if (row.hashed_refresh_token !== digest) {
        const history = await client.query('SELECT 1 FROM session_refresh_history WHERE user_id=$1 AND session_id=$2 AND token_hash=$3', [parsed.userId, parsed.sessionId, digest]);
        if (history.rows[0]) { await client.query('UPDATE product_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2', [parsed.sessionId, parsed.userId]); return { error: 'SESSION_REUSE' as const }; }
        return { error: 'AUTH_EXPIRED' as const };
      }
      const next = `${parsed.userId}.${parsed.sessionId}.${secret()}`; const csrfToken = secret();
      await client.query('INSERT INTO session_refresh_history(user_id,session_id,token_hash,expires_at) VALUES($1,$2,$3,$4)', [parsed.userId, parsed.sessionId, digest, row.expires_at]);
      await client.query('UPDATE product_sessions SET hashed_refresh_token=$1,hashed_csrf_token=$2 WHERE id=$3 AND user_id=$4', [hashToken(next), hashToken(csrfToken), parsed.sessionId, parsed.userId]);
      await client.query('UPDATE devices SET last_seen=now() WHERE id=$1 AND user_id=$2', [row.device_id, parsed.userId]);
      return { issue: { token: next, refreshToken: next, csrfToken, user: userRow({ ...row, id: row.user_id }), session: sessionRow(row) } };
    });
    if ('error' in outcome) throw new DomainError(outcome.error!, outcome.error === 'SESSION_REUSE' ? 'A reused refresh credential was detected. Sign in again.' : 'Sign in again to continue.', 401);
    return outcome.issue!;
  }

  async revokeSession(token: string): Promise<void> {
    const parsed = this.parseSession(token); if (!parsed) return;
    await withTenant(this.pool, parsed.userId, async client => { await client.query('UPDATE product_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1 AND id=$2 AND hashed_refresh_token=$3', [parsed.userId, parsed.sessionId, hashToken(token)]); });
  }
  async revokeAllSessions(userId: string): Promise<void> {
    await withTenant(this.pool, userId, async client => { await client.query('UPDATE product_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1', [userId]); });
  }
  async listDevices(userId: string): Promise<{ id: string; label: string; platform: string; lastSeen: string; revokedAt: string | null }[]> {
    return withTenant(this.pool, userId, async client => (await client.query('SELECT id,label,platform,last_seen,revoked_at FROM devices WHERE user_id=$1 ORDER BY last_seen DESC', [userId])).rows.map(row => ({ id: row.id, label: row.label, platform: row.platform, lastSeen: iso(row.last_seen), revokedAt: row.revoked_at ? iso(row.revoked_at) : null })));
  }

  async createLoginTransaction(accountKey: string): Promise<LoginTransactionIssue> {
    if (!/^[\w-]{1,128}$/.test(accountKey)) throw new DomainError('INVALID_ACCOUNT_KEY', 'The Telegram account transaction is invalid.');
    const id = randomUUID(); const token = `${id}.${secret()}`; const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const state = { state: 'connecting' };
    await this.withLogin(id, async client => { await client.query('INSERT INTO login_transactions(id,token_hash,account_key,state,expires_at) VALUES($1,$2,$3,$4,$5)', [id, hashToken(token), accountKey, state, expiresAt]); });
    return { id, token, accountKey, state, expiresAt, consumedAt: null };
  }
  private parseLogin(token: string): string | null {
    const parts = typeof token === 'string' ? token.split('.') : [];
    return parts.length === 2 && uuid.test(parts[0]) && /^[A-Za-z0-9_-]{54}$/.test(parts[1]) ? parts[0] : null;
  }
  private async withLogin<T>(id: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await client.query("SELECT set_config('cloudnest.login_id',$1,true)", [id]); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async getLoginTransaction(token: string): Promise<LoginTransaction | null> {
    const id = this.parseLogin(token); if (!id) return null;
    return this.withLogin(id, async client => { const result = await client.query('SELECT * FROM login_transactions WHERE id=$1 AND token_hash=$2 AND expires_at>now() AND consumed_at IS NULL', [id, hashToken(token)]); return result.rows[0] ? loginRow(result.rows[0]) : null; });
  }
  async updateLoginTransaction(token: string, state: Record<string, unknown>): Promise<void> {
    const id = this.parseLogin(token); if (!id) throw new DomainError('AUTH_EXPIRED', 'This login has expired. Start again.', 401);
    const serialized = JSON.stringify(state);
    if (serialized.length > 16384 || /"(?:password|code|phoneNumber|phone_number|otp|token)"\s*:/i.test(serialized)) throw new DomainError('INVALID_AUTH_STATE', 'Login secrets must not be stored.');
    await this.withLogin(id, async client => { const result = await client.query('UPDATE login_transactions SET state=$1,updated_at=now() WHERE id=$2 AND token_hash=$3 AND expires_at>now() AND consumed_at IS NULL', [state, id, hashToken(token)]); if (!result.rowCount) throw new DomainError('AUTH_EXPIRED', 'This login has expired. Start again.', 401); });
  }
  async completeLogin(token: string, input: CompleteLoginInput): Promise<SessionIssue> {
    const id = this.parseLogin(token); if (!id) throw new DomainError('AUTH_EXPIRED', 'This login has expired. Start again.', 401);
    return this.withLogin(id, async client => {
      const result = await client.query('SELECT * FROM login_transactions WHERE id=$1 AND token_hash=$2 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE', [id, hashToken(token)]);
      const login = result.rows[0]; if (!login) throw new DomainError('AUTH_EXPIRED', 'This login has expired. Start again.', 401);
      const user = await this.upsert(client, input.telegramUserId, input.locale ?? 'en');
      await client.query("SELECT set_config('cloudnest.user_id',$1,true)", [user.id]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [user.id]);
      const previous = await client.query("SELECT account_key,state FROM telegram_sessions WHERE user_id=$1 AND runtime_kind='server'", [user.id]);
      if (input.reuseAccountKey && (previous.rows[0]?.account_key !== input.reuseAccountKey || previous.rows[0]?.state !== 'connected')) throw new DomainError('VERSION_CONFLICT', 'The linked Telegram session changed. Connect again.', 409);
      const effectiveKey = input.reuseAccountKey ?? login.account_key;
      const previousAccountKey = previous.rows[0]?.account_key;
      // Queue before replacing the canonical row so legacy authorizations whose
      // login predates completed_user_id retain a durable ownership proof.
      for (const obsoleteKey of [previousAccountKey && previousAccountKey !== effectiveKey ? previousAccountKey : null, effectiveKey !== login.account_key ? login.account_key : null].filter(Boolean)) {
        await client.query("INSERT INTO pending_revocations(user_id,account_key) VALUES($1,$2) ON CONFLICT(user_id,account_key) DO UPDATE SET state='pending',retry_after=now(),last_error_code=NULL",[user.id,obsoleteKey]);
      }
      await client.query("INSERT INTO telegram_sessions(user_id,runtime_kind,encrypted_state_ref,kms_key_version,state,account_key) VALUES($1,'server',$2,'adapter-managed','connected',$3) ON CONFLICT(user_id) WHERE runtime_kind='server' DO UPDATE SET encrypted_state_ref=EXCLUDED.encrypted_state_ref,state='connected',account_key=EXCLUDED.account_key", [user.id, `tdlib:${effectiveKey}`, effectiveKey]);
      const issue = await this.issueSession(client, user.id, { deviceLabel: input.deviceLabel });
      await client.query('UPDATE login_transactions SET consumed_at=now(),state=\'{"state":"ready"}\'::jsonb,updated_at=now(),completed_user_id=$2 WHERE id=$1', [id,user.id]);
      if (previousAccountKey && previousAccountKey !== effectiveKey) issue.previousAccountKey = previousAccountKey;
      if (effectiveKey !== login.account_key) issue.unusedAccountKey = login.account_key;
      return issue;
    });
  }
  async getTelegramSession(userId: string): Promise<{ accountKey: string; state: string } | null> {
    return withTenant(this.pool, userId, async client => { const result = await client.query("SELECT account_key,state FROM telegram_sessions WHERE user_id=$1 AND runtime_kind='server'", [userId]); return result.rows[0]?.account_key ? { accountKey: result.rows[0].account_key, state: result.rows[0].state } : null; });
  }
  async setTelegramSessionState(userId: string, state: string): Promise<void> {
    if (!['connected', 'disconnected', 'revocation_pending', 'expired'].includes(state)) throw new DomainError('INVALID_SESSION_STATE', 'The session state is invalid.');
    await withTenant(this.pool, userId, async client => { await client.query("UPDATE telegram_sessions SET state=$1 WHERE user_id=$2 AND runtime_kind='server'", [state, userId]); });
  }
  async listConnectedUsers(): Promise<{ userId: string; accountKey: string }[]> {
    return (await this.pool.query('SELECT * FROM cloudnest_connected_accounts()')).rows.map(row => ({ userId: row.user_id, accountKey: row.account_key }));
  }
  async getSelectedChat(userId: string): Promise<SelectedChat | null> {
    return withTenant(this.pool, userId, async client => { const result = await client.query("SELECT * FROM storage_chats WHERE user_id=$1 AND status='available' ORDER BY selected_at DESC,id DESC LIMIT 1", [userId]); return result.rows[0] ? this.chatRow(result.rows[0]) : null; });
  }
  async listStorageChats(userId: string): Promise<SelectedChat[]> {
    return withTenant(this.pool, userId, async client => (await client.query('SELECT * FROM storage_chats WHERE user_id=$1 ORDER BY selected_at DESC', [userId])).rows.map(row => this.chatRow(row)));
  }
  private chatRow(row: any): SelectedChat { return { id: row.id, peerId: String(row.remote_peer_id), kind: row.type, title: row.verified_permissions?.title ?? 'Storage chat', canSend: row.verified_permissions?.canSend === true, canDelete: row.verified_permissions?.canDelete === true, status: row.status }; }
  async selectChat(userId: string, chat: { peerId: string; kind: SelectedChat['kind']; canSend: boolean; canDelete: boolean; title?: string }): Promise<SelectedChat> {
    if (!/^-?[1-9]\d{0,18}$/.test(chat.peerId) || BigInt(chat.peerId) < -9223372036854775808n || BigInt(chat.peerId) > 9223372036854775807n || !['saved_messages', 'private_channel', 'private_chat'].includes(chat.kind) || !chat.canSend) throw new DomainError('PERMISSION_DENIED', 'Choose a supported writable storage chat.', 403);
    return withTenant(this.pool, userId, async client => {
      const result = await client.query("INSERT INTO storage_chats(user_id,remote_peer_id,type,verified_permissions,status) VALUES($1,$2,$3,$4,'available') ON CONFLICT(user_id,remote_peer_id) DO UPDATE SET type=EXCLUDED.type,verified_permissions=EXCLUDED.verified_permissions,status='available',selected_at=now() RETURNING *", [userId, chat.peerId, chat.kind, { canSend: chat.canSend, canDelete: chat.canDelete, title: String(chat.title ?? 'Storage chat').slice(0, 255) }]);
      return this.chatRow(result.rows[0]);
    });
  }
  async checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfterSeconds: number; remaining: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86400) throw new DomainError('INVALID_RATE_LIMIT', 'The rate-limit policy is invalid.');
    const result = await this.pool.query('SELECT * FROM cloudnest_check_rate_limit($1,$2,$3)', [hashToken(key), limit, windowSeconds]);
    return { allowed: result.rows[0].allowed, retryAfterSeconds: Number(result.rows[0].retry_after_seconds), remaining: Number(result.rows[0].remaining) };
  }

  async enqueueRevocation(userId: string, accountKey: string): Promise<void> {
    await withTenant(this.pool,userId,async client=>{
      const ownership=await client.query("SELECT 1 FROM telegram_sessions WHERE user_id=$1 AND account_key=$2 UNION ALL SELECT 1 FROM login_transactions WHERE completed_user_id=$1 AND account_key=$2 AND consumed_at IS NOT NULL UNION ALL SELECT 1 FROM pending_revocations WHERE user_id=$1 AND account_key=$2 LIMIT 1",[userId,accountKey]);
      if(!ownership.rows[0]) throw new DomainError('PERMISSION_DENIED','This authorization does not belong to the account.',403);
      await client.query("INSERT INTO pending_revocations(user_id,account_key) VALUES($1,$2) ON CONFLICT(user_id,account_key) DO UPDATE SET state='pending',retry_after=now(),last_error_code=NULL",[userId,accountKey]);
    });
  }
  async listPendingRevocations(limit=100): Promise<{userId:string;accountKey:string;attempts:number}[]> {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new DomainError('INVALID_LIMIT','Revocation batch size must be between 1 and 100.');
    return (await this.pool.query('SELECT * FROM cloudnest_pending_revocations($1)',[limit])).rows.map(row=>({userId:row.user_id,accountKey:row.account_key,attempts:row.attempts}));
  }
  async completeRevocation(userId:string,accountKey:string):Promise<void> {
    await withTenant(this.pool,userId,async client=>{await client.query("UPDATE pending_revocations SET state='confirmed',updated_at=now(),last_error_code=NULL WHERE user_id=$1 AND account_key=$2",[userId,accountKey]);});
  }
  async deferRevocation(userId:string,accountKey:string,retryAfterSeconds=60,errorCode='PROVIDER_UNAVAILABLE'):Promise<void> {
    if(!Number.isSafeInteger(retryAfterSeconds)||retryAfterSeconds<1||retryAfterSeconds>86400||!/^[A-Z_]{1,64}$/.test(errorCode)) throw new DomainError('INVALID_RETRY','The provider retry policy is invalid.');
    await withTenant(this.pool,userId,async client=>{await client.query("UPDATE pending_revocations SET attempts=attempts+1,retry_after=now()+make_interval(secs=>$1),last_error_code=$2,updated_at=now() WHERE user_id=$3 AND account_key=$4 AND state='pending'",[retryAfterSeconds,errorCode,userId,accountKey]);});
  }
}
