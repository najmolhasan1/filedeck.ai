import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { computeCheck } from 'telegram/Password.js';
import { Catalog, DriveFile, formatBytes, kindFor, MAX_FILE_BYTES, Transfer } from './catalog';
import { commitCatalog, loadCatalog, saveCatalog } from './storage';

export type TelegramAuthState = {
  state: 'credentials_required' | 'phone_required' | 'code_required' | 'password_required' | 'connecting' | 'ready' | 'closed' | 'unavailable';
  delivery?: string;
  hint?: string;
  retryAfterSeconds?: number;
  transaction_id?: string;
};

export type TelegramUser = {
  id: string;
  telegram_user_id: string;
  name: string;
  username?: string;
  phone?: string;
  storage_selected: boolean;
  telegram_connected: boolean;
  capabilities: {
    file_limit_bytes: number;
    remote_deletion: boolean;
  };
};

const SESSION_STORAGE_KEY = 'cloudnest_tg_session';
const API_ID_KEY = 'cloudnest_tg_api_id';
const API_HASH_KEY = 'cloudnest_tg_api_hash';
const STORAGE_DESTINATION_KEY = 'cloudnest_storage_destination';
const CATALOG_SYNC_TAG = '#cloudnest_catalog_sync';

export class TelegramBrowserGateway {
  private client: TelegramClient | null = null;
  private currentPhone = '';
  private currentPhoneCodeHash = '';
  private user: TelegramUser | null = null;
  private connectingPromise: Promise<TelegramClient> | null = null;

  public getApiCredentials(): { apiId: number; apiHash: string } | null {
    if (typeof window === 'undefined') return null;
    const envId = process.env.NEXT_PUBLIC_TELEGRAM_API_ID;
    const envHash = process.env.NEXT_PUBLIC_TELEGRAM_API_HASH;
    if (envId && envHash && !isNaN(Number(envId))) {
      return { apiId: Number(envId), apiHash: envHash };
    }
    const localId = localStorage.getItem(API_ID_KEY);
    const localHash = localStorage.getItem(API_HASH_KEY);
    if (localId && localHash && !isNaN(Number(localId))) {
      return { apiId: Number(localId), apiHash: localHash };
    }
    return null;
  }

  public saveApiCredentials(apiId: number, apiHash: string): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(API_ID_KEY, String(apiId));
    localStorage.setItem(API_HASH_KEY, apiHash.trim());
    this.resetSession();
  }

  public clearApiCredentials(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(API_ID_KEY);
    localStorage.removeItem(API_HASH_KEY);
    this.resetSession();
  }

  public hasStoredSession(): boolean {
    if (typeof window === 'undefined') return false;
    return Boolean(localStorage.getItem(SESSION_STORAGE_KEY));
  }

  public resetSession(): void {
    if (this.client) {
      try { void this.client.disconnect(); } catch {}
      this.client = null;
    }
    this.user = null;
    this.currentPhone = '';
    this.currentPhoneCodeHash = '';
    this.connectingPromise = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  public async getClient(): Promise<TelegramClient> {
    if (this.client && this.client.connected) {
      return this.client;
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    const credentials = this.getApiCredentials();
    if (!credentials) {
      throw new Error('Telegram API credentials are required. Please configure your API ID and API Hash.');
    }

    const savedSession = typeof window !== 'undefined' ? (localStorage.getItem(SESSION_STORAGE_KEY) || '') : '';
    const session = new StringSession(savedSession);

    this.connectingPromise = (async () => {
      const client = new TelegramClient(session, credentials.apiId, credentials.apiHash, {
        connectionRetries: 5,
        useWSS: true,
      });
      await client.connect();
      this.client = client;
      return client;
    })().finally(() => {
      this.connectingPromise = null;
    });

    return this.connectingPromise;
  }

  public async authState(): Promise<TelegramAuthState> {
    const creds = this.getApiCredentials();
    if (!creds) {
      return { state: 'credentials_required' };
    }
    if (!this.hasStoredSession()) {
      if (this.currentPhone && this.currentPhoneCodeHash) {
        return { state: 'code_required' };
      }
      return { state: 'phone_required' };
    }
    try {
      const client = await this.getClient();
      const isAuth = await client.isUserAuthorized();
      if (isAuth) {
        await this.me();
        return { state: 'ready' };
      }
      return { state: 'phone_required' };
    } catch {
      return { state: 'phone_required' };
    }
  }

  public async authStart(phone: string, _consent = true): Promise<TelegramAuthState> {
    const creds = this.getApiCredentials();
    if (!creds) {
      return { state: 'credentials_required' };
    }
    const cleanPhone = phone.replace(/[^\d+]/g, '');
    this.currentPhone = cleanPhone;
    const client = await this.getClient();

    try {
      const result = await client.sendCode(creds, cleanPhone);
      this.currentPhoneCodeHash = result.phoneCodeHash;
      const isApp = (result as { isCodeViaApp?: boolean }).isCodeViaApp;
      return {
        state: 'code_required',
        delivery: isApp ? 'Telegram app' : 'SMS',
        hint: isApp ? 'Code sent to your other Telegram app session' : 'Code sent via SMS',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('FLOOD_WAIT')) {
        const seconds = parseInt(msg.replace(/\D/g, ''), 10) || 60;
        return { state: 'phone_required', retryAfterSeconds: seconds, hint: `Telegram rate limit. Wait ${seconds}s.` };
      }
      throw new Error(msg);
    }
  }

  public async authStep(type: 'code' | 'password', value: string): Promise<TelegramAuthState> {
    const creds = this.getApiCredentials();
    if (!creds) return { state: 'credentials_required' };
    const client = await this.getClient();

    if (type === 'code') {
      try {
        await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: this.currentPhone,
            phoneCodeHash: this.currentPhoneCodeHash,
            phoneCode: value.trim(),
          })
        );
        const sessionString = client.session.save() as unknown as string;
        localStorage.setItem(SESSION_STORAGE_KEY, sessionString);
        await this.me();
        return { state: 'ready' };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('SESSION_PASSWORD_NEEDED') || msg.includes('2FA')) {
          return {
            state: 'password_required',
            hint: 'Two-step verification password is required for this account.',
          };
        }
        throw new Error(msg);
      }
    } else if (type === 'password') {
      try {
        const passwordSrpResult = await client.invoke(new Api.account.GetPassword());
        const passwordSrpCheck = await computeCheck(passwordSrpResult, value);
        await client.invoke(
          new Api.auth.CheckPassword({
            password: passwordSrpCheck,
          })
        );
        const sessionString = client.session.save() as unknown as string;
        localStorage.setItem(SESSION_STORAGE_KEY, sessionString);
        await this.me();
        return { state: 'ready' };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(msg);
      }
    }

    return { state: 'phone_required' };
  }

  public async me(): Promise<TelegramUser> {
    if (this.user) return this.user;
    const client = await this.getClient();
    const me = await client.getMe();
    if (!me || typeof me !== 'object') {
      throw new Error('Not authenticated');
    }
    const rawMe = me as unknown as { id: { toString(): string }; firstName?: string; lastName?: string; username?: string; phone?: string; premium?: boolean };
    const userId = rawMe.id.toString();
    const fullName = [rawMe.firstName, rawMe.lastName].filter(Boolean).join(' ') || rawMe.username || 'Telegram User';

    const user: TelegramUser = {
      id: userId,
      telegram_user_id: userId,
      name: fullName,
      username: rawMe.username,
      phone: rawMe.phone,
      storage_selected: Boolean(localStorage.getItem(STORAGE_DESTINATION_KEY) || 'me'),
      telegram_connected: true,
      capabilities: {
        file_limit_bytes: rawMe.premium ? 4 * 1024 * 1024 * 1024 : 2 * 1024 * 1024 * 1024,
        remote_deletion: true,
      },
    };
    this.user = user;
    return user;
  }

  public selectStorage(destination = 'me'): void {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_DESTINATION_KEY, destination);
    }
    if (this.user) {
      this.user.storage_selected = true;
    }
  }

  public async upload(
    file: File,
    options: {
      folderId?: string | null;
      signal?: AbortSignal;
      onProgress?: (value: { bytes: number; expectedBytes: number; phase: 'preparing' | 'staging' | 'queued' }) => void;
    } = {}
  ): Promise<{ transfer: Transfer; file: DriveFile }> {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`File exceeds maximum allowed size of ${formatBytes(MAX_FILE_BYTES)}`);
    }

    const client = await this.getClient();
    const transferId = crypto.randomUUID();
    const fileId = crypto.randomUUID();

    options.onProgress?.({ bytes: 0, expectedBytes: file.size, phase: 'preparing' });

    let sentMessage: Api.Message;
    try {
      options.onProgress?.({ bytes: 0, expectedBytes: file.size, phase: 'staging' });

      // Direct browser upload to Saved Messages as an uncompressed original document
      const result = await client.sendFile('me', {
        file,
        caption: `CloudNest File: ${file.name}`,
        forceDocument: true,
        workers: 3,
        progressCallback: (progress: number) => {
          if (options.signal?.aborted) throw new Error('Upload cancelled');
          const loaded = Math.round(progress * file.size);
          options.onProgress?.({ bytes: loaded, expectedBytes: file.size, phase: 'staging' });
        },
      });

      sentMessage = result as unknown as Api.Message;
    } catch (error: unknown) {
      if (options.signal?.aborted) throw new Error('Upload cancelled');
      throw error;
    }

    options.onProgress?.({ bytes: file.size, expectedBytes: file.size, phase: 'queued' });

    const driveFile: DriveFile = {
      id: fileId,
      name: file.name,
      originalName: file.name,
      mime: file.type || 'application/octet-stream',
      bytes: file.size,
      kind: kindFor(file.type || '', file.name),
      folderId: options.folderId || null,
      favorite: false,
      createdAt: new Date().toISOString(),
      trashedAt: null,
      tags: [],
      source: 'server',
      availability: 'available',
      remoteMessageId: sentMessage.id,
      version: 1,
    };

    const transfer: Transfer = {
      id: transferId,
      name: file.name,
      bytes: file.size,
      status: 'completed',
      createdAt: new Date().toISOString(),
      providerBytes: file.size,
      stageBytes: file.size,
      source: 'server',
    };

    // Save to local catalog & sync
    await this.addFileToCatalog(driveFile);

    return { transfer, file: driveFile };
  }

  public async downloadFile(remoteMessageId: number, onProgress?: (progress: number) => void): Promise<Blob> {
    const client = await this.getClient();
    const messages = await client.getMessages('me', { ids: [remoteMessageId] });
    if (!messages || messages.length === 0 || !messages[0].media) {
      throw new Error('File message no longer exists in Telegram Saved Messages.');
    }
    const message = messages[0];
    const buffer = await client.downloadMedia(message, {
      progressCallback: onProgress ? (downloaded: unknown, total: unknown) => {
        if (typeof total === 'number' && total > 0 && typeof downloaded === 'number') {
          onProgress(downloaded / total);
        }
      } : undefined,
    });
    if (!buffer) {
      throw new Error('Failed to download media bytes.');
    }
    const bytes = typeof buffer === 'string' ? new TextEncoder().encode(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
    return new Blob([bytes as unknown as BlobPart]);
  }

  public async deleteFile(file: DriveFile): Promise<void> {
    if (file.remoteMessageId) {
      try {
        const client = await this.getClient();
        await client.deleteMessages('me', [file.remoteMessageId], { revoke: true });
      } catch (err) {
        console.warn('Could not delete Telegram remote message:', err);
      }
    }
    await this.removeFileFromCatalog(file.id);
  }

  // Catalog Synchronization across devices using Telegram Saved Messages
  public async loadCatalog(): Promise<Catalog> {
    const local = await loadCatalog();
    if (local && local.files && local.files.length > 0) {
      return local;
    }
    try {
      const restored = await this.restoreCatalogFromTelegram();
      if (restored) {
        await saveCatalog(restored);
        return restored;
      }
    } catch {
      // Return empty or local
    }
    return local || { schemaVersion: 1, files: [], folders: [], transfers: [] };
  }

  public async syncCatalogToTelegram(catalog: Catalog): Promise<void> {
    try {
      const client = await this.getClient();
      const content = JSON.stringify({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        folders: catalog.folders,
        files: catalog.files.map(f => ({
          id: f.id,
          name: f.name,
          originalName: f.originalName,
          mime: f.mime,
          bytes: f.bytes,
          kind: f.kind,
          folderId: f.folderId,
          favorite: f.favorite,
          createdAt: f.createdAt,
          trashedAt: f.trashedAt,
          tags: f.tags,
          remoteMessageId: f.remoteMessageId,
        })),
      });

      const blob = new Blob([content], { type: 'application/json' });
      const syncFile = new File([blob], 'cloudnest_catalog.json', { type: 'application/json' });

      await client.sendFile('me', {
        file: syncFile,
        caption: `${CATALOG_SYNC_TAG} CloudNest Catalog Backup (${new Date().toLocaleDateString()})`,
        forceDocument: true,
      });
    } catch (err) {
      console.warn('Could not sync catalog backup to Telegram:', err);
    }
  }

  public async restoreCatalogFromTelegram(): Promise<Catalog | null> {
    try {
      const client = await this.getClient();
      const messages = await client.getMessages('me', { search: CATALOG_SYNC_TAG, limit: 5 });
      if (!messages || messages.length === 0) return null;

      for (const msg of messages) {
        if (msg.message && msg.message.includes(CATALOG_SYNC_TAG) && msg.media) {
          const buffer = await client.downloadMedia(msg);
          if (buffer) {
            const bytes = typeof buffer === 'string' ? new TextEncoder().encode(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
            const text = new TextDecoder().decode(bytes);
            const parsed = JSON.parse(text);
            if (parsed.files && parsed.folders) {
              return {
                schemaVersion: 1,
                folders: parsed.folders,
                files: parsed.files.map((f: DriveFile) => ({ ...f, source: 'server', availability: 'available' })),
                transfers: [],
              };
            }
          }
        }
      }
    } catch (err) {
      console.warn('Could not restore catalog from Telegram:', err);
    }
    return null;
  }

  private async addFileToCatalog(file: DriveFile): Promise<void> {
    const catalog = await this.loadCatalog();
    const updated: Catalog = {
      ...catalog,
      files: [file, ...catalog.files.filter(f => f.id !== file.id)],
    };
    await commitCatalog(updated);
    void this.syncCatalogToTelegram(updated);
  }

  private async removeFileFromCatalog(fileId: string): Promise<void> {
    const catalog = await this.loadCatalog();
    const updated: Catalog = {
      ...catalog,
      files: catalog.files.filter(f => f.id !== fileId),
    };
    await commitCatalog(updated);
    void this.syncCatalogToTelegram(updated);
  }
}

export const telegramGateway = new TelegramBrowserGateway();
