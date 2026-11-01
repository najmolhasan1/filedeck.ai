import { TelegramClient, Api } from 'telegram';
import { NewMessage } from 'telegram/events/index.js';
import { StringSession } from 'telegram/sessions/index.js';
import { computeCheck } from 'telegram/Password.js';
import { generateRandomBigInt } from 'telegram/Helpers.js';
import bigInt from 'big-integer';
import { Catalog, DriveFile, formatBytes, kindFor, MAX_FILE_BYTES, mergeCatalogs, Transfer } from './catalog';
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
    onProgress?: (bytes: number, total: number, resumeState: { fileId: string; startPart: number }) => void,
    caption?: string,
    resumeState?: { fileId?: string | bigInt.BigInteger; startPart?: number },
    thumbBlob?: Blob
  ): Promise<{ remoteMessageId: number; fileId: string }> {
    const client = await this.getClient();
    const partSize = 512 * 1024; // 512 KB per chunk
    const totalParts = Math.max(1, Math.ceil(file.size / partSize));
    const isBig = file.size > 10 * 1024 * 1024;
    // 64-bit ID for MTProto file handle (preserved across pauses/retries)
    const fileId: bigInt.BigInteger = resumeState?.fileId
      ? (typeof resumeState.fileId === 'string' ? bigInt(resumeState.fileId) : resumeState.fileId)
      : generateRandomBigInt();
    const startPart = Math.max(0, Math.min(totalParts - 1, resumeState?.startPart ?? 0));

    for (let i = startPart; i < totalParts; i++) {
      if (signal?.aborted) {
        const isPause = signal.reason === 'paused';
        const err = new Error(isPause ? 'Upload paused' : 'Upload cancelled') as Error & {
          resumeState?: { fileId: string; startPart: number };
          isPause?: boolean;
        };
        err.resumeState = { fileId: fileId.toString(), startPart: i };
        err.isPause = isPause;
        throw err;
      }

      const start = i * partSize;
      const end = Math.min(file.size, start + partSize);
      const chunk = file.slice(start, end);
      const arrayBuffer = await chunk.arrayBuffer();
      const bytes = Buffer.from(arrayBuffer);

      let attempts = 0;
      while (true) {
        if (signal?.aborted) {
          const isPause = signal.reason === 'paused';
          const err = new Error(isPause ? 'Upload paused' : 'Upload cancelled') as Error & {
            resumeState?: { fileId: string; startPart: number };
            isPause?: boolean;
          };
          err.resumeState = { fileId: fileId.toString(), startPart: i };
          err.isPause = isPause;
          throw err;
        }

        try {
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
          break;
        } catch (err: unknown) {
          if (signal?.aborted) {
            const isPause = signal.reason === 'paused';
            const pauseErr = new Error(isPause ? 'Upload paused' : 'Upload cancelled') as Error & {
              resumeState?: { fileId: string; startPart: number };
              isPause?: boolean;
            };
            pauseErr.resumeState = { fileId: fileId.toString(), startPart: i };
            pauseErr.isPause = isPause;
            throw pauseErr;
          }

          attempts++;
          const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
          if (isOffline || attempts >= 4) {
            const netErr = new Error(isOffline ? 'Network offline' : (err instanceof Error ? err.message : 'Network error')) as Error & {
              resumeState?: { fileId: string; startPart: number };
              isNetwork?: boolean;
            };
            netErr.resumeState = { fileId: fileId.toString(), startPart: i };
            netErr.isNetwork = true;
            throw netErr;
          }
          await new Promise((res) => setTimeout(res, 1000 * Math.min(attempts, 3)));
        }
      }

      onProgress?.(end, file.size, { fileId: fileId.toString(), startPart: i + 1 });
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

    let inputThumb: Api.TypeInputFile | undefined;
    if (thumbBlob && thumbBlob.size > 0) {
      try {
        const thumbFile = new File([thumbBlob], 'thumb.jpg', { type: 'image/jpeg' });
        inputThumb = await client.uploadFile({ file: thumbFile, workers: 1 });
      } catch (err) {
        console.warn('Could not upload thumbnail attachment:', err);
      }
    }

    const isVideo = (mimeType || '').startsWith('video/') || kindFor(mimeType || '', fileName) === 'video';
    const isImage = (mimeType || '').startsWith('image/') || kindFor(mimeType || '', fileName) === 'image';
    const attributes: Api.TypeDocumentAttribute[] = [
      new Api.DocumentAttributeFilename({ fileName }),
    ];
    if (isVideo) {
      attributes.push(
        new Api.DocumentAttributeVideo({
          duration: 0,
          w: 1280,
          h: 720,
          supportsStreaming: true,
        })
      );
    }

    const result = await client.invoke(
      new Api.messages.SendMedia({
        peer: 'me',
        media: new Api.InputMediaUploadedDocument({
          file: inputFile,
          thumb: inputThumb,
          mimeType: mimeType || 'application/octet-stream',
          attributes,
          forceFile: (isVideo || isImage) ? undefined : true,
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

    return { remoteMessageId: messageId, fileId: fileId.toString() };
  }

  public async upload(
    file: File,
    options: {
      folderId?: string | null;
      signal?: AbortSignal;
      resumeState?: { fileId?: string | bigInt.BigInteger; startPart?: number };
      thumbBlob?: Blob;
      onProgress?: (value: {
        bytes: number;
        expectedBytes: number;
        phase: 'preparing' | 'staging' | 'queued';
        resumeState?: { fileId: string; startPart: number };
      }) => void;
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
      const result = await this.uploadFileDirect(
        file,
        file.name,
        file.type,
        options.signal,
        (bytes, total, currentResumeState) => {
          options.onProgress?.({
            bytes,
            expectedBytes: total,
            phase: 'staging',
            resumeState: currentResumeState,
          });
        },
        undefined,
        options.resumeState,
        options.thumbBlob
      );
      remoteMessageId = result.remoteMessageId;
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        const isPause = options.signal.reason === 'paused';
        const err = new Error(isPause ? 'Upload paused' : 'Upload cancelled') as Error & {
          resumeState?: { fileId: string; startPart: number };
          isPause?: boolean;
        };
        if (error && typeof error === 'object' && 'resumeState' in error) {
          err.resumeState = (error as { resumeState?: { fileId: string; startPart: number } }).resumeState;
        }
        err.isPause = isPause;
        throw err;
      }
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
    onProgress?: (bytes: number, total: number, resumeState: { fileId: string; startPart: number }) => void,
    caption?: string,
    resumeState?: { fileId?: string | bigInt.BigInteger; startPart?: number },
    thumbBlob?: Blob
  ): Promise<{ remoteMessageId: number; fileId: string }> {
    const client = await this.getClient();
    const partSize = 512 * 1024; // 512 KB per chunk
    const totalParts = Math.max(1, Math.ceil(fileInfo.size / partSize));
    const isBig = fileInfo.size > 10 * 1024 * 1024;
    const fileId: bigInt.BigInteger = resumeState?.fileId
      ? (typeof resumeState.fileId === 'string' ? bigInt(resumeState.fileId) : resumeState.fileId)
      : generateRandomBigInt();
    const startPart = Math.max(0, Math.min(totalParts - 1, resumeState?.startPart ?? 0));

    for (let i = startPart; i < totalParts; i++) {
      if (signal?.aborted) {
        const isPause = signal.reason === 'paused';
        const err = new Error(isPause ? 'Upload paused' : 'Upload cancelled') as Error & {
          resumeState?: { fileId: string; startPart: number };
          isPause?: boolean;
        };
        err.resumeState = { fileId: fileId.toString(), startPart: i };
        err.isPause = isPause;
        throw err;
      }

      const start = i * partSize;
      const length = Math.min(partSize, fileInfo.size - start);

      let attempts = 0;
      while (true) {
        if (signal?.aborted) {
          const isPause = signal.reason === 'paused';
          const err = new Error(isPause ? 'Upload paused' : 'Upload cancelled') as Error & {
            resumeState?: { fileId: string; startPart: number };
            isPause?: boolean;
          };
          err.resumeState = { fileId: fileId.toString(), startPart: i };
          err.isPause = isPause;
          throw err;
        }

        try {
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
          break;
        } catch (err: unknown) {
          if (signal?.aborted) {
            const isPause = signal.reason === 'paused';
            const pauseErr = new Error(isPause ? 'Upload paused' : 'Upload cancelled') as Error & {
              resumeState?: { fileId: string; startPart: number };
              isPause?: boolean;
            };
            pauseErr.resumeState = { fileId: fileId.toString(), startPart: i };
            pauseErr.isPause = isPause;
            throw pauseErr;
          }

          attempts++;
          const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
          if (isOffline || attempts >= 4) {
            const netErr = new Error(isOffline ? 'Network offline' : (err instanceof Error ? err.message : 'Network error')) as Error & {
              resumeState?: { fileId: string; startPart: number };
              isNetwork?: boolean;
            };
            netErr.resumeState = { fileId: fileId.toString(), startPart: i };
            netErr.isNetwork = true;
            throw netErr;
          }
          await new Promise((res) => setTimeout(res, 1000 * Math.min(attempts, 3)));
        }
      }

      onProgress?.(start + length, fileInfo.size, { fileId: fileId.toString(), startPart: i + 1 });
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

    let inputThumb: Api.TypeInputFile | undefined;
    if (thumbBlob && thumbBlob.size > 0) {
      try {
        const thumbFile = new File([thumbBlob], 'thumb.jpg', { type: 'image/jpeg' });
        inputThumb = await client.uploadFile({ file: thumbFile, workers: 1 });
      } catch (err) {
        console.warn('Could not upload thumbnail attachment for native stream:', err);
      }
    }

    const isVideo = (fileInfo.mimeType || '').startsWith('video/') || kindFor(fileInfo.mimeType || '', fileInfo.name) === 'video';
    const isImage = (fileInfo.mimeType || '').startsWith('image/') || kindFor(fileInfo.mimeType || '', fileInfo.name) === 'image';
    const attributes: Api.TypeDocumentAttribute[] = [
      new Api.DocumentAttributeFilename({ fileName: fileInfo.name }),
    ];
    if (isVideo) {
      attributes.push(
        new Api.DocumentAttributeVideo({
          duration: 0,
          w: 1280,
          h: 720,
          supportsStreaming: true,
        })
      );
    }

    const result = await client.invoke(
      new Api.messages.SendMedia({
        peer: 'me',
        media: new Api.InputMediaUploadedDocument({
          file: inputFile,
          thumb: inputThumb,
          mimeType: fileInfo.mimeType || 'application/octet-stream',
          attributes,
          forceFile: (isVideo || isImage) ? undefined : true,
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

    return { remoteMessageId: messageId, fileId: fileId.toString() };
  }

  public async uploadNative(
    fileInfo: { name: string; size: number; mimeType: string; uri: string },
    options: {
      folderId?: string | null;
      signal?: AbortSignal;
      resumeState?: { fileId?: string | bigInt.BigInteger; startPart?: number };
      thumbBlob?: Blob;
      onProgress?: (value: {
        bytes: number;
        expectedBytes: number;
        phase: 'preparing' | 'staging' | 'queued';
        resumeState?: { fileId: string; startPart: number };
      }) => void;
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

      const result = await this.uploadNativeStream(
        fileInfo,
        options.signal,
        (bytes, total, currentResumeState) => {
          options.onProgress?.({
            bytes,
            expectedBytes: total,
            phase: 'staging',
            resumeState: currentResumeState,
          });
        },
        undefined,
        options.resumeState,
        options.thumbBlob
      );
      remoteMessageId = result.remoteMessageId;
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        const isPause = options.signal.reason === 'paused';
        const err = new Error(isPause ? 'Upload paused' : 'Upload cancelled') as Error & {
          resumeState?: { fileId: string; startPart: number };
          isPause?: boolean;
        };
        if (error && typeof error === 'object' && 'resumeState' in error) {
          err.resumeState = (error as { resumeState?: { fileId: string; startPart: number } }).resumeState;
        }
        err.isPause = isPause;
        throw err;
      }
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
      localUri: fileInfo.uri,
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
      | {
          signal?: AbortSignal;
          startOffset?: number;
          existingChunks?: (Buffer | Uint8Array)[];
          onProgress?: (progress: number, downloaded?: number, total?: number) => void;
          onChunk?: (chunk: Buffer | Uint8Array, totalDownloaded: number) => void;
        }
  ): Promise<Blob> {
    const onProgress = typeof optionsOrProgress === 'function' ? optionsOrProgress : optionsOrProgress?.onProgress;
    const signal = typeof optionsOrProgress === 'object' ? optionsOrProgress?.signal : undefined;
    const startOffset = (typeof optionsOrProgress === 'object' ? optionsOrProgress?.startOffset : 0) || 0;
    const onChunk = typeof optionsOrProgress === 'object' ? optionsOrProgress?.onChunk : undefined;

    if (signal?.aborted) {
      const isPause = signal.reason === 'paused';
      const err = new Error(isPause ? 'Download paused' : 'Download cancelled') as Error & { isPause?: boolean };
      err.isPause = isPause;
      throw err;
    }

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

    let totalSize = 0;
    if (message.media && 'document' in message.media && message.media.document && 'size' in message.media.document) {
      totalSize = toNum(message.media.document.size);
    }

    const accumulatedChunks: (Buffer | Uint8Array)[] = (typeof optionsOrProgress === 'object' && optionsOrProgress?.existingChunks)
      ? [...optionsOrProgress.existingChunks]
      : [];
    let downloadedBytes = startOffset;

    if (onProgress && totalSize > 0 && downloadedBytes > 0) {
      onProgress(Math.min(1, downloadedBytes / totalSize), downloadedBytes, totalSize);
    }

    try {
      const downloadIter = client.iterDownload({
        file: message.media,
        offset: bigInt(startOffset),
        requestSize: 512 * 1024,
      });

      for await (const chunk of downloadIter) {
        if (signal?.aborted) {
          const isPause = signal.reason === 'paused';
          const err = new Error(isPause ? 'Download paused' : 'Download cancelled') as Error & {
            isPause?: boolean;
            resumeState?: { downloadedBytes: number };
            chunks?: (Buffer | Uint8Array)[];
          };
          err.isPause = isPause;
          err.resumeState = { downloadedBytes };
          err.chunks = accumulatedChunks;
          throw err;
        }

        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        accumulatedChunks.push(buf);
        downloadedBytes += buf.length;
        onChunk?.(buf, downloadedBytes);

        if (onProgress) {
          if (totalSize > 0) {
            onProgress(Math.min(1, Math.max(0, downloadedBytes / totalSize)), downloadedBytes, totalSize);
          } else {
            onProgress(0, downloadedBytes, 0);
          }
        }
      }
    } catch (err: unknown) {
      if (signal?.aborted) {
        const isPause = signal.reason === 'paused';
        const pauseErr = new Error(isPause ? 'Download paused' : 'Download cancelled') as Error & {
          isPause?: boolean;
          resumeState?: { downloadedBytes: number };
          chunks?: (Buffer | Uint8Array)[];
        };
        pauseErr.isPause = isPause;
        pauseErr.resumeState = { downloadedBytes };
        pauseErr.chunks = accumulatedChunks;
        throw pauseErr;
      }

      const netErr = new Error(err instanceof Error ? err.message : 'Download interrupted') as Error & {
        isNetwork?: boolean;
        resumeState?: { downloadedBytes: number };
        chunks?: (Buffer | Uint8Array)[];
      };
      netErr.isNetwork = true;
      netErr.resumeState = { downloadedBytes };
      netErr.chunks = accumulatedChunks;
      throw netErr;
    }

    return new Blob(accumulatedChunks as unknown as BlobPart[]);
  }

  // Stream arbitrary chunk for instant video/audio playback
  public async getFileChunk(remoteMessageId: number, offset: number, length: number): Promise<Uint8Array> {
    const client = await this.getClient();
    const messages = await client.getMessages('me', { ids: [remoteMessageId] });
    if (!messages || messages.length === 0 || !messages[0].media) {
      throw new Error('Message not found');
    }
    const message = messages[0];
    const media = message.media;
    if (!media) throw new Error('No media');

    let location: Api.TypeInputFileLocation;

    if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
      const doc = media.document;
      location = new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: '',
      });
    } else if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
      const photo = media.photo;
      const largest = photo.sizes[photo.sizes.length - 1];
      location = new Api.InputPhotoFileLocation({
        id: photo.id,
        accessHash: photo.accessHash,
        fileReference: photo.fileReference,
        thumbSize: 'type' in largest ? largest.type : '',
      });
    } else {
      throw new Error('Unsupported media type for streaming');
    }

    // Telegram chunk offset must be a multiple of 4096 (4 KB) and limit multiple of 4096
    const alignedOffset = Math.floor(offset / 4096) * 4096;
    const alignedLimit = Math.ceil((offset - alignedOffset + length) / 4096) * 4096;

    const res = await client.invoke(
      new Api.upload.GetFile({
        location,
        offset: bigInt(alignedOffset),
        limit: Math.min(alignedLimit, 1024 * 1024),
      })
    );

    if (res instanceof Api.upload.File) {
      const rawBytes = res.bytes;
      const delta = offset - alignedOffset;
      const sliced = rawBytes.subarray(delta, delta + length);
      return sliced;
    }

    throw new Error('Could not get file chunk');
  }

  // Fast thumbnail downloader for images and videos (5-30 KB, ~30ms)
  // Ensures ONLY complete, valid, crisp thumbnails are returned — NEVER truncated grey boxes!
  public async downloadThumbnail(remoteMessageId: number): Promise<Blob | null> {
    try {
      const client = await this.getClient();
      const messages = await client.getMessages('me', { ids: [remoteMessageId] });
      if (!messages || messages.length === 0 || !messages[0].media) {
        return null;
      }
      const message = messages[0];
      const media = message.media;
      if (!media) return null;

      const isValidCompleteImage = (bytes: Uint8Array): boolean => {
        if (bytes.length < 200) return false;
        // If JPEG: must have SOI (0xFF,0xD8) and EOI (0xFF,0xD9)
        if (bytes[0] === 0xff && bytes[1] === 0xd8) {
          return bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
        }
        // If PNG
        if (bytes[0] === 0x89 && bytes[1] === 0x50) return true;
        // If WebP (RIFF)
        if (bytes[0] === 0x52 && bytes[1] === 0x49) return true;
        return true;
      };

      // 1. Photo media
      if (media instanceof Api.MessageMediaPhoto || ('photo' in media && media.photo)) {
        const photo = ('photo' in media && media.photo) ? (media.photo as Api.Photo) : (media as unknown as Api.Photo);
        if (photo && photo.sizes && photo.sizes.length > 0) {
          // Avoid PhotoStrippedSize which causes corrupt grey bottoms
          const validSizes = photo.sizes.filter(s => 
            !(s instanceof Api.PhotoStrippedSize) && 
            !(s instanceof Api.PhotoSizeEmpty) &&
            ('type' in s && s.type !== 'i')
          );
          if (validSizes.length > 0) {
            // Pick 'm' (medium ~320px) or 's' (small ~100px) or first valid size
            const targetThumb = validSizes.find(s => 'type' in s && s.type === 'm') || 
                                validSizes.find(s => 'type' in s && s.type === 's') || 
                                validSizes[0];
            const thumbType = ('type' in targetThumb && typeof targetThumb.type === 'string') ? targetThumb.type : 'm';
            try {
              const res = await client.invoke(
                new Api.upload.GetFile({
                  location: new Api.InputPhotoFileLocation({
                    id: photo.id,
                    accessHash: photo.accessHash,
                    fileReference: photo.fileReference,
                    thumbSize: thumbType,
                  }),
                  offset: bigInt.zero,
                  limit: 1048576,
                })
              );
              if (res instanceof Api.upload.File && res.bytes && res.bytes.length > 200) {
                const uint8 = new Uint8Array(res.bytes);
                if (isValidCompleteImage(uint8)) {
                  return new Blob([uint8 as unknown as BlobPart], { type: 'image/jpeg' });
                }
              }
            } catch (err) {
              console.warn('Direct photo thumbnail MTProto fetch failed:', err);
            }
          }
        }
      } 
      // 2. Document media (Video, Image, Audio, Document, etc.)
      else if (media instanceof Api.MessageMediaDocument || ('document' in media && media.document)) {
        const doc = ('document' in media && media.document) ? (media.document as Api.Document) : (media as unknown as Api.Document);
        if (doc && doc.thumbs && doc.thumbs.length > 0) {
          const validThumbs = doc.thumbs.filter(s => 
            !(s instanceof Api.PhotoStrippedSize) && 
            !(s instanceof Api.PhotoSizeEmpty) &&
            ('type' in s && s.type !== 'i')
          );
          if (validThumbs.length > 0) {
            const targetThumb = validThumbs.find(s => 'type' in s && s.type === 'm') || 
                                validThumbs.find(s => 'type' in s && s.type === 's') || 
                                validThumbs[0];
            const thumbType = ('type' in targetThumb && typeof targetThumb.type === 'string') ? targetThumb.type : 'm';
            try {
              const res = await client.invoke(
                new Api.upload.GetFile({
                  location: new Api.InputDocumentFileLocation({
                    id: doc.id,
                    accessHash: doc.accessHash,
                    fileReference: doc.fileReference,
                    thumbSize: thumbType,
                  }),
                  offset: bigInt.zero,
                  limit: 1048576,
                })
              );
              if (res instanceof Api.upload.File && res.bytes && res.bytes.length > 200) {
                const uint8 = new Uint8Array(res.bytes);
                if (isValidCompleteImage(uint8)) {
                  return new Blob([uint8 as unknown as BlobPart], { type: 'image/jpeg' });
                }
              }
            } catch (err) {
              console.warn('Direct document thumbnail MTProto fetch failed:', err);
            }
          }
        }

        // 3. Fallback: If no valid thumbnail exists, but file is a normal image under 4 MB:
        // Download the full image with downloadFile so it is guaranteed 100% complete!
        const mime = doc.mimeType || '';
        const fileNameAttr = doc.attributes?.find(a => 'fileName' in a && typeof a.fileName === 'string') as Api.DocumentAttributeFilename | undefined;
        const fn = fileNameAttr?.fileName || '';
        const isImg = mime.startsWith('image/') || /\.(jpe?g|png|webp|avif)$/i.test(fn);
        const docBytes = typeof doc.size === 'number' ? doc.size : (doc.size ? doc.size.toJSNumber() : 0);
        if (isImg && docBytes > 0 && docBytes <= 4 * 1024 * 1024) {
          try {
            const fullBlob = await this.downloadFile(remoteMessageId);
            if (fullBlob && fullBlob.size > 200) {
              return fullBlob;
            }
          } catch {}
        }
      }

      return null;
    } catch (err) {
      console.warn('Could not download thumbnail for remote message', remoteMessageId, err);
      return null;
    }
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

  private syncSubscribers: Set<(catalog: Catalog, newCount: number) => void> = new Set();
  private updateHandlerRegistered = false;

  public subscribeToSync(callback: (catalog: Catalog, newCount: number) => void): () => void {
    this.syncSubscribers.add(callback);
    void this.setupRealtimeListener();
    return () => {
      this.syncSubscribers.delete(callback);
    };
  }

  private async setupRealtimeListener(): Promise<void> {
    if (this.updateHandlerRegistered) return;
    try {
      const client = await this.getClient();
      const isAuth = await client.isUserAuthorized();
      if (!isAuth) return;
      this.updateHandlerRegistered = true;

      let debounceTimer: NodeJS.Timeout | null = null;
      client.addEventHandler(async () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            const result = await this.syncWithTelegram();
            for (const cb of this.syncSubscribers) {
              cb(result.catalog, result.newFilesCount);
            }
          } catch (e) {
            console.warn('Realtime sync handler error:', e);
          }
        }, 1200);
      }, new NewMessage({}));
    } catch (err) {
      console.warn('Could not setup realtime sync listener:', err);
    }
  }

  // Two-way catalog sync across devices (Web <-> Mobile)
  public async syncWithTelegram(currentCatalog?: Catalog): Promise<{ catalog: Catalog; newFilesCount: number }> {
    const baseCatalog = currentCatalog || (await loadCatalog()) || { schemaVersion: 1, files: [], folders: [], transfers: [] };
    try {
      const client = await this.getClient();
      const isAuth = await client.isUserAuthorized();
      if (!isAuth) {
        return { catalog: baseCatalog, newFilesCount: 0 };
      }

      // 1. Fetch remote catalog backup from Telegram
      const remoteCatalog = await this.restoreCatalogFromTelegram();
      // 2. Scan recent messages in Saved Messages for any files uploaded directly from other Telegram clients
      const scannedCatalog = await this.scanAndRecoverSavedMessages();

      let merged = baseCatalog;
      const initialFileIds = new Set(baseCatalog.files.map(f => f.remoteMessageId || f.id));

      if (remoteCatalog) {
        merged = mergeCatalogs(merged, remoteCatalog);
      }

      if (scannedCatalog && scannedCatalog.files.length > 0) {
        merged = mergeCatalogs(merged, scannedCatalog);
      }

      let newCount = 0;
      for (const f of merged.files) {
        const key = f.remoteMessageId || f.id;
        if (!initialFileIds.has(key)) {
          newCount++;
        }
      }

      // Save merged catalog to local IndexedDB
      await saveCatalog(merged);

      return { catalog: merged, newFilesCount: newCount };
    } catch (err) {
      console.warn('Sync with Telegram encountered error:', err);
      return { catalog: baseCatalog, newFilesCount: 0 };
    }
  }

  // Catalog Synchronization across devices using Telegram Saved Messages
  public async loadCatalog(): Promise<Catalog> {
    const local = await loadCatalog();
    if (local && local.files && local.files.length > 0) {
      // In background, sync latest from Telegram
      void this.syncWithTelegram(local).catch(() => {});
      return local;
    }
    try {
      const synced = await this.syncWithTelegram(local || undefined);
      if (synced && synced.catalog.files.length > 0) {
        return synced.catalog;
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
      // 1. First inspect the recent 25 messages in Saved Messages directly (fastest & most reliable)
      const recent = await client.getMessages('me', { limit: 25 });
      for (const msg of recent || []) {
        if (msg.media && 'document' in msg.media && msg.media.document) {
          const doc = msg.media.document as Api.Document;
          const isCatalogDoc = doc.attributes?.some(a => 'fileName' in a && (a.fileName === 'filedeck_catalog.json' || a.fileName === 'cloudnest_catalog.json'));
          const isCaption = msg.message && (msg.message.includes(CATALOG_SYNC_TAG) || msg.message.includes(LEGACY_CATALOG_SYNC_TAG));
          if (isCatalogDoc || isCaption) {
            const buf = await client.downloadMedia(msg);
            if (buf) {
              const str = Buffer.isBuffer(buf) ? buf.toString('utf8') : (typeof buf === 'string' ? buf : new TextDecoder().decode(buf as Uint8Array));
              try {
                const parsed = JSON.parse(str);
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
      }

      // 2. If not found in top 25 messages, search via Telegram search API
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
            const str = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : (typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer as Uint8Array));
            try {
              const parsed = JSON.parse(str);
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

  private syncCatalogTimer: ReturnType<typeof setTimeout> | null = null;

  public scheduleCatalogSyncToTelegram(catalog: Catalog, delayMs = 6000): void {
    if (this.syncCatalogTimer) {
      clearTimeout(this.syncCatalogTimer);
    }
    this.syncCatalogTimer = setTimeout(() => {
      this.syncCatalogTimer = null;
      void this.syncCatalogToTelegram(catalog);
    }, delayMs);
  }

  private async addFileToCatalog(file: DriveFile): Promise<void> {
    const catalog = await this.loadCatalog();
    const updated: Catalog = {
      ...catalog,
      files: [file, ...catalog.files.filter(f => f.id !== file.id)],
    };
    await commitCatalog(updated);
    this.scheduleCatalogSyncToTelegram(updated, 6000);
  }

  private async removeFileFromCatalog(fileId: string): Promise<void> {
    const catalog = await this.loadCatalog();
    const updated: Catalog = {
      ...catalog,
      files: catalog.files.filter(f => f.id !== fileId),
    };
    await commitCatalog(updated);
    this.scheduleCatalogSyncToTelegram(updated, 6000);
  }
}

export const telegramGateway = new TelegramBrowserGateway();
