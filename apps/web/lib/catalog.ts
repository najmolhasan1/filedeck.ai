export type FileKind = 'image' | 'video' | 'document' | 'audio' | 'other';
export type DriveFile = {
  id: string; name: string; originalName: string; mime: string; bytes: number;
  kind: FileKind; folderId: string | null; favorite: boolean; createdAt: string;
  trashedAt: string | null; asset?: string; sha256?: string; tags: string[];
  version?: number; source?: 'server' | 'browser'; availability?: string; originalId?: string;
  remoteMessageId?: number;
  localUri?: string;
};
export type FolderSyncSource = {
  type: 'android_saf' | 'web_fs';
  uri?: string;
  pathName?: string;
  lastSyncedAt?: string;
  autoSync?: boolean;
};
export type FolderKind = 'all' | 'image' | 'video' | 'document' | 'audio';

export type Folder = {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  kind?: FolderKind;
  version?: number;
  syncSource?: FolderSyncSource;
};

export function getFolderKind(folder: Folder): FolderKind {
  if (folder.kind && ['all','image','video','document','audio'].includes(folder.kind)) {
    return folder.kind;
  }
  const lower = (folder.name || '').toLowerCase();
  if (lower.includes('photo') || lower.includes('image') || lower.includes('picture') || lower.includes('camera') || lower.includes('ছবি')) return 'image';
  if (lower.includes('video') || lower.includes('movie') || lower.includes('film') || lower.includes('ভিডিও')) return 'video';
  if (lower.includes('doc') || lower.includes('pdf') || lower.includes('sheet') || lower.includes('note') || lower.includes('ডকুমেন্ট')) return 'document';
  if (lower.includes('audio') || lower.includes('music') || lower.includes('song') || lower.includes('mp3') || lower.includes('গান') || lower.includes('অডিও')) return 'audio';
  return 'all';
}
export type Transfer = {
  id: string; name: string; bytes: number;
  status: 'saving' | 'queued' | 'sending' | 'verifying' | 'waiting' | 'reconciling' | 'completed' | 'failed' | 'cancelled' | 'paused';
  error?: string; createdAt: string; state?: string; stagedBytes?: number; stageBytes?: number; providerBytes?: number;
  retryAfterSeconds?: number; source?: 'server';
  direction?: 'upload' | 'download';
  kind?: FileKind;
  resumeState?: { fileId?: string; startPart?: number; downloadedBytes?: number };
};
export type Catalog = {schemaVersion: 1; files: DriveFile[]; folders: Folder[]; transfers: Transfer[]};
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export function kindFor(mime: string, name: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','svg','avif','bmp','ico'].includes(ext)) return 'image';
  if (mime.startsWith('video/') || ['mp4','webm','mov','mkv','avi','m4v'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3','wav','ogg','m4a','flac','aac','wma'].includes(ext)) return 'audio';
  if (mime.startsWith('text/') || /\.(pdf|docx?|xlsx?|pptx?|md|csv|txt|log|json|xml|html)$/i.test(name)) return 'document';
  return 'other';
}
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${Number((bytes / 1024 ** i).toFixed(i ? 1 : 0))} ${['B','KB','MB','GB','TB'][i]}`;
}
export function safePreview(file: DriveFile): 'image' | 'video' | 'audio' | 'pdf' | null {
  const mime = (file.mime || '').toLowerCase();
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['image/jpeg','image/png','image/webp','image/gif','image/avif','image/svg+xml'].includes(mime) || ['jpg','jpeg','png','webp','gif','svg','avif','bmp','ico'].includes(ext) || file.kind === 'image') return 'image';
  if (['video/mp4','video/webm','video/ogg','video/quicktime','video/x-matroska','video/3gpp','video/avi'].includes(mime) || ['mp4','webm','mov','mkv','m4v','ogv','3gp'].includes(ext) || file.kind === 'video') return 'video';
  if (['audio/mpeg','audio/wav','audio/ogg','audio/mp4','audio/aac','audio/flac','audio/x-m4a'].includes(mime) || ['mp3','wav','ogg','m4a','aac','flac','wma'].includes(ext) || file.kind === 'audio') return 'audio';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  return null;
}
export function canMoveFolder(folders: Folder[], id: string, parentId: string | null): boolean {
  let cursor = parentId; let depth = 0; const seen = new Set<string>();
  while (cursor) {
    if (cursor === id || seen.has(cursor) || ++depth >= 10) return false;
    seen.add(cursor); const parent = folders.find(f => f.id === cursor);
    if (!parent) return false;
    cursor = parent.parentId;
  }
  const descendantDepth = (folderId: string): number => {
    const children = folders.filter(f => f.parentId === folderId);
    return children.length ? 1 + Math.max(...children.map(f => descendantDepth(f.id))) : 1;
  };
  return depth + descendantDepth(id) <= 10;
}
const sample = (id: string, name: string, mime: string, bytes: number, folderId: string | null, asset: string, favorite = false): DriveFile => ({
  id, name, originalName: name, mime, bytes, folderId, asset, favorite, kind: kindFor(mime,name),
  createdAt: '2026-10-29T09:30:00.000Z', trashedAt: null, tags: []
});
export function initialCatalog(): Catalog {
  return {schemaVersion: 1, folders: [
    {id:'personal', name:'Personal', parentId:null, color:'green'},
    {id:'work', name:'Work & projects', parentId:null, color:'blue'},
    {id:'memories', name:'Travel memories', parentId:null, color:'peach'},
    {id:'documents', name:'Documents', parentId:null, color:'purple'}
  ], files: [
    sample('coast','A quiet afternoon.jpg','image/jpeg',126186,'memories','/images/coast.jpg',true),
    sample('brief','Project brief.pdf','application/pdf',1042,'work','/samples/project-brief.pdf',true),
    sample('mountain','Somewhere in the mountains.jpg','image/jpeg',180646,'memories','/images/mountain.jpg'),
    sample('desk','A space to create.jpg','image/jpeg',132457,'personal','/images/desk.jpg'),
    sample('forest','Into the green.jpg','image/jpeg',152539,'memories','/images/forest.jpg',true),
    sample('notes','Little things to remember.md','text/markdown',265,'personal','/samples/notes.md'),
    sample('budget','October budget.csv','text/csv',125,'documents','/samples/budget.csv'),
    sample('welcome','Welcome to filedeck.ai.txt','text/plain',511,null,'/samples/welcome.txt')
  ], transfers: []};
}

export function mergeCatalogs(local: Catalog, remote: Catalog): Catalog {
  const folderMap = new Map<string, Folder>();
  for (const f of local.folders || []) {
    folderMap.set(f.id, f);
  }
  for (const f of remote.folders || []) {
    if (!folderMap.has(f.id)) {
      folderMap.set(f.id, f);
    } else {
      const existing = folderMap.get(f.id)!;
      folderMap.set(f.id, {
        ...existing,
        ...f,
        syncSource: existing.syncSource || f.syncSource,
      });
    }
  }

  const fileMap = new Map<string, DriveFile>();
  const remoteMessageIdMap = new Map<number, string>();

  for (const f of remote.files || []) {
    fileMap.set(f.id, f);
    if (f.remoteMessageId) {
      remoteMessageIdMap.set(f.remoteMessageId, f.id);
    }
  }

  for (const f of local.files || []) {
    let targetKey = f.id;
    if (f.remoteMessageId && remoteMessageIdMap.has(f.remoteMessageId)) {
      targetKey = remoteMessageIdMap.get(f.remoteMessageId)!;
    }

    if (!fileMap.has(targetKey)) {
      fileMap.set(f.id, f);
      if (f.remoteMessageId) {
        remoteMessageIdMap.set(f.remoteMessageId, f.id);
      }
    } else {
      const existingRemote = fileMap.get(targetKey)!;
      fileMap.set(targetKey, {
        ...existingRemote,
        ...f,
        name: f.name || existingRemote.name,
        favorite: f.favorite || existingRemote.favorite,
        folderId: f.folderId !== undefined ? f.folderId : existingRemote.folderId,
        trashedAt: f.trashedAt || existingRemote.trashedAt,
        remoteMessageId: f.remoteMessageId || existingRemote.remoteMessageId,
        localUri: f.localUri || existingRemote.localUri,
        source: 'server',
        availability: 'available',
      });
    }
  }

  // Deduplicate any exact duplicate file records (same folder, same name, same size)
  const dedupedFiles: DriveFile[] = [];
  const seenSignatures = new Map<string, number>();

  for (const f of fileMap.values()) {
    if (f.trashedAt) {
      dedupedFiles.push(f);
      continue;
    }
    const sig = `${f.folderId || 'root'}_${(f.originalName || f.name).toLowerCase()}_${f.bytes}`;
    if (!seenSignatures.has(sig)) {
      seenSignatures.set(sig, dedupedFiles.length);
      dedupedFiles.push(f);
    } else {
      const idx = seenSignatures.get(sig)!;
      const existing = dedupedFiles[idx];
      dedupedFiles[idx] = {
        ...existing,
        localUri: existing.localUri || f.localUri,
        remoteMessageId: existing.remoteMessageId || f.remoteMessageId,
        favorite: existing.favorite || f.favorite,
        tags: Array.from(new Set([...(existing.tags || []), ...(f.tags || [])])),
        createdAt: existing.createdAt < f.createdAt ? existing.createdAt : f.createdAt,
      };
    }
  }

  return {
    schemaVersion: 1,
    folders: Array.from(folderMap.values()),
    files: dedupedFiles,
    transfers: local.transfers || [],
  };
}
