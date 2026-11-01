import { Capacitor, registerPlugin } from '@capacitor/core';
import { FolderSyncSource } from './catalog';

export interface FolderSyncPluginInterface {
  isAvailable(): Promise<{ available: boolean }>;
  chooseFolder(): Promise<{ uri: string; name: string }>;
  listFiles(options: { uri: string }): Promise<{ files: Array<{ name: string; size: number; lastModified: number; mimeType: string; uri: string }> }>;
  readFilePart(options: { uri: string; offset: number; length: number }): Promise<{ data: string; bytesRead: number }>;
  getThumbnail?(options: { uri: string }): Promise<{ data: string }>;
}

export const NativeFolderSync = registerPlugin<FolderSyncPluginInterface>('FolderSync');

export async function getNativeThumbnail(uri: string): Promise<Blob | null> {
  if (!Capacitor.isNativePlatform() || !NativeFolderSync.getThumbnail) return null;
  try {
    const res = await NativeFolderSync.getThumbnail({ uri });
    if (!res || !res.data) return null;
    const binary = atob(res.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    // Verify complete JPEG (must have SOI 0xFF,0xD8 and EOI 0xFF,0xD9)
    if (bytes.length > 200 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
        console.warn('Incomplete native thumbnail received, skipping.');
        return null;
      }
    }
    return new Blob([bytes], { type: 'image/jpeg' });
  } catch {
    return null;
  }
}

export type SyncableItem = {
  name: string;
  size: number;
  lastModified: number;
  mimeType: string;
  uri?: string;
  file?: File;
};

// In-memory directory handles for web File System Access API
const webDirectoryHandles = new Map<string, FileSystemDirectoryHandle>();

export function isFolderSyncSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (Capacitor.isNativePlatform()) return true;
  return 'showDirectoryPicker' in window;
}

export async function pickFolderForSync(): Promise<{ source: FolderSyncSource; handle?: FileSystemDirectoryHandle } | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await NativeFolderSync.chooseFolder();
      if (!res || !res.uri) return null;
      return {
        source: {
          type: 'android_saf',
          uri: res.uri,
          pathName: res.name || 'Mobile Folder',
          lastSyncedAt: new Date().toISOString(),
          autoSync: true,
        }
      };
    } catch {
      return null;
    }
  }

  if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
    try {
      const handle = await (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
      return {
        source: {
          type: 'web_fs',
          pathName: handle.name || 'Desktop Folder',
          lastSyncedAt: new Date().toISOString(),
          autoSync: true,
        },
        handle,
      };
    } catch {
      return null;
    }
  }

  return null;
}

export function registerWebDirectoryHandle(folderId: string, handle: FileSystemDirectoryHandle) {
  webDirectoryHandles.set(folderId, handle);
}

export function getWebDirectoryHandle(folderId: string): FileSystemDirectoryHandle | undefined {
  return webDirectoryHandles.get(folderId);
}

export async function listFilesInFolder(source: FolderSyncSource, folderId: string): Promise<SyncableItem[]> {
  if (source.type === 'android_saf' && source.uri) {
    try {
      const res = await NativeFolderSync.listFiles({ uri: source.uri });
      return res.files || [];
    } catch {
      return [];
    }
  }

  if (source.type === 'web_fs') {
    const handle = webDirectoryHandles.get(folderId);
    if (!handle) return [];
    const items: SyncableItem[] = [];
    try {
      // Cast handle to any for async iteration over directory entries
      const entries = (handle as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values();
      for await (const entry of entries) {
        if (entry.kind === 'file') {
          const file = await (entry as FileSystemFileHandle).getFile();
          items.push({
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
            mimeType: file.type || 'application/octet-stream',
            file,
          });
        }
      }
    } catch {}
    return items;
  }

  return [];
}
