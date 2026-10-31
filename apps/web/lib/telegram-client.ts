import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { computeCheck } from 'telegram/Password.js';
import { generateRandomBigInt } from 'telegram/Helpers.js';
import { Catalog, DriveFile, formatBytes, kindFor, MAX_FILE_BYTES, Transfer } from './catalog';
import { commitCatalog, loadCatalog, saveCatalog } from './storage';
import { NativeFolderSync } from './folder-sync';

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
const CATALOG_SYNC_TAG = '#filedeck_catalog_sync';
const LEGACY_CATALOG_SYNC_TAG = '#cloudnest_catalog_sync';

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

  public hasSession(): boolean {
    return this.hasStoredSession();
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

  // Direct MTProto chunked document uploader that streams memory-efficiently directly to Saved Messages
  public async uploadFileDirect(
    file: Blob,
    fileName: string,
    mimeType: string,
    signal?: AbortSignal,
    onProgress?: (bytes: number, total: number) => void,
    caption?: string
  ): Promise<number> {
    const client = await this.getClient();
    const partSize = 512 * 1024; // 512 KB per chunk
    const totalParts = Math.max(1, Math.ceil(file.size / partSize));
    const isBig = file.size > 10 * 1024 * 1024;
    // 64-bit random ID for MTProto file handle
    const fileId = generateRandomBigInt();

    for (let i = 0; i < totalParts; i++) {
      if (signal?.aborted) throw new Error('Upload cancelled');
      const start = i * partSize;
      const end = Math.min(file.size, start + partSize);
      const chunk = file.slice(start, end);
      const arrayBuffer = await chunk.arrayBuffer();
      const bytes = Buffer.from(arrayBuffer);

      if (isBig) {
        await client.invoke(
          new Api.upload.SaveBigFilePart({
            fileId,
            filePart: i,
            fileTotalParts: totalParts,
            bytes,
          })
        );
      } else {
        await client.invoke(
          new Api.upload.SaveFilePart({
            fileId,
            filePart: i,
            bytes,
          })
        );
      }

      onProgress?.(end, file.size);
    }

    const inputFile = isBig
      ? new Api.InputFileBig({
          id: fileId,
          parts: totalParts,
          name: fileName,
        })
      : new Api.InputFile({
          id: fileId,
          parts: totalParts,
          name: fileName,
          md5Checksum: '',
        });

    const result = await client.invoke(
      new Api.messages.SendMedia({
        peer: 'me',
        media: new Api.InputMediaUploadedDocument({
          file: inputFile,
          mimeType: mimeType || 'application/octet-stream',
          attributes: [
            new Api.DocumentAttributeFilename({ fileName }),
          ],
          forceFile: true,
        }),
        message: caption || `filedeck.ai File: ${fileName}`,
        randomId: generateRandomBigInt(),
      })
    );

    let messageId = 0;
    const raw = result as unknown as { id?: number; updates?: Array<{ id?: number; message?: { id?: number } }> };
    if (typeof raw.id === 'number') {
      messageId = raw.id;
    } else if (Array.isArray(raw.updates)) {
      for (const u of raw.updates) {
        if (u.message && typeof u.message.id === 'number') {
          messageId = u.message.id;
          break;
        } else if (typeof u.id === 'number') {
          messageId = u.id;
          break;
        }
      }
    }

    return messageId;
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

    const transferId = crypto.randomUUID();
    const fileId = crypto.randomUUID();

    options.onProgress?.({ bytes: 0, expectedBytes: file.size, phase: 'preparing' });

    let remoteMessageId = 0;
    try {
      options.onProgress?.({ bytes: 0, expectedBytes: file.size, phase: 'staging' });

      // Direct chunked upload to Telegram Saved Messages via MTProto
      remoteMessageId = await this.uploadFileDirect(
        file,
        file.name,
        file.type,
        options.signal,
        (bytes, total) => {
          options.onProgress?.({ bytes, expectedBytes: total, phase: 'staging' });
        }
      );
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
      remoteMessageId,
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

  // Direct MTProto streaming upload for native Android files without loading whole file to RAM
  public async uploadNativeStream(
    fileInfo: { name: string; size: number; mimeType: string; uri: string },
    signal?: AbortSignal,
    onProgress?: (bytes: number, total: number) => void,
    caption?: string
  ): Promise<number> {
    const client = await this.getClient();
    const partSize = 512 * 1024; // 512 KB per chunk
    const totalParts = Math.max(1, Math.ceil(fileInfo.size / partSize));
    const isBig = fileInfo.size > 10 * 1024 * 1024;
    const fileId = generateRandomBigInt();

    for (let i = 0; i < totalParts; i++) {
      if (signal?.aborted) throw new Error('Upload cancelled');
      const start = i * partSize;
      const length = Math.min(partSize, fileInfo.size - start);

      const partResult = await NativeFolderSync.readFilePart({
        uri: fileInfo.uri,
        offset: start,
        length,
      });

      const bytes = Buffer.from(partResult.data, 'base64');

      if (isBig) {
        await client.invoke(
          new Api.upload.SaveBigFilePart({
            fileId,
            filePart: i,
            fileTotalParts: totalParts,
            bytes,
          })
        );
      } else {
        await client.invoke(
          new Api.upload.SaveFilePart({
            fileId,
            filePart: i,
            bytes,
          })
        );
      }

      onProgress?.(start + bytes.length, fileInfo.size);
    }

    const inputFile = isBig
      ? new Api.InputFileBig({
          id: fileId,
          parts: totalParts,
          name: fileInfo.name,
        })
      : new Api.InputFile({
          id: fileId,
          parts: totalParts,
          name: fileInfo.name,
          md5Checksum: '',
        });

    const result = await client.invoke(
      new Api.messages.SendMedia({
        peer: 'me',
        media: new Api.InputMediaUploadedDocument({
          file: inputFile,
          mimeType: fileInfo.mimeType || 'application/octet-stream',
          attributes: [
            new Api.DocumentAttributeFilename({ fileName: fileInfo.name }),
          ],
          forceFile: true,
        }),
        message: caption || `filedeck.ai File: ${fileInfo.name}`,
        randomId: generateRandomBigInt(),
      })
    );

    let messageId = 0;
    const raw = result as unknown as { id?: number; updates?: Array<{ id?: number; message?: { id?: number } }> };
    if (typeof raw.id === 'number') {
      messageId = raw.id;
    } else if (Array.isArray(raw.updates)) {
      for (const u of raw.updates) {
        if (u.message && typeof u.message.id === 'number') {
          messageId = u.message.id;
          break;
        } else if (typeof u.id === 'number') {
          messageId = u.id;
          break;
        }
      }
    }

    return messageId;
  }

  public async uploadNative(
    fileInfo: { name: string; size: number; mimeType: string; uri: string },
    options: {
      folderId?: string | null;
      signal?: AbortSignal;
      onProgress?: (value: { bytes: number; expectedBytes: number; phase: 'preparing' | 'staging' | 'queued' }) => void;
    } = {}
  ): Promise<{ transfer: Transfer; file: DriveFile }> {
    if (fileInfo.size > MAX_FILE_BYTES) {
      throw new Error(`File exceeds maximum allowed size of ${formatBytes(MAX_FILE_BYTES)}`);
    }

    const transferId = crypto.randomUUID();
    const fileId = crypto.randomUUID();

    options.onProgress?.({ bytes: 0, expectedBytes: fileInfo.size, phase: 'preparing' });

    let remoteMessageId = 0;
    try {
      options.onProgress?.({ bytes: 0, expectedBytes: fileInfo.size, phase: 'staging' });

      remoteMessageId = await this.uploadNativeStream(
        fileInfo,
        options.signal,
        (bytes, total) => {
          options.onProgress?.({ bytes, expectedBytes: total, phase: 'staging' });
        }
      );
    } catch (error: unknown) {
      if (options.signal?.aborted) throw new Error('Upload cancelled');
      throw error;
    }

    options.onProgress?.({ bytes: fileInfo.size, expectedBytes: fileInfo.size, phase: 'queued' });

    const driveFile: DriveFile = {
      id: fileId,
      name: fileInfo.name,
      originalName: fileInfo.name,
      mime: fileInfo.mimeType || 'application/octet-stream',
      bytes: fileInfo.size,
      kind: kindFor(fileInfo.mimeType || '', fileInfo.name),
      folderId: options.folderId || null,
      favorite: false,
      createdAt: new Date().toISOString(),
      trashedAt: null,
      tags: [],
      source: 'server',
      availability: 'available',
      remoteMessageId,
      version: 1,
    };

    const transfer: Transfer = {
      id: transferId,
      name: fileInfo.name,
      bytes: fileInfo.size,
      status: 'completed',
      createdAt: new Date().toISOString(),
      providerBytes: fileInfo.size,
      stageBytes: fileInfo.size,
      source: 'server',
    };

    await this.addFileToCatalog(driveFile);

    return { transfer, file: driveFile };
  }

  public async downloadFile(
    remoteMessageId: number,
    optionsOrProgress?:
      | ((progress: number, downloaded?: number, total?: number) => void)
      | { signal?: AbortSignal; onProgress?: (progress: number, downloaded?: number, total?: number) => void }
  ): Promise<Blob> {
    const onProgress = typeof optionsOrProgress === 'function' ? optionsOrProgress : optionsOrProgress?.onProgress;
    const signal = typeof optionsOrProgress === 'object' ? optionsOrProgress?.signal : undefined;

    if (signal?.aborted) throw new Error('Download cancelled');

    const client = await this.getClient();
    const messages = await client.getMessages('me', { ids: [remoteMessageId] });
    if (!messages || messages.length === 0 || !messages[0].media) {
      throw new Error('File message no longer exists in Telegram Saved Messages.');
    }
    const message = messages[0];

    const toNum = (val: unknown): number => {
      if (typeof val === 'number') return val;
      if (typeof val === 'bigint') return Number(val);
      if (val && typeof val === 'object' && 'toJSNumber' in val && typeof (val as { toJSNumber: () => number }).toJSNumber === 'function') {
        return (val as { toJSNumber: () => number }).toJSNumber();
      }
      const str = String(val || '0');
      const n = Number(str);
      return Number.isFinite(n) ? n : 0;
    };

    const buffer = await client.downloadMedia(message, {
      progressCallback: (downloaded: unknown, total: unknown) => {
        if (signal?.aborted) throw new Error('Download cancelled');
        if (onProgress) {
          const d = toNum(downloaded);
          const t = toNum(total);
          if (t > 0) {
            onProgress(Math.min(1, Math.max(0, d / t)), d, t);
          } else if (d > 0) {
            onProgress(0, d, 0);
          }
        }
      },
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
      const scanned = await this.scanAndRecoverSavedMessages();
      if (scanned && scanned.files.length > 0) {
        await saveCatalog(scanned);
        return scanned;
      }
    } catch {
      // Return empty or local
    }
    return local || { schemaVersion: 1, files: [], folders: [], transfers: [] };
  }

  public async syncCatalogToTelegram(catalog: Catalog): Promise<void> {
    try {
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
      await this.uploadFileDirect(
        blob,
        'filedeck_catalog.json',
        'application/json',
        undefined,
        undefined,
        `${CATALOG_SYNC_TAG} filedeck.ai Catalog Backup`
      );
    } catch (err) {
      console.warn('Could not sync catalog backup to Telegram:', err);
    }
  }

  public async restoreCatalogFromTelegram(): Promise<Catalog | null> {
    try {
      const client = await this.getClient();
      let messages = await client.getMessages('me', { search: CATALOG_SYNC_TAG, limit: 10 });
      if (!messages || messages.length === 0) {
        messages = await client.getMessages('me', { search: 'filedeck_catalog.json', limit: 10 });
      }
      if (!messages || messages.length === 0) {
        messages = await client.getMessages('me', { search: LEGACY_CATALOG_SYNC_TAG, limit: 10 });
      }
      if (!messages || messages.length === 0) return null;

      for (const msg of messages) {
        if (msg.media) {
          const buffer = await client.downloadMedia(msg);
          if (buffer) {
            const bytes = typeof buffer === 'string' ? new TextEncoder().encode(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
            const text = new TextDecoder().decode(bytes);
            try {
              const parsed = JSON.parse(text);
              if (parsed && Array.isArray(parsed.files)) {
                return {
                  schemaVersion: 1,
                  folders: Array.isArray(parsed.folders) ? parsed.folders : [],
                  files: parsed.files.map((f: DriveFile) => ({ ...f, source: 'server', availability: 'available' })),
                  transfers: [],
                };
              }
            } catch {}
          }
        }
      }
    } catch (err) {
      console.warn('Could not restore catalog from Telegram:', err);
    }
    return null;
  }

  public async scanAndRecoverSavedMessages(): Promise<Catalog | null> {
    try {
      const client = await this.getClient();
      const messages = await client.getMessages('me', { limit: 100 });
      if (!messages || messages.length === 0) return null;

      const recoveredFiles: DriveFile[] = [];
      const seenIds = new Set<number>();

      for (const msg of messages) {
        if (!msg.media || seenIds.has(msg.id)) continue;
        seenIds.add(msg.id);

        let fileName = '';
        let mime = 'application/octet-stream';
        let size = 0;

        const media = msg.media as unknown as {
          document?: {
            id?: unknown;
            size?: number | bigint;
            mimeType?: string;
            attributes?: Array<{ className?: string; fileName?: string }>;
          };
        };

        if (media.document) {
          size = Number(media.document.size || 0);
          mime = media.document.mimeType || 'application/octet-stream';
          if (Array.isArray(media.document.attributes)) {
            for (const attr of media.document.attributes) {
              if (attr.fileName) {
                fileName = attr.fileName;
                break;
              }
            }
          }
        }

        if (!fileName && msg.message) {
          if (msg.message.startsWith('filedeck.ai File: ')) {
            fileName = msg.message.replace('filedeck.ai File: ', '').trim();
          }
        }

        if (fileName === 'filedeck_catalog.json' || fileName === 'cloudnest_catalog.json') continue;

        if (fileName) {
          recoveredFiles.push({
            id: `tg-${msg.id}`,
            name: fileName,
            originalName: fileName,
            mime,
            bytes: size,
            kind: kindFor(mime, fileName),
            folderId: null,
            favorite: false,
            createdAt: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
            trashedAt: null,
            tags: [],
            source: 'server',
            availability: 'available',
            remoteMessageId: msg.id,
            version: 1,
          });
        }
      }

      if (recoveredFiles.length > 0) {
        return {
          schemaVersion: 1,
          folders: [],
          files: recoveredFiles,
          transfers: [],
        };
      }
    } catch (err) {
      console.warn('Could not scan Saved Messages:', err);
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
