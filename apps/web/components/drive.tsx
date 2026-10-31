'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowUpFromLine, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Cloud, CloudUpload, Download, Ellipsis, File, FileAudio, FileImage, FileText, Film, Folder as FolderIcon, FolderOpen, Grid2X2, HardDrive, Heart, Image, Info, Languages, LayoutGrid, List, LoaderCircle, Menu, Music2, Pause, Play, Plus, RefreshCw, RotateCcw, RotateCw, Search, Send, Settings2, ShieldCheck, SlidersHorizontal, Smartphone, Sparkles, Star, Tag, Trash2, Upload, Volume2, VolumeX, Wifi, X } from 'lucide-react';
import { canMoveFolder, Catalog, DriveFile, FileKind, Folder, FolderKind, getFolderKind, Transfer, formatBytes, initialCatalog, kindFor, MAX_FILE_BYTES, safePreview } from '@/lib/catalog';
import { commitCatalog, getOriginal, loadCatalog, saveCatalog, saveOriginal } from '@/lib/storage';
import { APIError, ServerGateway, type ServerUser, type UploadDescriptor } from '@/lib/server';
import { telegramGateway, type TelegramUser } from '@/lib/telegram-client';
import ConnectPanel from './connect-panel';
import { parseCatalogImport } from '@/lib/catalog-import';
import { pickFolderForSync, listFilesInFolder, registerWebDirectoryHandle } from '@/lib/folder-sync';

const thumbnailCache = new Map<string, string>();
const videoFrameCache = new Map<string, string>();
const mediaBlobUrlCache = new Map<string, string>();

type ActiveTransferTask = {
  id: string;
  type: 'upload' | 'download' | 'native-upload';
  file?: File;
  nativeFileInfo?: { name: string; size: number; mimeType: string; uri: string };
  remoteMessageId?: number;
  fileName: string;
  folderId?: string | null;
  totalBytes: number;
  controller: AbortController;
  resumeState?: { fileId?: string; startPart?: number; downloadedBytes?: number };
  accumulatedChunks?: (Buffer | Uint8Array)[];
};

type View = 'all' | 'photos' | 'videos' | 'documents' | 'audio' | 'favorites' | 'recent' | 'trash' | 'transfers';
type Dialog = {type: 'new-folder'} | {type: 'rename'; file: DriveFile} | {type: 'move'; ids: string[]} | {type: 'settings' | 'connect' | 'help' | 'security' | 'disconnect' | 'recovery'} | {type: 'remove'; ids: string[]} | {type: 'folder'; folder: Folder};
const viewLabels: Record<View,[string,string]> = {all:['My drive','আমার ড্রাইভ'],photos:['Photos','ছবি'],videos:['Videos','ভিডিও'],documents:['Documents','ডকুমেন্ট'],audio:['Audio','অডিও'],favorites:['Favorites','পছন্দের ফাইল'],recent:['Recent files','সাম্প্রতিক ফাইল'],trash:['Trash','ট্র্যাশ'],transfers:['Transfers','ট্রান্সফার']};
const icons = {all: HardDrive, photos: Image, videos: Film, documents: FileText, audio: Music2, favorites: Star, recent: Archive, trash: Trash2, transfers: ArrowDownToLine};

function Modal({children, title, onClose, wide = false}: {children: React.ReactNode; title: string; onClose: () => void; wide?: boolean}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const element = ref.current; element?.querySelector<HTMLElement>('input, button, select')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && element) {
        const items = element.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, a[href], textarea');
        const first = items[0], last = items[items.length-1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown',key); return () => {document.removeEventListener('keydown',key); before?.focus();};
  },[onClose]);
  return <div className="modal-backdrop" onMouseDown={event => {if (event.target === event.currentTarget) onClose();}}><div ref={ref} className={`modal ${wide?'modal-wide':''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>{children}</div></div>;
}

function TypeIcon({kind,size=21}: {kind: FileKind;size?: number}) {const Icon = kind==='image'?FileImage:kind==='video'?Film:kind==='audio'?FileAudio:FileText; return <Icon size={size}/>;}
function Brand({small=false}: {small?: boolean}) {return <div className={`brand ${small?'brand-small':''}`}><div className="brand-mark"><Cloud size={25} strokeWidth={2.2}/><span/></div><span>filedeck<span className="brand-dot">.ai</span></span></div>;}

const CACHED_CATALOG_KEY='filedeck_cached_catalog';

export default function Drive() {
  const serverMode=process.env.NEXT_PUBLIC_STORAGE_MODE==='server';
  const hasInitialSession=typeof window!=='undefined'&&telegramGateway.hasSession();
  const emptyCatalog=():Catalog=>({schemaVersion:1,files:[],folders:[],transfers:[]});
  const [catalog,renderCatalog]=useState<Catalog>(()=>{
    if(serverMode)return emptyCatalog();
    if(hasInitialSession){
      try{
        const cached=localStorage.getItem(CACHED_CATALOG_KEY);
        if(cached){
          const parsed=JSON.parse(cached);
          if(parsed?.schemaVersion===1)return parsed;
        }
      }catch{}
      return emptyCatalog();
    }
    return initialCatalog();
  });
  const [ready,setReady]=useState(false);
  const [account,setAccount]=useState<ServerUser|TelegramUser|null>(null);
  const [serverError,setServerError]=useState('');
  const [syncJob,setSyncJob]=useState<Record<string,unknown>|null>(null);
  const [pendingUploads,setPendingUploads]=useState<UploadDescriptor[]>([]);
  const [hiddenTransfers,setHiddenTransfers]=useState<Set<string>>(new Set());
  const [locale,setLocale]=useState<'en'|'bn'>('en');
  const [view,setView]=useState<View>('all');
  const [folderId,setFolderId]=useState<string|null>(null);
  const [search,setSearch]=useState('');
  const [layout,setLayout]=useState<'grid'|'list'>('grid');
  const [sort,setSort]=useState('recent');
  const [kind,setKind]=useState('all');
  const [dateFilter,setDateFilter]=useState('all');
  const [filters,setFilters]=useState(false);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [dialog,setDialog]=useState<Dialog|null>(null);
  const [preview,setPreview]=useState<DriveFile|null>(null);
  const [previewUrl,setPreviewUrl]=useState<string|null>(null);
  const [previewError,setPreviewError]=useState('');
  const [previewProgress,setPreviewProgress]=useState<number|null>(null);
  const [previewBytes,setPreviewBytes]=useState<{current:number;total:number}|null>(null);
  const [dockOpen,setDockOpen]=useState(false);
  const [dismissedDock,setDismissedDock]=useState(true);
  const sessionTransfersRef=useRef<Set<string>>(new Set());
  const activeTransferTasks=useRef<Map<string,ActiveTransferTask>>(new Map());
  const [toast,setToast]=useState('');
  const [activeAudioFile,setActiveAudioFile]=useState<DriveFile|null>(null);
  const [isPlayingAudio,setIsPlayingAudio]=useState(false);
  const [audioLoading,setAudioLoading]=useState(false);
  const [audioProgress,setAudioProgress]=useState(0);
  const [audioCurrentTime,setAudioCurrentTime]=useState(0);
  const [audioDuration,setAudioDuration]=useState(0);
  const [isMuted,setIsMuted]=useState(false);
  const audioRef=useRef<HTMLAudioElement|null>(null);
  const audioObjectUrlRef=useRef<string|null>(null);
  const [mobileNav,setMobileNav]=useState(false);
  const [menu,setMenu]=useState<string|null>(null);
  const [hero,setHero]=useState(()=>!hasInitialSession);
  const [dragging,setDragging]=useState(false);
  const [folderKindChoice,setFolderKindChoice]=useState<FolderKind>('all');
  const [formValue,setFormValue]=useState('');
  const [formError,setFormError]=useState('');
  const [savingForm,setSavingForm]=useState(false);
  const [moveTarget,setMoveTarget]=useState('');
  const [tagValue,setTagValue]=useState('');
  const [isSyncingFolder,setIsSyncingFolder]=useState<string|null>(null);
  const fileInput=useRef<HTMLInputElement>(null);
  const importInput=useRef<HTMLInputElement>(null);
  const [importCandidate,setImportCandidate]=useState<Catalog|null>(null);
  const [importError,setImportError]=useState('');
  const [duplicatePrompt,setDuplicatePrompt]=useState<{name:string;existing:DriveFile;reuseAvailable:boolean}|null>(null);
  const duplicateDecision=useRef<((choice:'keep'|'reuse'|'cancel')=>void)|null>(null);
  const searchInput=useRef<HTMLInputElement>(null);
  const cancelUploads=useRef(new Set<string>());
  const catalogRef=useRef(catalog);
  const readyRef=useRef(false);
  const writes=useRef<Promise<unknown>>(Promise.resolve());
  const draggingDepth=useRef(0);
  const gatewayRef=useRef<ServerGateway|null>(null);
  if(!gatewayRef.current)gatewayRef.current=new ServerGateway();
  const gateway=gatewayRef.current;
  const resumeTarget=useRef<string|undefined>(undefined);
  const controllers=useRef(new Map<string,AbortController>());
  const sessionEpoch=useRef(0);
  const activeAccount=useRef<string|undefined>(undefined);
  const transientTransfers=useRef(new Map<string,Transfer>());
  const resetRuntime=()=>{
    sessionEpoch.current++;
    for(const controller of controllers.current.values())controller.abort();
    controllers.current.clear();
    for(const task of activeTransferTasks.current.values())task.controller.abort();
    activeTransferTasks.current.clear();
    sessionTransfersRef.current.clear();
    transientTransfers.current.clear();
    activeAccount.current=undefined;
    setSyncJob(null);
    gateway.resetSession();
  };
  const t=(en:string,bn:string)=>locale==='bn'?bn:en;
  const notify=useCallback((message:string)=>setToast(message),[]);

  const formatAudioTime=(sec:number)=>{
    if(!sec||isNaN(sec))return '0:00';
    const m=Math.floor(sec/60);
    const s=Math.floor(sec%60);
    return `${m}:${s<10?'0':''}${s}`;
  };

  const toggleAudioPlay=useCallback(async(file:DriveFile)=>{
    if(activeAudioFile?.id===file.id){
      if(audioRef.current){
        if(isPlayingAudio){
          audioRef.current.pause();
          setIsPlayingAudio(false);
        }else{
          audioRef.current.play().then(()=>setIsPlayingAudio(true)).catch(()=>{});
        }
      }
      return;
    }
    setActiveAudioFile(file);
    setIsPlayingAudio(false);
    setAudioLoading(true);
    setAudioProgress(0);
    setAudioCurrentTime(0);
    setAudioDuration(0);
    if(audioObjectUrlRef.current){
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current=null;
    }
    try{
      let playUrl='';
      if(mediaBlobUrlCache.has(file.id)){
        playUrl=mediaBlobUrlCache.get(file.id)!;
      }else{
        const cached=await getOriginal(file.originalId||file.id);
        if(cached){
          playUrl=URL.createObjectURL(cached);
          audioObjectUrlRef.current=playUrl;
          mediaBlobUrlCache.set(file.id,playUrl);
        }else if(file.remoteMessageId){
          const blob=await telegramGateway.downloadFile(file.remoteMessageId);
          void saveOriginal(file.id,blob);
          playUrl=URL.createObjectURL(blob);
          audioObjectUrlRef.current=playUrl;
          mediaBlobUrlCache.set(file.id,playUrl);
        }else if(file.asset){
          playUrl=file.asset;
        }else if(serverMode&&file.source==='server'){
          playUrl=gateway.contentUrl(file.id);
        }
      }
      if(playUrl&&audioRef.current){
        audioRef.current.src=playUrl;
        audioRef.current.load();
        await audioRef.current.play();
        setIsPlayingAudio(true);
      }
    }catch(err){
      console.warn('Audio playback error',err);
      notify(t('Could not load audio. Try again or download.','অডিও লোড করা যায়নি। আবার চেষ্টা করুন বা ডাউনলোড করুন।'));
    }finally{
      setAudioLoading(false);
    }
  },[activeAudioFile?.id,isPlayingAudio,serverMode,gateway,t,notify]);

  const closeAudioPlayer=useCallback(()=>{
    if(audioRef.current){
      audioRef.current.pause();
      audioRef.current.src='';
    }
    if(audioObjectUrlRef.current){
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current=null;
    }
    setActiveAudioFile(null);
    setIsPlayingAudio(false);
    setAudioProgress(0);
    setAudioCurrentTime(0);
  },[]);

  const handleSeek=(pct:number)=>{
    if(audioRef.current&&audioRef.current.duration){
      const target=(pct/100)*audioRef.current.duration;
      audioRef.current.currentTime=target;
      setAudioCurrentTime(target);
      setAudioProgress(pct);
    }
  };

  const handleScrubClick=(e:React.MouseEvent<HTMLDivElement>)=>{
    const rect=e.currentTarget.getBoundingClientRect();
    const clickX=e.clientX-rect.left;
    const pct=Math.max(0,Math.min(100,(clickX/rect.width)*100));
    handleSeek(pct);
  };

  const seekRelative=(offset:number)=>{
    if(audioRef.current){
      audioRef.current.currentTime=Math.max(0,Math.min(audioRef.current.duration||0,audioRef.current.currentTime+offset));
    }
  };
  const explainError=(error:unknown)=>{
    const message=error instanceof Error?error.message:'This request could not be completed.';
    if(error instanceof APIError&&error.status===401){
      resetRuntime();readyRef.current=false;setReady(false);setAccount(null);setPreview(null);setSelected(new Set());setPendingUploads([]);
      const empty=emptyCatalog();catalogRef.current=empty;renderCatalog(empty);setServerError(message);
    }
    return error instanceof APIError&&error.retryAfterSeconds?`${message} Try again in ${error.retryAfterSeconds} seconds.`:message;
  };
  const updateCatalogState=useCallback((next:Catalog)=>{
    catalogRef.current=next;
    renderCatalog(next);
    if(typeof window!=='undefined'&&!serverMode){
      try{localStorage.setItem(CACHED_CATALOG_KEY,JSON.stringify(next));}catch{}
    }
  },[serverMode]);
  const applyServerCatalog=useCallback((next:Catalog)=>{
    const transfers=new Map(next.transfers.map(item=>[item.id,item]));
    for(const [id,item] of transientTransfers.current)transfers.set(id,item);
    const merged={...next,transfers:[...transfers.values()]};
    catalogRef.current=merged;renderCatalog(merged);setPendingUploads(gateway.pendingUploads());
  },[gateway]);
  const refreshServer=useCallback(async()=>{
    const epoch=sessionEpoch.current;const user=await gateway.me();
    if(epoch!==sessionEpoch.current)throw new APIError('The session changed.','SESSION_CHANGED',409);
    if(activeAccount.current&&activeAccount.current!==user.id){sessionEpoch.current++;for(const controller of controllers.current.values())controller.abort();controllers.current.clear();transientTransfers.current.clear();setPreview(null);setSelected(new Set());const empty=emptyCatalog();catalogRef.current=empty;renderCatalog(empty);}
    activeAccount.current=user.id;const catalogEpoch=sessionEpoch.current;setAccount(user);
    const next=await gateway.loadCatalog();if(catalogEpoch!==sessionEpoch.current)throw new APIError('The session changed.','SESSION_CHANGED',409);applyServerCatalog(next);
    readyRef.current=user.storage_selected!==false;setReady(user.storage_selected!==false);setServerError(user.storage_selected===false?'Choose Saved Messages as your storage destination to upload originals.':'');return next;
  },[gateway,applyServerCatalog]);
  const setCatalog=(update:React.SetStateAction<Catalog>, originals?:{put?:{id:string;blob:Blob};remove?:string[]})=>{
    if(serverMode)throw new Error('Cloud catalog updates must go through the authenticated API.');
    if(!readyRef.current)return Promise.resolve(catalogRef.current);
    const operation=writes.current.then(async()=>{
      const next=typeof update==='function'?update(catalogRef.current):update;
      await commitCatalog(next,originals);updateCatalogState(next);
      if(account?.telegram_connected)void telegramGateway.syncCatalogToTelegram(next);
      return next;
    });
    writes.current=operation.catch(()=>notify('Could not save your changes. Browser storage may be full or unavailable.'));
    return operation;
  };
  const runServer=(action:()=>Promise<unknown>)=>{
    const epoch=sessionEpoch.current;
    const operation=writes.current.then(async()=>{
      if(epoch!==sessionEpoch.current)throw new APIError('The session changed.','SESSION_CHANGED',409);
      try{await action();return await refreshServer();}
      catch(error){await refreshServer().catch(()=>{});throw error;}
    });
    writes.current=operation.catch(error=>notify(explainError(error)));
    return operation;
  };
  const closeDialog=useCallback(()=>{setDialog(null);setFormError('');setSavingForm(false);},[]);
  useEffect(()=>{
    let cancelled=false;
    try{const language=localStorage.getItem('cloudnest-locale');if(language==='bn'){setLocale('bn');document.documentElement.lang='bn';}}catch{}
    if(serverMode){
      gateway.bootstrap().then(()=>refreshServer()).catch(error=>{if(!cancelled){const message=error instanceof APIError&&error.status===401?'Connect your Telegram account to open your drive.':error instanceof Error?error.message:'The configured service is unavailable.';setServerError(message);readyRef.current=false;setReady(false);}});
    }else{
      (async()=>{
        try {
          const auth = await telegramGateway.authState();
          if (auth.state === 'ready') {
            const me = await telegramGateway.me();
            if (!cancelled) setAccount(me);
            let saved = await telegramGateway.loadCatalog();
            if (!saved || saved.files.length === 0) {
              const restored = await telegramGateway.restoreCatalogFromTelegram() || await telegramGateway.scanAndRecoverSavedMessages();
              if (restored && restored.files.length > 0) saved = restored;
            }
            if (!cancelled) {
              updateCatalogState(saved);
              readyRef.current = true;
              setReady(true);
              void saveCatalog(saved);
            }
            return;
          }
        } catch {}
        const saved = await loadCatalog().catch(()=>null);
        if(cancelled)return;
        if(saved?.schemaVersion===1){
          saved.transfers=saved.transfers.map(item=>item.status==='saving'?{...item,status:'failed',error:'Saving was interrupted. Choose the original file to try again.'}:item);
          updateCatalogState(saved);
        }
        readyRef.current=true;setReady(true);
      })().catch(()=>{if(!cancelled){readyRef.current=true;setReady(true);notify('Browser storage is unavailable. Changes cannot be saved.');}});
    }
    return()=>{cancelled=true;};
  },[serverMode,gateway,refreshServer,notify,updateCatalogState]);
  useEffect(()=>{
    if(!serverMode||!account?.id)return;
    let cancelled=false;let pending=false;
    const timer=setInterval(async()=>{
      if(pending||document.visibilityState==='hidden')return;
      pending=true;
      const epoch=sessionEpoch.current;
      try{const next=await gateway.loadCatalog();if(!cancelled&&epoch===sessionEpoch.current)applyServerCatalog(next);}
      catch(error){if(!cancelled&&error instanceof APIError&&error.status===401){resetRuntime();setPendingUploads([]);readyRef.current=false;setReady(false);setAccount(null);setServerError('Your session has expired. Connect Telegram again.');const empty=emptyCatalog();catalogRef.current=empty;renderCatalog(empty);setPreview(null);}}
      finally{pending=false;}
    },3000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[serverMode,account?.id,gateway,applyServerCatalog]);
  useEffect(()=>{
    if(!serverMode||typeof syncJob?.id!=='string'||!['QUEUED','RUNNING','WAITING_PROVIDER','WAITING_NETWORK'].includes(String(syncJob.state)))return;
    const id=syncJob.id,epoch=sessionEpoch.current;let cancelled=false;
    const timer=setInterval(()=>gateway.getSync(id).then(next=>{if(!cancelled&&epoch===sessionEpoch.current){setSyncJob(next);if(next.state==='COMPLETED')refreshServer().catch(()=>{});}}).catch(error=>{if(!cancelled&&epoch===sessionEpoch.current)setSyncJob(previous=>({...previous,status_error:explainError(error)}));}),2500);
    return()=>{cancelled=true;clearInterval(timer);};
  },[serverMode,syncJob?.id,syncJob?.state,gateway,refreshServer]);
  useEffect(()=>{if(!toast)return;const id=setTimeout(()=>setToast(''),4500);return()=>clearTimeout(id);},[toast]);
  useEffect(()=>{
    const listener=(event:KeyboardEvent)=>{
      if((event.metaKey||event.ctrlKey)&&event.key==='k'){event.preventDefault();searchInput.current?.focus();}
      if(event.key==='Escape'){setMenu(null);setSelected(new Set());setMobileNav(false);}
    };document.addEventListener('keydown',listener);return()=>document.removeEventListener('keydown',listener);
  },[]);
  useEffect(()=>{
    if(typeof document==='undefined')return;
    if(mobileNav){
      const prevOverflow=document.body.style.overflow;
      const prevTouchAction=document.body.style.touchAction;
      document.body.style.overflow='hidden';
      document.body.style.touchAction='none';
      return ()=>{
        document.body.style.overflow=prevOverflow;
        document.body.style.touchAction=prevTouchAction;
      };
    }
  },[mobileNav]);
  useEffect(()=>{
    if(typeof window!=='undefined'){
      import('@capacitor/core').then(({Capacitor})=>{
        if(Capacitor.isNativePlatform()){
          import('@capacitor/status-bar').then(({StatusBar,Style})=>{
            StatusBar.setOverlaysWebView({overlay:false}).catch(()=>{});
            StatusBar.setStyle({style:Style.Dark}).catch(()=>{});
            StatusBar.setBackgroundColor({color:'#f4f7ee'}).catch(()=>{});
          }).catch(()=>{});
        }
      }).catch(()=>{});
    }
  },[]);
  useEffect(()=>{
    if(!account?.telegram_connected)return;
    const syncFolders=catalogRef.current.folders.filter(f=>f.syncSource?.autoSync);
    if(syncFolders.length===0)return;
    const initialTimer=setTimeout(()=>{
      for(const f of syncFolders){
        void runFolderSync(f);
      }
    },4000);
    const interval=setInterval(()=>{
      if(typeof document!=='undefined'&&document.visibilityState==='visible'){
        for(const f of catalogRef.current.folders.filter(f=>f.syncSource?.autoSync)){
          void runFolderSync(f);
        }
      }
    },4*60*1000);
    return()=>{
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  },[account?.telegram_connected]);
  useEffect(()=>{
    if(!preview)return;let disposed=false;let localUrl:string|undefined;
    setPreviewUrl(null);setPreviewError('');setPreviewProgress(null);setPreviewBytes(null);
    (async()=>{
      if(preview.asset){
        if(!disposed)setPreviewUrl(preview.asset);
        return;
      }
      const isMedia = safePreview(preview)==='video' || safePreview(preview)==='audio';
      if(isMedia && mediaBlobUrlCache.has(preview.id)){
        if(!disposed)setPreviewUrl(mediaBlobUrlCache.get(preview.id)!);
        return;
      }
      if(!isMedia && thumbnailCache.has(preview.id)){
        if(!disposed)setPreviewUrl(thumbnailCache.get(preview.id)!);
        return;
      }
      const cached = await getOriginal(preview.originalId || preview.id);
      if (cached && !disposed) {
        localUrl = URL.createObjectURL(cached);
        if(isMedia) mediaBlobUrlCache.set(preview.id, localUrl);
        else thumbnailCache.set(preview.id, localUrl);
        setPreviewUrl(localUrl);
        return;
      }
      if (preview.remoteMessageId) {
        if (!safePreview(preview)) {
          if (!disposed) setPreviewUrl('unsupported');
          return;
        }
        const blob = await telegramGateway.downloadFile(preview.remoteMessageId, {
          onProgress: (ratio, downloaded, total) => {
            if (!disposed) {
              setPreviewProgress(Math.round(ratio * 100));
              if (downloaded && total) {
                setPreviewBytes({ current: downloaded, total });
              }
            }
          }
        });
        if (!disposed) {
          void saveOriginal(preview.id, blob);
          localUrl = URL.createObjectURL(blob);
          if(isMedia) mediaBlobUrlCache.set(preview.id, localUrl);
          else thumbnailCache.set(preview.id, localUrl);
          setPreviewUrl(localUrl);
        }
        return;
      }
      if(serverMode&&preview.source==='server'){
        if(['video','audio'].includes(safePreview(preview)||'')){if(!disposed)setPreviewUrl(gateway.contentUrl(preview.id));return;}
        if(!safePreview(preview)){if(!disposed)setPreviewUrl('unsupported');return;}
        if(preview.bytes>32*1024*1024)throw new Error('This original is too large for a bounded browser preview. Download it to open locally.');
        const response=await fetch(gateway.previewUrl(preview.id),{credentials:'same-origin',cache:'no-store'});
        if(!response.ok){const data=await response.json().catch(()=>null);throw new Error(data?.error?.message||'A safe preview is unavailable. Download the original to open it locally.');}
        localUrl=URL.createObjectURL(await response.blob());if(!disposed)setPreviewUrl(localUrl);return;
      }
      const blob=await getOriginal(preview.originalId||preview.id);if(!blob)throw new Error('The original is no longer in this browser.');
      localUrl=URL.createObjectURL(blob);
      if(isMedia) mediaBlobUrlCache.set(preview.id, localUrl);
      if(!disposed)setPreviewUrl(localUrl);
    })().catch(error=>{if(!disposed)setPreviewError(error.message);});
    return()=>{disposed=true;};
  },[preview,gateway,serverMode]);
  const openDialog=(value:Dialog)=>{
    if(!readyRef.current&&['new-folder','rename','move','folder','remove'].includes(value.type)){
      if(serverMode){setDialog({type:'connect'});setFormError('');}return;
    }
    setDialog(value);
    setFormValue(value.type==='rename'?value.file.name:value.type==='folder'?value.folder.name:'');
    setFormError('');
    setMoveTarget('');
    setMenu(null);
    if(value.type==='new-folder'){
      if(view==='photos') setFolderKindChoice('image');
      else if(view==='videos') setFolderKindChoice('video');
      else if(view==='documents') setFolderKindChoice('document');
      else if(view==='audio') setFolderKindChoice('audio');
      else if(currentFolder?.kind) setFolderKindChoice(currentFolder.kind);
      else setFolderKindChoice('all');
    } else if(value.type==='folder'){
      setFolderKindChoice(getFolderKind(value.folder));
    }
  };
  const navigate=(next:View,folder:string|null=null)=>{setView(next);setFolderId(folder);setSearch('');setKind('all');setDateFilter('all');setSelected(new Set());setMenu(null);setMobileNav(false);};
  const activeFiles=catalog.files.filter(file=>!file.trashedAt);
  const currentFolder=catalog.folders.find(folder=>folder.id===folderId);
  const breadcrumbs:Folder[]=[];let ancestor=currentFolder;
  while(ancestor&&breadcrumbs.length<10){breadcrumbs.unshift(ancestor);ancestor=catalog.folders.find(folder=>folder.id===ancestor?.parentId);}
  const displayedFolders=useMemo(()=>{
    return catalog.folders.filter(folder=>{
      if(folderId){
        if(folder.parentId!==folderId)return false;
      }else{
        if(folder.parentId!==null)return false;
        const fk=getFolderKind(folder);
        if(view==='photos'&&fk!=='image')return false;
        if(view==='videos'&&fk!=='video')return false;
        if(view==='documents'&&fk!=='document')return false;
        if(view==='audio'&&fk!=='audio')return false;
        if(!['all','photos','videos','documents','audio'].includes(view))return false;
      }
      const query=search.toLowerCase();
      return !query||folder.name.toLowerCase().includes(query);
    });
  },[catalog.folders,folderId,view,search]);
  const visible=useMemo(()=>catalog.files.filter(file=>{
    if(Boolean(file.trashedAt)!==(view==='trash'))return false;
    if(folderId&&file.folderId!==folderId)return false;
    if(view==='photos'&&file.kind!=='image'||view==='videos'&&file.kind!=='video'||view==='documents'&&file.kind!=='document'||view==='audio'&&file.kind!=='audio')return false;
    if(view==='favorites'&&!file.favorite)return false;
    if(kind!=='all'&&file.kind!==kind)return false;
    if(dateFilter!=='all'&&Date.parse(file.createdAt)<Date.now()-Number(dateFilter)*86400000)return false;
    const query=search.toLowerCase();return !query||file.name.toLowerCase().includes(query)||file.tags.some(tag=>tag.toLowerCase().includes(query));
  }).sort((a,b)=>sort==='name'?a.name.localeCompare(b.name):sort==='size'?b.bytes-a.bytes:Date.parse(b.createdAt)-Date.parse(a.createdAt)),[catalog.files,view,folderId,search,sort,kind,dateFilter]);
  const totalBytes=activeFiles.reduce((sum,file)=>sum+file.bytes,0);
  const transfers=catalog.transfers.filter(item=>!hiddenTransfers.has(item.id));
  const mutateFiles=(ids:string[],update:(file:DriveFile)=>DriveFile)=>{
    if(!serverMode)return setCatalog(previous=>({...previous,files:previous.files.map(file=>ids.includes(file.id)?update(file):file)}));
    return runServer(async()=>{
      const failures:string[]=[];
      for(const id of ids){const file=catalogRef.current.files.find(item=>item.id===id);if(!file)continue;const next=update(file);
        try{
          if(next.trashedAt!==file.trashedAt){if(next.trashedAt)await gateway.trash(id);else await gateway.restore(id);}
          else await gateway.patchFile(file,{...(next.name!==file.name?{name:next.name}:{}),...(next.folderId!==file.folderId?{folderId:next.folderId}:{}),...(next.favorite!==file.favorite?{favorite:next.favorite}:{}),...(JSON.stringify(next.tags)!==JSON.stringify(file.tags)?{tags:next.tags}:{})});
        }catch(error){failures.push(explainError(error));}
      }
      if(failures.length)throw new Error(`${failures.length} item(s) could not be updated. ${failures[0]}`);
    });
  };
  const favorite=async(file:DriveFile)=>{try{await mutateFiles([file.id],f=>({...f,favorite:!f.favorite}));if(preview?.id===file.id)setPreview(catalogRef.current.files.find(item=>item.id===file.id)||null);}catch{}setMenu(null);};
  const updateTags=async(file:DriveFile,tags:string[])=>{try{await mutateFiles([file.id],current=>({...current,tags}));setPreview(catalogRef.current.files.find(item=>item.id===file.id)||null);}catch{}};
  const trash=(ids:string[])=>{mutateFiles(ids,file=>({...file,trashedAt:new Date().toISOString()})).then(()=>notify(t('Moved to trash. You can restore it anytime.','ট্র্যাশে সরানো হয়েছে। যেকোনো সময় ফিরিয়ে আনতে পারবেন।'))).catch(()=>{});setSelected(new Set());setMenu(null);};
  const restore=(ids:string[])=>{mutateFiles(ids,file=>({...file,trashedAt:null})).then(()=>notify(t('Files restored to your drive.','ফাইল ড্রাইভে ফিরিয়ে আনা হয়েছে।'))).catch(()=>{});setSelected(new Set());setMenu(null);};
  const downloadBlob=(blob:Blob,name:string)=>{const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name.replace(/[\x00-\x1f]/g,'');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const download=async(file:DriveFile,resumeOptions?:{resumeTransferId?:string;startOffset?:number;existingChunks?:(Buffer|Uint8Array)[]})=>{
    try{
      if(file.remoteMessageId){
        const transferId=resumeOptions?.resumeTransferId||crypto.randomUUID();
        const controller=new AbortController();
        controllers.current.set(transferId,controller);
        sessionTransfersRef.current.add(transferId);
        setDismissedDock(false);
        setDockOpen(typeof window !== 'undefined' ? window.innerWidth > 650 : true);

        const accumulatedChunks:(Buffer|Uint8Array)[]=resumeOptions?.existingChunks?[...resumeOptions.existingChunks]:[];
        const startOffset=resumeOptions?.startOffset||0;

        activeTransferTasks.current.set(transferId,{
          id:transferId,
          type:'download',
          remoteMessageId:file.remoteMessageId,
          fileName:file.name,
          totalBytes:file.bytes,
          controller,
          resumeState:{downloadedBytes:startOffset},
          accumulatedChunks
        });

        const existingTransfer=catalogRef.current.transfers.find(t=>t.id===transferId);
        const transferItem:Transfer=existingTransfer
          ?{...existingTransfer,status:'saving',error:undefined}
          : {
              id:transferId,
              name:file.name,
              bytes:file.bytes,
              stageBytes:startOffset,
              status:'saving',
              direction:'download',
              kind:file.kind,
              createdAt:new Date().toISOString(),
              resumeState:{downloadedBytes:startOffset}
            };

        const nextTransfers=existingTransfer
          ?catalogRef.current.transfers.map(t=>t.id===transferId?transferItem:t)
          : [transferItem,...catalogRef.current.transfers.filter(t=>t.id!==transferId)];
        catalogRef.current={...catalogRef.current,transfers:nextTransfers};
        renderCatalog(catalogRef.current);

        notify(startOffset>0?t(`Resuming “${file.name}”…`,`“${file.name}” পুনরায় ডাউনলোড হচ্ছে…`):t(`Downloading “${file.name}”…`,`“${file.name}” ডাউনলোড হচ্ছে…`));

        const blob=await telegramGateway.downloadFile(file.remoteMessageId,{
          signal:controller.signal,
          startOffset,
          existingChunks:accumulatedChunks,
          onChunk:(chunk,downloadedBytes)=>{
            const task=activeTransferTasks.current.get(transferId);
            if(task)task.resumeState={downloadedBytes};
          },
          onProgress:(ratio,downloaded,total)=>{
            const currentBytes=downloaded||Math.round(ratio*file.bytes);
            const totalBytes=total||file.bytes;
            const updatedTransfer:Transfer={
              ...transferItem,
              stageBytes:currentBytes,
              bytes:totalBytes,
              status:'saving',
              resumeState:{downloadedBytes:currentBytes}
            };
            catalogRef.current={
              ...catalogRef.current,
              transfers:catalogRef.current.transfers.map(item=>item.id===transferId?updatedTransfer:item)
            };
            renderCatalog(catalogRef.current);
          }
        });

        downloadBlob(blob,file.name);

        const finishedTransfer:Transfer={
          ...transferItem,
          stageBytes:file.bytes,
          status:'completed',
          error:undefined
        };
        catalogRef.current={
          ...catalogRef.current,
          transfers:catalogRef.current.transfers.map(item=>item.id===transferId?finishedTransfer:item)
        };
        renderCatalog(catalogRef.current);
        activeTransferTasks.current.delete(transferId);
        notify(t(`“${file.name}” downloaded.`,`“${file.name}” ডাউনলোড সম্পন্ন হয়েছে।`));
        return;
      }
      if(file.source==='server'){const a=document.createElement('a');a.href=gateway.contentUrl(file.id);a.download=file.name;a.click();notify(t('Original download requested.','মূল ফাইল ডাউনলোডের অনুরোধ করা হয়েছে।'));return;}
      const blob=file.asset?await fetch(file.asset).then(response=>{if(!response.ok)throw new Error();return response.blob();}):await getOriginal(file.originalId||file.id);if(!blob)throw new Error();downloadBlob(blob,file.name);notify(t('Original download started.','মূল ফাইল ডাউনলোড শুরু হয়েছে।'));
    }catch(err:unknown){
      const isPause=err&&typeof err==='object'&&('isPause' in err||(err as Error).message?.includes('paused'));
      const isCancel=err&&typeof err==='object'&&('isCancel' in err||(err as Error).message?.includes('cancelled'));
      const isNetwork=(err&&typeof err==='object'&&'isNetwork' in err)||(typeof navigator!=='undefined'&&!navigator.onLine);
      const msg=err instanceof Error?err.message:String(err);

      const transferId=resumeOptions?.resumeTransferId||Array.from(activeTransferTasks.current.keys()).find(k=>activeTransferTasks.current.get(k)?.remoteMessageId===file.remoteMessageId);
      if(transferId){
        const task=activeTransferTasks.current.get(transferId);
        const downloadedBytes=(err&&typeof err==='object'&&'resumeState' in err?(err as {resumeState?:{downloadedBytes:number}}).resumeState?.downloadedBytes:undefined)??task?.resumeState?.downloadedBytes??0;
        if(task){
          task.resumeState={downloadedBytes};
          if(err&&typeof err==='object'&&'chunks' in err){
            task.accumulatedChunks=(err as {chunks?:(Buffer|Uint8Array)[]}).chunks;
          }
        }

        if(isCancel||msg.includes('cancelled')){
          activeTransferTasks.current.delete(transferId);
          catalogRef.current={
            ...catalogRef.current,
            transfers:catalogRef.current.transfers.map(item=>item.id===transferId?{...item,status:'cancelled' as const,error:msg}:item)
          };
          renderCatalog(catalogRef.current);
          notify(t('Download cancelled.','ডাউনলোড বাতিল করা হয়েছে।'));
        }else if(isPause||isNetwork||msg.includes('paused')||msg.includes('offline')){
          catalogRef.current={
            ...catalogRef.current,
            transfers:catalogRef.current.transfers.map(item=>item.id===transferId?{...item,status:'paused' as const,resumeState:{downloadedBytes},error:isNetwork?t('Network offline','ইন্টারনেট বিচ্ছিন্ন'):undefined}:item)
          };
          renderCatalog(catalogRef.current);
          notify(isNetwork?t('Download paused due to network issue. It will resume automatically when connected.','ইন্টারনেট সমস্যার কারণে ডাউনলোড স্থগিত হয়েছে। নেট আসলে স্বয়ংক্রিয়ভাবে শুরু হবে।'):t('Download paused.','ডাউনলোড সাময়িক স্থগিত হয়েছে।'));
        }else{
          activeTransferTasks.current.delete(transferId);
          catalogRef.current={
            ...catalogRef.current,
            transfers:catalogRef.current.transfers.map(item=>item.id===transferId?{...item,status:'failed' as const,error:msg}:item)
          };
          renderCatalog(catalogRef.current);
          notify(msg);
        }
      }else{
        notify(msg);
      }
    }finally{setMenu(null);}
  };
  const executeUploadSingle=async(file:File,options:{existingTransferId?:string;folderId?:string|null;resumeState?:{fileId?:string;startPart?:number}}={})=>{
    const id=options.existingTransferId||crypto.randomUUID();
    const controller=new AbortController();
    sessionTransfersRef.current.add(id);
    setDismissedDock(false);
    setDockOpen(typeof window !== 'undefined' ? window.innerWidth > 650 : true);

    activeTransferTasks.current.set(id,{
      id,
      type:'upload',
      file,
      fileName:file.name,
      folderId:options.folderId,
      totalBytes:file.size,
      controller,
      resumeState:options.resumeState
    });
    controllers.current.set(id,controller);

    const existingTransfer=catalogRef.current.transfers.find(t=>t.id===id);
    const transfer:Transfer=existingTransfer
      ?{...existingTransfer,status:'saving',error:undefined}
      : {
          id,
          name:file.name,
          bytes:file.size,
          status:'saving',
          direction:'upload',
          kind:kindFor(file.type||'',file.name),
          createdAt:new Date().toISOString(),
          stageBytes:(options.resumeState?.startPart||0)*512*1024,
          providerBytes:0,
          resumeState:options.resumeState
        };

    const nextTransfers=existingTransfer
      ?catalogRef.current.transfers.map(t=>t.id===id?transfer:t)
      : [transfer,...catalogRef.current.transfers.filter(t=>t.id!==id)];
    catalogRef.current={...catalogRef.current,transfers:nextTransfers};
    renderCatalog(catalogRef.current);

    try{
      const result=await telegramGateway.upload(file,{
        folderId:options.folderId,
        signal:controller.signal,
        resumeState:options.resumeState,
        onProgress:(p)=>{
          const task=activeTransferTasks.current.get(id);
          if(task&&p.resumeState)task.resumeState=p.resumeState;
          const updatedTransfer:Transfer={
            ...transfer,
            stageBytes:p.bytes,
            bytes:p.expectedBytes||file.size,
            status:p.phase==='queued'?'completed':'saving',
            direction:'upload',
            kind:kindFor(file.type||'',file.name),
            resumeState:p.resumeState||task?.resumeState
          };
          const updated={...catalogRef.current,transfers:catalogRef.current.transfers.map(item=>item.id===id?updatedTransfer:item)};
          catalogRef.current=updated;
          renderCatalog(updated);
        }
      });

      if(file.type.startsWith('image/')){
        try{
          const localUrl=URL.createObjectURL(file);
          thumbnailCache.set(result.file.id,localUrl);
        }catch{}
      }
      void saveOriginal(result.file.id,file);
      const updatedCatalog={
        ...catalogRef.current,
        files:[result.file,...catalogRef.current.files.filter(f=>f.id!==result.file.id)],
        transfers:catalogRef.current.transfers.map(item=>item.id===id?{...item,status:'completed' as const,stageBytes:file.size,error:undefined}:item)
      };
      updateCatalogState(updatedCatalog);
      void commitCatalog(updatedCatalog);
      void telegramGateway.syncCatalogToTelegram(updatedCatalog);
      activeTransferTasks.current.delete(id);
      notify(t(`“${file.name}” uploaded to your Telegram Saved Messages.`,`“${file.name}” আপনার টেলিগ্রাম সেভড মেসেজে আপলোড হয়েছে।`));
    }catch(err:unknown){
      const isPause=controller.signal.aborted&&controller.signal.reason==='paused';
      const isCancel=controller.signal.aborted&&controller.signal.reason==='cancelled';
      const isNetwork=(err&&typeof err==='object'&&'isNetwork' in err)||(typeof navigator!=='undefined'&&!navigator.onLine);
      const msg=err instanceof Error?err.message:String(err);
      const task=activeTransferTasks.current.get(id);
      const savedResume=(err&&typeof err==='object'&&'resumeState' in err?(err as {resumeState?:{fileId:string;startPart:number}}).resumeState:undefined)||task?.resumeState;

      if(task&&savedResume)task.resumeState=savedResume;

      if(isCancel||msg.includes('cancelled')){
        activeTransferTasks.current.delete(id);
        const failed={
          ...catalogRef.current,
          transfers:catalogRef.current.transfers.map(item=>item.id===id?{...item,status:'cancelled' as const,error:msg}:item)
        };
        catalogRef.current=failed;
        renderCatalog(failed);
        notify(t('Upload cancelled.','আপলোড বাতিল করা হয়েছে।'));
      }else if(isPause||isNetwork||msg.includes('paused')||msg.includes('offline')){
        const failed={
          ...catalogRef.current,
          transfers:catalogRef.current.transfers.map(item=>item.id===id?{...item,status:'paused' as const,resumeState:savedResume,error:isNetwork?t('Network offline','ইন্টারনেট বিচ্ছিন্ন'):undefined}:item)
        };
        catalogRef.current=failed;
        renderCatalog(failed);
        notify(isNetwork?t('Upload paused due to network issue. It will resume automatically when connected.','ইন্টারনেট সমস্যার কারণে আপলোড সাময়িক স্থগিত হয়েছে। নেট আসলে স্বয়ংক্রিয়ভাবে শুরু হবে।'):t('Upload paused.','আপলোড সাময়িক স্থগিত হয়েছে।'));
      }else{
        activeTransferTasks.current.delete(id);
        const failed={
          ...catalogRef.current,
          transfers:catalogRef.current.transfers.map(item=>item.id===id?{...item,status:'failed' as const,error:msg}:item)
        };
        catalogRef.current=failed;
        renderCatalog(failed);
        notify(msg);
      }
    }finally{
      controllers.current.delete(id);
    }
  };
  const upload=async(list:FileList|File[])=>{
    const files=Array.from(list);if(!files.length||!readyRef.current)return;
    if(resumeTarget.current){
      const targetId=resumeTarget.current;
      resumeTarget.current=undefined;
      const targetTransfer=catalogRef.current.transfers.find(t=>t.id===targetId);
      if(targetTransfer){
        const matchedFile=files.find(f=>f.name===targetTransfer.name&&f.size===targetTransfer.bytes)||files[0];
        if(matchedFile){
          await executeUploadSingle(matchedFile,{
            existingTransferId:targetId,
            resumeState:targetTransfer.resumeState
          });
          if(fileInput.current)fileInput.current.value='';
          return;
        }
      }
    }
    if(!serverMode && account?.telegram_connected){
      for(const file of files){
        await executeUploadSingle(file,{folderId});
      }
      if(fileInput.current)fileInput.current.value='';
      return;
    }
    if(serverMode){
      const epoch=sessionEpoch.current;const resumeId=resumeTarget.current;resumeTarget.current=undefined;
      for(const file of resumeId?files.slice(0,1):files){
        const controller=new AbortController();let currentId='';
        try{
          await gateway.upload(file,{folderId,resumeId,signal:controller.signal,onProgress:progress=>{
            if(epoch!==sessionEpoch.current){controller.abort();return;}
            const id=progress.uploadId||progress.descriptorId;if(currentId&&currentId!==id){transientTransfers.current.delete(currentId);controllers.current.delete(currentId);}currentId=id;controllers.current.set(id,controller);
            const transfer:Transfer=progress.transfer||{id,name:file.name,bytes:file.size,status:'saving',state:progress.phase==='preparing'?'PREPARING':'STAGING',stagedBytes:progress.phase==='staging'?progress.bytes:0,createdAt:new Date().toISOString(),source:'server'};
            transientTransfers.current.set(id,transfer);const next={...catalogRef.current,transfers:[transfer,...catalogRef.current.transfers.filter(item=>item.id!==id)]};catalogRef.current=next;renderCatalog(next);
          }});
          if(epoch!==sessionEpoch.current)return;
          notify(t('Original bytes received. Check Transfers for Telegram confirmation.','মূল ফাইলের বাইট গ্রহণ করা হয়েছে। টেলিগ্রামের নিশ্চিতকরণ ট্রান্সফারে দেখুন।'));
        }catch(error){if(epoch===sessionEpoch.current)notify(explainError(error));}
        finally{if(currentId){controllers.current.delete(currentId);transientTransfers.current.delete(currentId);}if(epoch===sessionEpoch.current){setPendingUploads(gateway.pendingUploads());await refreshServer().catch(error=>notify(explainError(error)));}}
      }
      if(fileInput.current)fileInput.current.value='';return;
    }
    for(const file of files){
      const id=crypto.randomUUID();const transfer={id,name:file.name,bytes:file.size,status:'saving' as const,createdAt:new Date().toISOString()};
      try{
        await setCatalog(previous=>({...previous,transfers:[transfer,...previous.transfers]}));
        if(file.size>MAX_FILE_BYTES)throw new Error('This file exceeds the 500 MiB product limit.');
        if(cancelUploads.current.has(id))continue;
        let sha256:string|undefined;
        if(file.size<=16*1024*1024&&crypto.subtle)sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))).map(value=>value.toString(16).padStart(2,'0')).join('');
        if(cancelUploads.current.has(id))continue;
        let reuse:DriveFile|undefined;
        const duplicate=sha256?catalogRef.current.files.find(item=>!item.trashedAt&&item.sha256===sha256&&item.bytes===file.size):undefined;
        if(duplicate){
          const existingBlob=await getOriginal(duplicate.originalId||duplicate.id);
          const choice=await new Promise<'keep'|'reuse'|'cancel'>(resolve=>{duplicateDecision.current=resolve;setDuplicatePrompt({name:file.name,existing:duplicate,reuseAvailable:Boolean(existingBlob&&existingBlob.size===file.size)});});
          if(choice==='cancel'){await setCatalog(previous=>({...previous,transfers:previous.transfers.map(item=>item.id===id?{...item,status:'cancelled'}:item)}));continue;}
          if(choice==='reuse'&&existingBlob&&existingBlob.size===file.size)reuse=duplicate;
        }
        const saved:DriveFile={id,name:file.name,originalName:file.name,mime:file.type||'application/octet-stream',bytes:file.size,kind:kindFor(file.type,file.name),folderId,createdAt:new Date().toISOString(),trashedAt:null,favorite:false,tags:[],sha256,...(reuse?{originalId:reuse.originalId||reuse.id,originalName:reuse.originalName}:{})};
        await setCatalog(previous=>({...previous,files:[saved,...previous.files],transfers:previous.transfers.map(item=>item.id===id?{...item,status:'completed'}:item)}),reuse?undefined:{put:{id,blob:file}});
        if(cancelUploads.current.has(id))continue;notify(t(`“${file.name}” saved in this browser.`,`“${file.name}” এই ব্রাউজারে সেভ হয়েছে।`));
      }catch(error){setCatalog(previous=>({...previous,transfers:previous.transfers.map(item=>item.id===id?{...item,status:'failed',error:error instanceof Error?error.message:'Browser storage is full or unavailable.'}:item)}));notify(t('A file could not be saved. Check Transfers for details.','একটি ফাইল সেভ হয়নি। বিস্তারিত ট্রান্সফারে দেখুন।'));}
    }
    if(fileInput.current)fileInput.current.value='';
  };
  const runFolderSync = async (folder: Folder) => {
    if (!folder.syncSource) return;
    if (isSyncingFolder === folder.id) return;
    setIsSyncingFolder(folder.id);
    notify(t(`Scanning "${folder.syncSource.pathName}" for new files…`, `"${folder.syncSource.pathName}" ফোল্ডারে নতুন ফাইল স্ক্যান হচ্ছে…`));

    try {
      const items = await listFilesInFolder(folder.syncSource, folder.id);
      if (!items || items.length === 0) {
        notify(t('No files found in the connected folder.', 'কানেক্ট করা ফোল্ডারে কোনো ফাইল পাওয়া যায়নি।'));
        return;
      }

      const existingSignatures = new Set(
        catalogRef.current.files
          .filter(f => f.folderId === folder.id && !f.trashedAt)
          .map(f => `${f.originalName}_${f.bytes}`)
      );

      const toUpload = items.filter(item => !existingSignatures.has(`${item.name}_${item.size}`));

      if (toUpload.length === 0) {
        notify(t('Folder is already up to date. All files are synced.', 'ফোল্ডারটি আপ টু ডেট আছে। সব ফাইল সিঙ্ক করা।'));
        await setCatalog(prev => ({
          ...prev,
          folders: prev.folders.map(f => f.id === folder.id ? {
            ...f,
            syncSource: { ...f.syncSource!, lastSyncedAt: new Date().toISOString() }
          } : f)
        }));
        return;
      }

      notify(t(`Found ${toUpload.length} new file(s). Starting auto-upload…`, `${toUpload.length}টি নতুন ফাইল পাওয়া গেছে। অটো-আপলোড শুরু হচ্ছে…`));
      setDockOpen(typeof window !== 'undefined' ? window.innerWidth > 650 : true);
      setDismissedDock(false);

      let count = 0;
      for (const item of toUpload) {
        try {
          const transferId = crypto.randomUUID();
          const initialTransfer: Transfer = {
            id: transferId,
            name: item.name,
            bytes: item.size,
            status: 'saving',
            createdAt: new Date().toISOString(),
            direction: 'upload',
            kind: kindFor(item.mimeType, item.name),
          };

          transientTransfers.current.set(transferId, initialTransfer);
          updateCatalogState({
            ...catalogRef.current,
            transfers: [initialTransfer, ...catalogRef.current.transfers.filter(tr => tr.id !== transferId)]
          });

          if (item.file) {
            await (account?.telegram_connected
              ? telegramGateway.upload(item.file, {
                  folderId: folder.id,
                  onProgress: p => {
                    const tr: Transfer = {
                      ...initialTransfer,
                      stagedBytes: p.bytes,
                      stageBytes: p.expectedBytes,
                      status: p.phase === 'queued' ? 'reconciling' : 'saving',
                    };
                    transientTransfers.current.set(transferId, tr);
                    updateCatalogState({
                      ...catalogRef.current,
                      transfers: [tr, ...catalogRef.current.transfers.filter(t => t.id !== transferId)]
                    });
                  }
                })
              : upload([item.file]));
          } else if (item.uri) {
            await telegramGateway.uploadNative(
              { name: item.name, size: item.size, mimeType: item.mimeType, uri: item.uri },
              {
                folderId: folder.id,
                onProgress: p => {
                  const tr: Transfer = {
                    ...initialTransfer,
                    stagedBytes: p.bytes,
                    stageBytes: p.expectedBytes,
                    status: p.phase === 'queued' ? 'reconciling' : 'saving',
                  };
                  transientTransfers.current.set(transferId, tr);
                  updateCatalogState({
                    ...catalogRef.current,
                    transfers: [tr, ...catalogRef.current.transfers.filter(t => t.id !== transferId)]
                  });
                }
              }
            );
          }

          count++;
          transientTransfers.current.delete(transferId);
          const finishedTransfer: Transfer = {
            ...initialTransfer,
            status: 'completed',
            stagedBytes: item.size,
            stageBytes: item.size,
          };
          const nextCat = await telegramGateway.loadCatalog() || catalogRef.current;
          updateCatalogState({
            ...nextCat,
            transfers: [finishedTransfer, ...nextCat.transfers.filter(t => t.id !== transferId)]
          });
        } catch (err) {
          console.error('Error syncing file:', item.name, err);
        }
      }

      await setCatalog(prev => ({
        ...prev,
        folders: prev.folders.map(f => f.id === folder.id ? {
          ...f,
          syncSource: { ...f.syncSource!, lastSyncedAt: new Date().toISOString() }
        } : f)
      }));

      notify(t(`Successfully synced ${count} file(s) to "${folder.name}".`, `"${folder.name}" ফোল্ডারে ${count}টি ফাইল সফলভাবে সিঙ্ক হয়েছে।`));
    } catch (err) {
      notify(explainError(err));
    } finally {
      setIsSyncingFolder(null);
    }
  };
  const clearFinished=()=>{
    if(serverMode){setHiddenTransfers(previous=>new Set([...previous,...catalog.transfers.filter(item=>['completed','cancelled'].includes(item.status)).map(item=>item.id)]));return;}
    setCatalog(previous=>({...previous,transfers:previous.transfers.filter(item=>item.status==='saving')}));
  };
  const cancelTransfer=async(id:string)=>{
    const task=activeTransferTasks.current.get(id);
    if(task){
      task.controller.abort('cancelled');
      activeTransferTasks.current.delete(id);
    }
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    cancelUploads.current.add(id);

    if(serverMode){
      const current=catalogRef.current.transfers.find(item=>item.id===id);
      const descriptor=gateway.pendingUploads().find(item=>item.id===id||item.uploadId===id);
      if(current?.state==='PREPARING'&&!descriptor?.uploadId){transientTransfers.current.delete(id);controllers.current.delete(id);applyServerCatalog({...catalogRef.current,transfers:catalogRef.current.transfers.filter(item=>item.id!==id)});notify(t('Preparation paused. Any uncertain server reservation remains recoverable.','প্রস্তুতি থেমেছে। অনিশ্চিত সার্ভার রিজার্ভেশন থাকলে তা রিকভার করা যাবে।'));return;}
      const transferId=descriptor?.uploadId||id;
      try{await gateway.cancelTransfer(transferId);await refreshServer();}catch(error){notify(explainError(error));}return;
    }

    const next={
      ...catalogRef.current,
      transfers:catalogRef.current.transfers.map(item=>item.id===id?{...item,status:'cancelled' as const,error:'Transfer cancelled'}:item)
    };
    catalogRef.current=next;
    renderCatalog(next);
    notify(t('Transfer cancelled.','ট্রান্সফার বাতিল করা হয়েছে।'));
  };
  const pauseTransfer=(id:string)=>{
    const task=activeTransferTasks.current.get(id);
    if(task){
      task.controller.abort('paused');
      const next={
        ...catalogRef.current,
        transfers:catalogRef.current.transfers.map(item=>item.id===id?{...item,status:'paused' as const,resumeState:task.resumeState}:item)
      };
      catalogRef.current=next;
      renderCatalog(next);
      notify(t('Transfer paused.','ট্রান্সফার সাময়িক স্থগিত করা হয়েছে।'));
      return;
    }
    controllers.current.get(id)?.abort();
  };
  const resumeTransfer=async(id:string)=>{
    const task=activeTransferTasks.current.get(id);
    const transfer=catalogRef.current.transfers.find(t=>t.id===id);
    if(!transfer)return;

    if(transfer.direction==='download'||task?.type==='download'){
      const file=catalogRef.current.files.find(f=>f.name===transfer.name);
      if(!file||!file.remoteMessageId){
        notify(t('Cannot find original file in Telegram to resume download.','ডাউনলোড পুনরায় শুরু করতে মূল ফাইল পাওয়া যায়নি।'));
        return;
      }
      download(file,{
        resumeTransferId:id,
        startOffset:task?.resumeState?.downloadedBytes||transfer.resumeState?.downloadedBytes||0,
        existingChunks:task?.accumulatedChunks
      });
      return;
    }

    if(task&&task.file){
      executeUploadSingle(task.file,{
        existingTransferId:id,
        folderId:task.folderId,
        resumeState:task.resumeState||transfer.resumeState
      });
      return;
    }

    resumeTarget.current=id;
    notify(t(`Please select "${transfer.name}" again to resume from where it left off.`,`যেখান থেকে বন্ধ হয়েছিল সেখান থেকে পুনরায় শুরু করতে দয়া করে "${transfer.name}" ফাইলটি আবার বেছে নিন।`));
    fileInput.current?.click();
  };
  const retryTransfer=async(id:string)=>{
    if(!serverMode){
      await resumeTransfer(id);
      return;
    }
    const pending=gateway.pendingUploads().find(item=>item.id===id||item.uploadId===id);
    if(pending){resumeTarget.current=pending.id;fileInput.current?.click();return;}
    try{await gateway.retryTransfer(id);await refreshServer();}catch(error){notify(explainError(error));}
  };
  useEffect(()=>{
    const handleOnline=()=>{
      notify(t('Internet connection restored. Resuming transfers…','ইন্টারনেট সংযোগ ফিরে এসেছে। ট্রান্সফার পুনরায় শুরু হচ্ছে…'));
      for(const id of activeTransferTasks.current.keys()){
        const tr=catalogRef.current.transfers.find(t=>t.id===id);
        if(tr?.status==='paused'){
          void resumeTransfer(id);
        }
      }
    };
    window.addEventListener('online',handleOnline);
    return()=>window.removeEventListener('online',handleOnline);
  },[]);
  const exportCatalog=async()=>{
    try{const blob=serverMode?await gateway.exportCatalog():new Blob([JSON.stringify({...catalog,exportedAt:new Date().toISOString(),storage:'browser-demo',notice:'Metadata only. Uploaded originals remain in this browser; no Telegram references exist in demo mode.'},null,2)],{type:'application/json'});downloadBlob(blob,'filedeck-catalog.json');notify(t('Catalog exported. Originals are not included.','ক্যাটালগ রপ্তানি হয়েছে। মূল ফাইল এতে নেই।'));}catch(error){notify(explainError(error));}
  };
  const prepareImport=async(file:File)=>{
    if(serverMode)return;
    try{if(file.size>10*1024*1024)throw new Error('Choose a catalog JSON export smaller than 10 MiB.');const imported=parseCatalogImport(JSON.parse(await file.text()),catalogRef.current);setImportError('');closeDialog();setImportCandidate(imported);}
    catch(error){notify(error instanceof Error?error.message:'The catalog could not be read.');}
    finally{if(importInput.current)importInput.current.value='';}
  };
  const restoreImport=async()=>{
    if(!importCandidate||serverMode)return;
    try{await setCatalog(importCandidate);setImportCandidate(null);navigate('all');notify(t('Organization imported. Missing originals still need their original source.','ফোল্ডার ও ট্যাগ আমদানি হয়েছে। অনুপস্থিত মূল ফাইলের উৎস এখনো দরকার।'));}
    catch(error){setImportError(explainError(error));}
  };
  const submitForm=async(event:React.FormEvent)=>{
    event.preventDefault();if(!dialog||!readyRef.current||savingForm)return;const name=formValue.trim();
    if(['new-folder','rename','folder'].includes(dialog.type)&&(!name||name.length>255)){setFormError(t('Enter a name between 1 and 255 characters.','১ থেকে ২৫৫ অক্ষরের নাম লিখুন।'));return;}
    if(dialog.type==='new-folder'){
      if(breadcrumbs.length>=10){setFormError('Folders support a maximum of 10 levels.');return;}
      if(catalog.folders.some(folder=>folder.parentId===folderId&&folder.name.toLowerCase()===name.toLowerCase())){setFormError(t('A folder with this name already exists.','এই নামে একটি ফোল্ডার আছে।'));return;}
    }
    if(dialog.type==='folder'){
      const parentId=moveTarget==='__root'?null:moveTarget||dialog.folder.parentId;
      if(catalog.folders.some(folder=>folder.id!==dialog.folder.id&&folder.parentId===parentId&&folder.name.toLowerCase()===name.toLowerCase())){setFormError(t('A folder with this name already exists.','এই নামে একটি ফোল্ডার আছে।'));return;}
      if(!canMoveFolder(catalog.folders,dialog.folder.id,parentId)){setFormError('That move would create a cycle or exceed the folder depth limit.');return;}
    }
    setSavingForm(true);
    try{
      if(dialog.type==='new-folder'){
        const chosenKind = folderKindChoice;
        const chosenColor = chosenKind === 'image' ? 'peach' : chosenKind === 'video' ? 'purple' : chosenKind === 'document' ? 'blue' : chosenKind === 'audio' ? 'green' : ['green','blue','peach','purple'][catalog.folders.length%4];
        if(serverMode)await runServer(()=>gateway.createFolder(name,folderId));
        else await setCatalog(previous=>({...previous,folders:[...previous.folders,{id:crypto.randomUUID(),name,parentId:folderId,color:chosenColor,kind:chosenKind}]}));
        notify(t('Your new folder is ready.','নতুন ফোল্ডার তৈরি হয়েছে।'));
      }
      if(dialog.type==='rename')await mutateFiles([dialog.file.id],file=>({...file,name}));
      if(dialog.type==='folder'){
        const nextParent=moveTarget==='__root'?null:moveTarget||dialog.folder.parentId;
        const chosenKind = folderKindChoice;
        const chosenColor = chosenKind === 'image' ? 'peach' : chosenKind === 'video' ? 'purple' : chosenKind === 'document' ? 'blue' : chosenKind === 'audio' ? 'green' : dialog.folder.color;
        if(serverMode)await runServer(()=>gateway.patchFolder(dialog.folder,{name,parentId:nextParent}));
        else await setCatalog(previous=>({...previous,folders:previous.folders.map(folder=>folder.id===dialog.folder.id?{...folder,name,parentId:nextParent,kind:chosenKind,color:chosenColor}:folder)}));
      }
      if(dialog.type==='move'){await mutateFiles(dialog.ids,file=>({...file,folderId:moveTarget||null}));setSelected(new Set());notify(t('Files moved. Originals stay unchanged.','ফাইল সরানো হয়েছে। মূল ফাইল অপরিবর্তিত আছে।'));}
      closeDialog();
    }catch(error){setFormError(explainError(error));}finally{setSavingForm(false);}
  };
  const removeFiles=async(ids:string[])=>{
    try{
      for(const id of ids) {
        thumbnailCache.delete(id);
        videoFrameCache.delete(id);
        const mediaUrl = mediaBlobUrlCache.get(id);
        if(mediaUrl && mediaUrl.startsWith('blob:')) URL.revokeObjectURL(mediaUrl);
        mediaBlobUrlCache.delete(id);
      }
      if(serverMode)await runServer(async()=>{for(const id of ids)await gateway.remove(id);});
      else {
        const remaining=catalogRef.current.files.filter(file=>!ids.includes(file.id));
        const sources=[...new Set(catalogRef.current.files.filter(file=>ids.includes(file.id)).map(file=>file.originalId||file.id))].filter(source=>!remaining.some(file=>(file.originalId||file.id)===source));
        const toDelete=catalogRef.current.files.filter(file=>ids.includes(file.id));
        for(const f of toDelete){if(f.remoteMessageId)void telegramGateway.deleteFile(f);}
        await setCatalog(previous=>({...previous,files:previous.files.filter(file=>!ids.includes(file.id))}),{remove:sources});
      }
      setSelected(new Set());closeDialog();notify(t('Removed from this workspace. Telegram originals are unchanged.','ওয়ার্কস্পেস থেকে সরানো হয়েছে। টেলিগ্রামের মূল ফাইল অপরিবর্তিত আছে।'));
    }catch(error){setFormError(explainError(error));}
  };
  const deleteFolder=async(folder:Folder,toTrash:boolean)=>{
    try{
      const ids=new Set([folder.id]);let old=0;while(old!==ids.size){old=ids.size;catalog.folders.forEach(f=>{if(f.parentId&&ids.has(f.parentId))ids.add(f.id);});}
      if(serverMode)await runServer(()=>gateway.deleteFolder(folder,toTrash?'trash':'root'));
      else await setCatalog(previous=>({...previous,folders:previous.folders.filter(f=>!ids.has(f.id)),files:previous.files.map(file=>file.folderId&&ids.has(file.folderId)?{...file,folderId:null,trashedAt:toTrash?new Date().toISOString():file.trashedAt}:file)}));
      if(folderId&&ids.has(folderId))setFolderId(null);closeDialog();notify(toTrash?'Folder removed; its files are in trash.':'Folder removed; its files are in My drive.');
    }catch(error){setFormError(explainError(error));}
  };
  const clearServerSession=()=>{resetRuntime();setSelected(new Set());setMenu(null);setAccount(null);const empty=emptyCatalog();catalogRef.current=empty;renderCatalog(empty);setReady(false);readyRef.current=false;setPreview(null);setPendingUploads([]);closeDialog();setServerError('Signed out. Connect Telegram to open your drive.');};
  const signOut=async()=>{try{await gateway.logout();clearServerSession();notify(t('Signed out of this device.','এই ডিভাইস থেকে সাইন আউট হয়েছে।'));}catch(error){notify(explainError(error));}};
  const disconnect=async()=>{
    if (serverMode) {
      try{const result=await gateway.disconnect();const pending=JSON.stringify(result).includes('pending');await gateway.logout().catch(()=>{});clearServerSession();notify(pending?t('Disconnect requested. Telegram revocation is pending.','সংযোগ বিচ্ছিন্ন করার অনুরোধ হয়েছে। টেলিগ্রামের সেশন বাতিলের অপেক্ষায়।'):t('Telegram session disconnected. Your messages are unchanged.','টেলিগ্রাম সেশন বিচ্ছিন্ন হয়েছে। আপনার মেসেজ অপরিবর্তিত আছে।'));}
      catch(error){notify(explainError(error));}
    } else {
      telegramGateway.resetSession();
      setAccount(null);
      closeDialog();
      notify(t('Telegram session disconnected from this browser.','এই ব্রাউজার থেকে টেলিগ্রাম সেশন বিচ্ছিন্ন হয়েছে।'));
    }
  };
  const countFor=(next:View)=>next==='all'?activeFiles.length:next==='favorites'?activeFiles.filter(f=>f.favorite).length:next==='trash'?catalog.files.filter(f=>f.trashedAt).length:next==='transfers'?catalog.transfers.filter(item=>!['completed','cancelled','failed'].includes(item.status)).length:0;
  const toggleSelected=(id:string)=>setSelected(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next;});
  const formatDate=(date:string)=>new Intl.DateTimeFormat(locale==='bn'?'bn-BD':'en-GB',{day:'numeric',month:'short',year:'numeric'}).format(new Date(date));
  const pageTitle=currentFolder?.name||t(...viewLabels[view]);
  const isDefault=view==='all'&&!folderId&&!search;
  const transferLabel=(item:Transfer)=>{
    if(item.status==='paused'){
      return t('Paused (ready to resume)','বিরতি (চালিয়ে নেওয়ার জন্য প্রস্তুত)');
    }
    if(!serverMode){
      if(item.direction==='download'){
        return item.status==='completed'?t('Download completed','ডাউনলোড সম্পন্ন'):item.status==='failed'?t('Download failed','ডাউনলোড ব্যর্থ'):item.status==='cancelled'?t('Download cancelled','ডাউনলোড বাতিল'):t('Downloading from Telegram…','টেলিগ্রাম থেকে ডাউনলোড হচ্ছে…');
      }
      if(account?.telegram_connected){
        return item.status==='completed'?t('Confirmed in Telegram','টেলিগ্রামে নিশ্চিত'):item.status==='failed'?t('Upload failed','আপলোড ব্যর্থ'):item.status==='cancelled'?t('Cancelled','বাতিল'):t('Uploading to Telegram…','টেলিগ্রামে আপলোড হচ্ছে…');
      }
      return item.status==='completed'?t('Saved locally','ব্রাউজারে সেভ'):item.status==='failed'?t('Needs attention','মনোযোগ প্রয়োজন'):item.status==='cancelled'?t('Cancelled','বাতিল'):t('Saving','সেভ হচ্ছে');
    }
    const labels:Record<string,[string,string]>={PREPARING:['Checking original bytes','মূল ফাইল যাচাই হচ্ছে'],CREATED:['Ready to upload','আপলোডের জন্য প্রস্তুত'],STAGING:['Uploading to the service','সার্ভারে আপলোড হচ্ছে'],STAGED:['Original received','মূল ফাইল গ্রহণ হয়েছে'],QUEUED:['Queued for Telegram','টেলিগ্রামের অপেক্ষায়'],SENDING:['Sending to Telegram','টেলিগ্রামে পাঠানো হচ্ছে'],VERIFYING:['Verifying upload','আপলোড যাচাই হচ্ছে'],RECONCILING:['Verifying an uncertain result','অনিশ্চিত ফলাফল যাচাই হচ্ছে'],WAITING_PROVIDER:['Waiting for Telegram','টেলিগ্রামের অপেক্ষায়'],WAITING_NETWORK:['Waiting for network','নেটওয়ার্কের অপেক্ষায়'],RETRY_SCHEDULED:['Retry scheduled','পুনরায় চেষ্টার সময় নির্ধারিত'],CANCEL_REQUESTED:['Cancellation requested','বাতিলের অনুরোধ হয়েছে'],CANCELLED:['Cancelled','বাতিল'],COMPLETED:['Confirmed in Telegram','টেলিগ্রামে নিশ্চিত হয়েছে'],FAILED:['Needs attention','মনোযোগ প্রয়োজন'],NEEDS_ATTENTION:['Needs attention','মনোযোগ প্রয়োজন']};
    return labels[item.state||'']?t(...labels[item.state||'']):t('Checking transfer status','ট্রান্সফারের অবস্থা যাচাই হচ্ছে');
  };
  const activeTransfers=catalog.transfers.filter(item=>!['completed','cancelled','failed'].includes(item.status));
  const recentFinishedTransfers=catalog.transfers.filter(item=>sessionTransfersRef.current.has(item.id)&&['completed','failed'].includes(item.status)).slice(0,3);
  const showDock=!dismissedDock&&(activeTransfers.length>0||recentFinishedTransfers.length>0);
  const totalActiveBytes=activeTransfers.reduce((sum,item)=>sum+item.bytes,0);
  const totalTransferredBytes=activeTransfers.reduce((sum,item)=>{
    const p=item.stagedBytes??item.stageBytes??(item.status==='completed'?item.bytes:0);
    return sum+p;
  },0);
  const overallPct=totalActiveBytes>0
    ?Math.min(100,Math.round((totalTransferredBytes/totalActiveBytes)*100))
    :activeTransfers.length===0&&recentFinishedTransfers.length>0?100:0;
  const hasDownload=activeTransfers.some(item=>item.direction==='download');
  const isPaused=activeTransfers.length>0&&activeTransfers.every(item=>item.status==='paused');
  const isCompleted=activeTransfers.length===0&&recentFinishedTransfers.length>0;
  const ringRadius=22;
  const ringCircumference=2*Math.PI*ringRadius;
  const ringOffset=ringCircumference*(1-overallPct/100);
  return <div className="app-shell" onDragEnter={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();draggingDepth.current++;setDragging(true);}}} onDragLeave={event=>{event.preventDefault();if(--draggingDepth.current<=0){setDragging(false);draggingDepth.current=0;}}} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();setDragging(false);draggingDepth.current=0;upload(event.dataTransfer.files);}}>
    {dialog?.type==='settings'&&!serverMode&&<input ref={importInput} type="file" accept="application/json,.json" hidden aria-label="Import catalog JSON" onChange={event=>{const file=event.target.files?.[0];if(file)prepareImport(file);}}/>}
    <input ref={fileInput} type="file" multiple hidden onChange={event=>{if(event.target.files)upload(event.target.files);}} aria-label="Upload files"/>
    {mobileNav&&<div className="mobile-shade" onClick={()=>setMobileNav(false)}/>}
    <aside className={`sidebar ${mobileNav?'sidebar-open':''}`}>
      <button className="brand-button" onClick={()=>navigate('all')} aria-label="filedeck.ai home"><Brand/></button>
      <p className="nav-caption">{t('YOUR WORKSPACE','আপনার ওয়ার্কস্পেস')}</p>
      <nav aria-label={t('Main navigation','প্রধান নেভিগেশন')}>
        {(['all','photos','videos','documents','audio'] as View[]).map(next=>{const Icon=icons[next];return <button key={next} onClick={()=>navigate(next)} className={`nav-link ${view===next&&!folderId?'active':''}`}><Icon size={19}/><span>{t(...viewLabels[next])}</span>{next==='all'&&<span className="nav-count">{countFor(next)}</span>}</button>;})}
        <div className="nav-divider"/>
        {(['favorites','recent','transfers','trash'] as View[]).map(next=>{const Icon=icons[next];return <button key={next} onClick={()=>navigate(next)} className={`nav-link ${view===next?'active':''}`}><Icon size={19}/><span>{t(...viewLabels[next])}</span>{countFor(next)>0&&<span className="nav-count">{countFor(next)}</span>}{next==='transfers'&&<span className="tiny-dot"/>}</button>;})}
      </nav>
      <div className="sidebar-bottom">
        <div className="storage-card"><div className="storage-title"><span className="telegram-icon"><Send size={16}/></span><strong>{t('Made for Telegram','টেলিগ্রামের জন্য তৈরি')}</strong><Info size={14}/></div><p>{t('Your originals. Your account. A familiar home for both.','আপনার মূল ফাইল। আপনার অ্যাকাউন্ট। সবকিছুর পরিচিত ঠিকানা।')}</p><button onClick={()=>{setMobileNav(false);openDialog({type:'connect'});}}>{t('Connect your account','আপনার অ্যাকাউন্ট যুক্ত করুন')}<ArrowRight size={15}/></button></div>
        <div className="workspace-label" onClick={()=>{setMobileNav(false);openDialog({type:'settings'});}} role="button" tabIndex={0} aria-label={t('Workspace settings','ওয়ার্কস্পেস সেটিংস')}><span className="workspace-avatar">N</span><div><strong>{t('Personal workspace','ব্যক্তিগত ওয়ার্কস্পেস')}</strong><span>{t('A little more organized','সবকিছু আরও গোছানো')}</span></div><ChevronDown size={15}/></div>
        <button className="nav-link" onClick={()=>{setMobileNav(false);openDialog({type:'settings'});}}><Settings2 size={19}/><span>{t('Settings','সেটিংস')}</span></button>
        <button className="nav-link" onClick={()=>{setMobileNav(false);openDialog({type:'help'});}}><CircleHelp size={19}/><span>{t('Help & getting started','সাহায্য ও নির্দেশনা')}</span><span className="external-arrow">↗</span></button>
        <div className="sidebar-foot"><span className="mini-leaf">✳</span>{t('A calmer kind of cloud.','মেঘের মতো হালকা।')}</div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={()=>setMobileNav(true)}><Menu size={22}/></button><div className="topbar-breadcrumb"><Cloud size={17}/><span>{t('Workspace','ওয়ার্কস্পেস')}</span><ChevronRight size={14}/><strong>{pageTitle}</strong></div></div><div className="global-search"><Search size={18}/><input ref={searchInput} value={search} onChange={event=>setSearch(event.target.value)} placeholder={t('Find something in your drive…','ড্রাইভে কিছু খুঁজুন…')} aria-label={t('Search files and tags','ফাইল ও ট্যাগ খুঁজুন')}/>{search?<button aria-label="Clear search" onClick={()=>setSearch('')}><X size={15}/></button>:<kbd>⌘ K</kbd>}</div><div className="topbar-actions"><button className="locale-button" onClick={()=>{const next=locale==='en'?'bn':'en';setLocale(next);localStorage.setItem('cloudnest-locale',next);document.documentElement.lang=next;}}><Languages size={16}/>{locale==='en'?'বাংলা':'English'}</button><span className="topbar-separator"/><button className="avatar" onClick={()=>openDialog({type:'settings'})} aria-label="Workspace settings">N</button></div></header>
      <main>
        <div className="page-heading"><div>{!['all','photos','videos','documents','audio'].includes(view)&&<div className="eyebrow"><span/>{t('A HOME FOR YOUR FILES','আপনার ফাইলের ঠিকানা')}</div>}<h1>{search?t('Search results','অনুসন্ধানের ফলাফল'):pageTitle}<span className="heading-dot">.</span></h1>{view==='trash'?<p>{t('A second chance for the things you might still need.','যে ফাইলগুলো আবার দরকার হতে পারে।')}</p>:view==='transfers'?<p>{t('Every file, every step. Always in the know.','প্রতিটি ফাইলের প্রতিটি ধাপ দেখুন।')}</p>:view==='favorites'?<p>{t('Keep the things you love a little closer.','পছন্দের ফাইলগুলো হাতের কাছে রাখুন।')}</p>:null}</div><div className="heading-actions"><span className="demo-badge"><span/>{serverMode?(account?.telegram_connected?t('Telegram connected','টেলিগ্রাম যুক্ত'):t('Connect Telegram','টেলিগ্রাম যুক্ত করুন')):(account?.telegram_connected||hasInitialSession?t('Telegram connected','টেলিগ্রাম যুক্ত'):t('Demo workspace','ডেমো ওয়ার্কস্পেস'))}</span>{['all','photos','videos','documents','audio'].includes(view)&&<><button disabled={!ready} className="button button-light new-folder-button" onClick={()=>openDialog({type:'new-folder'})}><Plus size={16}/><span>{t('New folder','নতুন ফোল্ডার')}</span></button><button disabled={!ready} className="button primary upload-heading-button" onClick={()=>{if(fileInput.current){if(view==='photos')fileInput.current.accept='image/*';else if(view==='videos')fileInput.current.accept='video/*';else if(view==='documents')fileInput.current.accept='.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.md';else if(view==='audio')fileInput.current.accept='audio/*';else fileInput.current.accept='';fileInput.current.click();}}}><Upload size={16}/><span>{view==='photos'?t('Upload photos','ছবি আপলোড'):view==='videos'?t('Upload videos','ভিডিও আপলোড'):view==='documents'?t('Upload documents','ডকুমেন্ট আপলোড'):view==='audio'?t('Upload audio','অডিও আপলোড'):t('Upload files','ফাইল আপলোড')}</span></button></>}</div></div>
        {serverMode&&serverError&&<div className="server-status-notice" role="status"><div><Info size={19}/><span>{serverError}</span></div><button className="button primary" onClick={()=>openDialog({type:'connect'})}>{t('Connect Telegram','টেলিগ্রাম যুক্ত করুন')}<ArrowRight size={15}/></button></div>}
        {serverMode&&syncJob&&<div className="recovery-status" role="status"><Archive size={18}/><div><strong>{t('Telegram recovery','টেলিগ্রাম রিকভারি')} · {String(syncJob.state||'QUEUED')}</strong><span>{Number(syncJob.scanned_files||0)} {t('scanned','স্ক্যান হয়েছে')} · {Number(syncJob.imported_files||0)} {t('imported','আমদানি হয়েছে')} · {Number(syncJob.skipped_files||0)} {t('already known or removed','আগে থেকেই আছে বা সরানো হয়েছে')}{syncJob.error_code?` · ${String(syncJob.error_code)}`:''}{syncJob.status_error?` · ${String(syncJob.status_error)}`:''}</span></div><button className="icon-button" aria-label="Hide recovery status" onClick={()=>setSyncJob(null)}><X size={16}/></button></div>}
        {isDefault&&hero&&<section className="welcome-banner"><div className="banner-copy"><span className="banner-pill"><Sparkles size={13}/>{t('100% SECURE & UNLIMITED','১০০% নিরাপদ ও আনলিমিটেড')}</span><h2>{t('Your Personal Storage Drive.','আপনার নিজস্ব পার্সোনাল ড্রাইভ।')}<br/>{t('100% Secure & Unlimited Space.','১০০% নিরাপদ ও আনলিমিটেড স্টোরেজ।')}</h2><p>{t('Store all your photos, videos, and documents with zero limits.','কোনো স্টোরেজ লিমিট বা মাসিক ফি ছাড়াই নিরাপদে রাখুন আপনার সব ফাইল।')}<br/>{t('Directly connected to your Telegram with complete privacy.','সরাসরি আপনার টেলিগ্রাম অ্যাকাউন্টে সংরক্ষিত, শতভাগ ব্যক্তিগত ও সুরক্ষিত।')}</p><button onClick={()=>openDialog({type:'connect'})}>{t('Connect your drive','আপনার ড্রাইভ যুক্ত করুন')}<ArrowRight size={15}/></button></div><div className="banner-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="art-cloud"><Cloud size={79} strokeWidth={1.1}/><div className="cloud-spark">✦</div></div><div className="floating-file float-photo"><div><Image size={28}/></div><span>little moments.jpg</span></div><div className="floating-file float-doc"><div><FileText size={26}/></div><span>the next big idea.pdf</span></div><div className="art-star star-one">✦</div><div className="art-star star-two">✧</div><span className="art-dot dot-one"/><span className="art-dot dot-two"/></div><button className="banner-close" aria-label="Dismiss welcome banner" onClick={()=>setHero(false)}><X size={17}/></button></section>}
        {folderId&&<div className="folder-breadcrumb"><button onClick={()=>navigate(view)}>{view==='all'?t('My drive','আমার ড্রাইভ'):t(...viewLabels[view])}</button>{breadcrumbs.map(folder=><span key={folder.id}><ChevronRight size={14}/><button onClick={()=>navigate(view,folder.id)}>{folder.name}</button></span>)}</div>}
        {currentFolder?.syncSource&&<div className="folder-sync-banner"><div className="sync-banner-info"><Smartphone size={18}/><div><strong>{t(`Auto-sync active: ${currentFolder.syncSource.pathName}`,`অটো-সিঙ্ক সক্রিয়: ${currentFolder.syncSource.pathName}`)}</strong><span>{currentFolder.syncSource.lastSyncedAt?t(`Last checked: ${formatDate(currentFolder.syncSource.lastSyncedAt)}`,`সর্বশেষ স্ক্যান: ${formatDate(currentFolder.syncSource.lastSyncedAt)}`):t('Ready to sync','সিঙ্কের জন্য প্রস্তুত')}</span></div></div><button className="button button-light" onClick={()=>runFolderSync(currentFolder)} disabled={isSyncingFolder===currentFolder.id}><RefreshCw size={13} className={isSyncingFolder===currentFolder.id?'spin':''}/>{t('Sync now','এখনই সিঙ্ক')}</button></div>}
        {((['all','photos','videos','documents','audio'].includes(view)) && (displayedFolders.length>0 || (view==='all' && !search && !folderId))) && (
          <section className="folders-section">
            <div className="section-heading">
              <h2>
                {currentFolder ? t('Folders','ফোল্ডার') :
                 view==='photos' ? t('Photo folders','ছবির ফোল্ডার') :
                 view==='videos' ? t('Video folders','ভিডিওর ফোল্ডার') :
                 view==='documents' ? t('Document folders','ডকুমেন্টের ফোল্ডার') :
                 view==='audio' ? t('Audio folders','অডিও ফোল্ডার') :
                 t('Your folders','আপনার ফোল্ডার')}
                <span>{displayedFolders.length.toString().padStart(2,'0')}</span>
              </h2>
              <button className="text-button" onClick={()=>openDialog({type:'new-folder'})}>
                <Plus size={14}/>{t('Create new','নতুন তৈরি')}
              </button>
            </div>
            <div className="folder-grid">
              {displayedFolders.map(folder => {
                const folderKind = getFolderKind(folder);
                const folderFiles = activeFiles.filter(file => file.folderId === folder.id);
                const folderBytes = folderFiles.reduce((sum, file) => sum + file.bytes, 0);
                return (
                  <div className={`folder-card ${folder.color || 'green'} folder-kind-${folderKind}`} key={folder.id}>
                    <button className="folder-open" onClick={()=>navigate(view, folder.id)}>
                      <div className={`folder-card-icon ${folderKind}`}>
                        <FolderIcon size={29} strokeWidth={1.2} fill="currentColor"/>
                        <span><FolderIcon size={29} strokeWidth={1.2} fill="currentColor"/></span>
                        {folderKind === 'image' && <span className="folder-badge photo" title={t('Photos','ছবি')}><Image size={11} strokeWidth={2.2}/></span>}
                        {folderKind === 'video' && <span className="folder-badge video" title={t('Videos','ভিডিও')}><Film size={11} strokeWidth={2.2}/></span>}
                        {folderKind === 'document' && <span className="folder-badge document" title={t('Documents','ডকুমেন্ট')}><FileText size={11} strokeWidth={2.2}/></span>}
                        {folderKind === 'audio' && <span className="folder-badge audio" title={t('Audio','অডিও')}><Music2 size={11} strokeWidth={2.2}/></span>}
                      </div>
                      <strong>{folder.name}</strong>
                      <div className="folder-meta-row">
                        <span>{folderFiles.length} {t('files','ফাইল')}<span className="folder-size">{formatBytes(folderBytes)}</span></span>
                        {folderKind !== 'all' && (
                          <span className={`folder-kind-tag ${folderKind}`}>
                            {folderKind === 'image' ? t('Photos','ছবি') :
                             folderKind === 'video' ? t('Videos','ভিডিও') :
                             folderKind === 'document' ? t('Docs','ডকুমেন্ট') :
                             t('Audio','অডিও')}
                          </span>
                        )}
                      </div>
                      {folder.syncSource && <span className="folder-sync-badge"><Smartphone size={10}/><span>{folder.syncSource.pathName}</span></span>}
                    </button>
                    <button className="folder-menu icon-button" aria-label={`Manage ${folder.name}`} onClick={()=>openDialog({type:'folder',folder})}>
                      <Ellipsis size={18}/>
                    </button>
                    <span className="folder-corner"><ArrowRight size={15}/></span>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {view==='transfers'?<section className="files-section">
          <div className="section-heading"><h2>{t('Transfer activity','ট্রান্সফারের অবস্থা')}<span>{transfers.length}</span></h2><button className="text-button" onClick={clearFinished}>{t('Clear finished','সম্পন্নগুলো সরান')}</button></div>
          <div className="local-notice"><Info size={17}/>{serverMode?t('An upload is complete only after Telegram confirms its message. Received bytes and queued transfers are still in progress.','টেলিগ্রাম মেসেজ নিশ্চিত করার পরই আপলোড সম্পন্ন হয়। বাইট গ্রহণ বা কিউতে থাকা মানে কাজ এখনো চলছে।'):t('Transfers connect directly to Telegram MTProto over WebSockets. Originals are stored directly in your Saved Messages.','ট্রান্সফার ব্রাউজার থেকে সরাসরি টেলিগ্রাম MTProto ওয়েবসকেটে সংযুক্ত। আপনার সেভড মেসেজে ফাইল সংরক্ষিত হয়।')}</div>
          {pendingUploads.length>0&&<div className="pending-uploads"><h3>{t('Uploads you can resume','যে আপলোডগুলো চালিয়ে যেতে পারবেন')}</h3><p>{t('Choose the same original file. Its bytes are checked before continuing from the server’s verified offset.','একই মূল ফাইল বেছে নিন। সার্ভারের যাচাই করা অবস্থান থেকে চালানোর আগে ফাইলের বাইট পরীক্ষা করা হবে।')}</p>{pendingUploads.map(item=><div key={item.id} className="pending-upload-row"><div><strong>{item.name}</strong><span>{formatBytes(item.offset)} / {formatBytes(item.bytes)}</span></div><button className="button button-light" onClick={()=>{resumeTarget.current=item.id;fileInput.current?.click();}}>{t('Choose original & resume','মূল ফাইল বেছে চালিয়ে যান')}</button><button className="icon-button" aria-label={`Cancel ${item.name}`} onClick={()=>{if(item.uploadId)cancelTransfer(item.uploadId);else{gateway.discardUpload(item.id);setPendingUploads(gateway.pendingUploads());}}}><X size={16}/></button></div>)}</div>}
          {transfers.length?transfers.map(item=>{
            const progressBytes=item.stagedBytes??item.stageBytes??(item.status==='completed'?item.bytes:0);
            const progressPct=Math.min(100,Math.round((progressBytes/Math.max(1,item.bytes))*100));
            const isActive=!['completed','cancelled','failed'].includes(item.status);
            const isDownload=item.direction==='download';
            return <div className="transfer-row" key={item.id}>
              <div className="transfer-type">
                <TypeIcon kind={item.kind||kindFor('',item.name)} size={22}/>
                <span className={`transfer-direction-badge ${isDownload?'download':'upload'}`} title={isDownload?t('Download','ডাউনলোড'):t('Upload','আপলোড')}>
                  {isDownload?<ArrowDown size={10}/>:<ArrowUp size={10}/>}
                </span>
              </div>
              <div className="transfer-info">
                <strong>{item.name}</strong>
                <span>{formatBytes(item.bytes)} · {transferLabel(item)}</span>
                {isActive&&<div className="transfer-progress-wrap"><div className="transfer-progress"><span style={{width:`${progressPct}%`}}/></div><div className="transfer-progress-meta"><span>{formatBytes(progressBytes)} / {formatBytes(item.bytes)}</span><strong>{progressPct}%</strong></div></div>}
              </div>
              <span className={`transfer-status ${item.status}`}>
                {item.status==='completed'?<CheckCheck size={18}/>:item.status==='paused'?<Pause size={18}/>:isActive?<LoaderCircle size={18} className="spin"/>:<Info size={18}/>}
                <span>{item.status==='paused'?`${progressPct}% · ${transferLabel(item)}`:isActive?`${progressPct}% · ${transferLabel(item)}`:transferLabel(item)}</span>
              </span>
              {item.status==='saving'&&<button className="button button-light" onClick={()=>pauseTransfer(item.id)}><Pause size={14}/><span>{t('Pause','বিরতি')}</span></button>}
              {item.status==='paused'&&<button className="button button-light" onClick={()=>resumeTransfer(item.id)}><Play size={14}/><span>{t('Resume','চালিয়ে যান')}</span></button>}
              {serverMode&&controllers.current.has(item.id)&&<button className="button button-light" onClick={()=>pauseTransfer(item.id)}>{t('Pause','বিরতি')}</button>}
              {isActive&&<button className="icon-button" aria-label="Cancel transfer" onClick={()=>cancelTransfer(item.id)}><X size={18}/></button>}
              {item.status==='failed'&&<button className="button button-light" onClick={()=>serverMode?retryTransfer(item.id):resumeTransfer(item.id)}>{serverMode?t('Retry safely','আবার চেষ্টা'):t('Resume / Retry','পুনরায় চেষ্টা')}</button>}
            </div>;
          }):<Empty icon={<ArrowUpFromLine size={30}/>} title={t('A clear runway','সব প্রস্তুত')} text={t('Your uploads and downloads will appear here, with real-time progress.','আপনার আপলোড ও ডাউনলোডের রিয়েল-টাইম অগ্রগতি এখানে দেখা যাবে।')} action={t('Upload your first file','প্রথম ফাইল আপলোড করুন')} onAction={()=>fileInput.current?.click()}/>}
        </section>:<section className="files-section"><div className="file-toolbar">
<div className="section-heading"><h2>{search?t('Matching files','মিলে যাওয়া ফাইল'):view==='all'?t('All files','সব ফাইল'):t(...viewLabels[view])}<span>{visible.length.toString().padStart(2,'0')}</span></h2></div><div className="file-controls"><button className={`button button-light filter-button ${filters?'control-active':''}`} onClick={()=>setFilters(!filters)}><SlidersHorizontal size={15}/>{t('Filters','ফিল্টার')}{(kind!=='all'||dateFilter!=='all')&&<span className="filter-dot"/>}</button><label className="sort-control"><span className="sr-only">Sort files</span><select value={sort} onChange={event=>setSort(event.target.value)}><option value="recent">{t('Last added','সর্বশেষ যোগ')}</option><option value="name">{t('Name A–Z','নাম A–Z')}</option><option value="size">{t('Largest first','বড় ফাইল আগে')}</option></select><ChevronDown size={14}/></label><div className="view-toggle"><button className={layout==='grid'?'active':''} onClick={()=>setLayout('grid')} aria-label="Grid view" aria-pressed={layout==='grid'}><Grid2X2 size={16}/></button><button className={layout==='list'?'active':''} onClick={()=>setLayout('list')} aria-label="List view" aria-pressed={layout==='list'}><List size={17}/></button></div></div></div>
        {filters&&<div className="filter-panel"><label>{t('File type','ফাইলের ধরন')}<select value={kind} onChange={event=>setKind(event.target.value)}><option value="all">{t('All types','সব ধরনের')}</option><option value="image">{t('Images','ছবি')}</option><option value="document">{t('Documents','ডকুমেন্ট')}</option><option value="video">{t('Videos','ভিডিও')}</option><option value="audio">{t('Audio','অডিও')}</option></select></label><label>{t('Date added','যোগ করার তারিখ')}<select value={dateFilter} onChange={event=>setDateFilter(event.target.value)}><option value="all">{t('Any time','যেকোনো সময়')}</option><option value="7">{t('Last 7 days','গত ৭ দিন')}</option><option value="30">{t('Last 30 days','গত ৩০ দিন')}</option></select></label><button className="text-button" onClick={()=>{setKind('all');setDateFilter('all');}}>{t('Reset filters','ফিল্টার রিসেট')}</button></div>}
        {view==='trash'&&<div className="local-notice"><Info size={17}/>{t('Trash is reversible. The 30-day reminder does not automatically delete anything from Telegram.','ট্র্যাশ থেকে ফিরিয়ে আনা যায়। ৩০ দিনের স্মারক টেলিগ্রাম থেকে কিছু মুছে দেয় না।')}</div>}
        {selected.size>0&&<div className="selection-bar"><button className="icon-button" aria-label="Clear selection" onClick={()=>setSelected(new Set())}><X size={16}/></button><strong>{selected.size} {t('selected','নির্বাচিত')}</strong><button onClick={()=>setSelected(new Set(visible.map(file=>file.id)))}>{t('Select all','সব নির্বাচন')}</button><div/>{view==='trash'?<><button onClick={()=>restore([...selected])}><Archive size={15}/>{t('Restore','ফিরিয়ে আনুন')}</button><button onClick={()=>openDialog({type:'remove',ids:[...selected]})}><Trash2 size={15}/>{t('Remove','সরান')}</button></>:<><button onClick={()=>openDialog({type:'move',ids:[...selected]})}><FolderOpen size={15}/>{t('Move','সরান')}</button><button onClick={()=>{[...selected].forEach(id=>{const file=catalog.files.find(f=>f.id===id);if(file)download(file);});}}><Download size={15}/>{t('Download','ডাউনলোড')}</button><button onClick={()=>trash([...selected])}><Trash2 size={15}/>{t('Trash','ট্র্যাশ')}</button></>}</div>}
        {visible.length>0?<div className={layout==='grid'?'file-grid':'file-list'}>
          {layout==='list'&&<div className="list-header"><span>{t('Name','নাম')}</span><span>{t('File size','আকার')}</span><span>{t('Date added','তারিখ')}</span><span/></div>}
          {visible.map(file=>(
            <article key={file.id} className={`file-card ${selected.has(file.id)?'file-selected':''}`}>
              <div className={`file-thumbnail file-${file.kind}`}>
                <button className="thumbnail-open" aria-label={`Preview ${file.name}`} onClick={()=>{setPreview(file);setTagValue('');}}>
                  {file.kind==='audio'?(
                    <div className="audio-card-thumb">
                      <div className={`audio-disc ${activeAudioFile?.id===file.id&&isPlayingAudio?'spinning':''}`}>
                        <Music2 size={34}/>
                      </div>
                      <span
                        role="button"
                        tabIndex={0}
                        className={`audio-card-play-btn ${activeAudioFile?.id===file.id&&isPlayingAudio?'playing':''}`}
                        onClick={(e)=>{e.stopPropagation();void toggleAudioPlay(file);}}
                        title={activeAudioFile?.id===file.id&&isPlayingAudio?t('Pause','বিরতি'):t('Play','চালান')}
                        aria-label={activeAudioFile?.id===file.id&&isPlayingAudio?t('Pause','বিরতি'):t('Play','চালান')}
                      >
                        {activeAudioFile?.id===file.id&&audioLoading?(
                          <LoaderCircle size={20} className="spin"/>
                        ):activeAudioFile?.id===file.id&&isPlayingAudio?(
                          <Pause size={20}/>
                        ):(
                          <Play size={20} style={{marginLeft:'2px'}}/>
                        )}
                      </span>
                      <span className="audio-tag-pill">AUDIO</span>
                    </div>
                  ):(file.kind==='image'||file.kind==='video')?(
                    <LocalThumbnail file={file}/>
                  ):!file.asset?(
                    <div className="uploaded-placeholder"><TypeIcon kind={file.kind} size={40}/><span>{file.name.split('.').pop()?.toUpperCase()}</span></div>
                  ):(
                    <div className={`document-preview ${file.mime==='application/pdf'?'pdf-preview':file.name.endsWith('.csv')?'sheet-preview':''}`}>
                      <div className="paper">
                        <span className="paper-eyebrow">{file.mime==='application/pdf'?'FILEDECK STUDIO':file.name.endsWith('.csv')?'PERSONAL FINANCE':'A LITTLE SPACE TO THINK'}</span>
                        <strong>{file.mime==='application/pdf'?'Good things\nstart with a plan.':file.name.endsWith('.csv')?'October\nat a glance.':file.name.endsWith('.md')?'The little\nthings matter.':'Make yourself\nat home.'}</strong>
                        <span className="paper-rule"/><span className="paper-line"/><span className="paper-line short"/>
                        <span className="paper-stamp">{file.mime==='application/pdf'?'PROJECT BRIEF / 2026':file.name.endsWith('.csv')?'BUDGET & EVERYDAY':'NOTES & EVERYDAY'}</span>
                      </div>
                      <span className="document-type">{file.name.split('.').pop()?.toUpperCase()}</span>
                    </div>
                  )}
                </button>
                <input type="checkbox" className="file-check" checked={selected.has(file.id)} onChange={()=>toggleSelected(file.id)} aria-label={`Select ${file.name}`}/>
                {file.favorite&&<span className="thumbnail-favorite"><Star size={12} fill="currentColor"/></span>}
              </div>
              <div className="file-card-details">
                {layout==='list'&&<input type="checkbox" className="list-file-check" checked={selected.has(file.id)} onChange={()=>toggleSelected(file.id)} aria-label={`Select ${file.name}`}/>}
                <div className={`file-type-icon ${file.kind}`}>
                  {file.kind==='audio'?(
                    <button
                      type="button"
                      className={`list-audio-play-btn ${activeAudioFile?.id===file.id&&isPlayingAudio?'playing':''}`}
                      onClick={(e)=>{e.stopPropagation();void toggleAudioPlay(file);}}
                      title={activeAudioFile?.id===file.id&&isPlayingAudio?t('Pause','বিরতি'):t('Play','চালান')}
                      aria-label={activeAudioFile?.id===file.id&&isPlayingAudio?t('Pause','বিরতি'):t('Play','চালান')}
                    >
                      {activeAudioFile?.id===file.id&&audioLoading?(
                        <LoaderCircle size={14} className="spin"/>
                      ):activeAudioFile?.id===file.id&&isPlayingAudio?(
                        <Pause size={14}/>
                      ):(
                        <Play size={14} style={{marginLeft:'1px'}}/>
                      )}
                    </button>
                  ):(
                    <TypeIcon kind={file.kind} size={17}/>
                  )}
                </div>
                <button className="file-name" title={file.name} onClick={()=>{setPreview(file);setTagValue('');}}>
                  <strong>{file.name}</strong>
                  <span>{formatBytes(file.bytes)}<span>·</span>{formatDate(file.createdAt)}</span>
                </button>
                <span className="list-size">{formatBytes(file.bytes)}</span>
                <span className="list-date">{formatDate(file.createdAt)}</span>
                <div className="file-menu-wrap">
                  <button className={`icon-button file-menu-button ${menu===file.id?'menu-active':''}`} aria-label={`Actions for ${file.name}`} aria-expanded={menu===file.id} onClick={()=>setMenu(menu===file.id?null:file.id)}>
                    <Ellipsis size={19}/>
                  </button>
                  {menu===file.id&&<>
                    <div className="menu-dismiss" onClick={()=>setMenu(null)}/>
                    <div className="file-menu" role="menu">
                      {file.trashedAt?(
                        <>
                          <button role="menuitem" onClick={()=>restore([file.id])}><Archive size={15}/>{t('Restore to drive','ড্রাইভে ফিরিয়ে আনুন')}</button>
                          <button role="menuitem" className="danger-text" onClick={()=>openDialog({type:'remove',ids:[file.id]})}><Trash2 size={15}/>{t('Remove from app','অ্যাপ থেকে সরান')}</button>
                        </>
                      ):(
                        <>
                          {file.kind==='audio'&&(
                            <button role="menuitem" onClick={()=>{void toggleAudioPlay(file);setMenu(null);}}>
                              {activeAudioFile?.id===file.id&&isPlayingAudio?(
                                <><Pause size={15}/>{t('Pause audio','অডিও বিরতি')}</>
                              ):(
                                <><Play size={15}/>{t('Play audio','অডিও চালান')}</>
                              )}
                            </button>
                          )}
                          <button role="menuitem" onClick={()=>{setPreview(file);setMenu(null);}}><File size={15}/>{t('Preview & details','প্রিভিউ ও বিস্তারিত')}</button>
                          <button role="menuitem" onClick={()=>download(file)}><Download size={15}/>{t('Download original','মূল ফাইল ডাউনলোড')}</button>
                          <button role="menuitem" onClick={()=>favorite(file)}><Star size={15}/>{file.favorite?t('Remove favorite','পছন্দ থেকে সরান'):t('Add to favorites','পছন্দে যোগ করুন')}</button>
                          <div className="menu-line"/>
                          <button role="menuitem" onClick={()=>openDialog({type:'rename',file})}><FileText size={15}/>{t('Rename','নাম পরিবর্তন')}</button>
                          <button role="menuitem" onClick={()=>openDialog({type:'move',ids:[file.id]})}><FolderOpen size={15}/>{t('Move to folder','ফোল্ডারে সরান')}</button>
                          <button role="menuitem" className="danger-text" onClick={()=>trash([file.id])}><Trash2 size={15}/>{t('Move to trash','ট্র্যাশে সরান')}</button>
                        </>
                      )}
                    </div>
                  </>}
                </div>
              </div>
            </article>
          ))}
        </div>:<Empty icon={view==='favorites'?<Star size={30}/>:view==='trash'?<Trash2 size={30}/>:search?<Search size={30}/>:<FolderOpen size={30}/>} title={search?t('No files found','কোনো ফাইল পাওয়া যায়নি'):view==='favorites'?t('A place for your favorites','পছন্দের ফাইলের জায়গা'):view==='trash'?t('Nothing left behind','ট্র্যাশ খালি'):t('A fresh little space','নতুন একটি জায়গা')} text={search?t('Try another filename, tag, or a different filter.','অন্য নাম, ট্যাগ বা ফিল্টার দিয়ে খুঁজুন।'):view==='favorites'?t('Give a file a star and you’ll find it here.','ফাইলে তারকা দিন, এখানে খুঁজে পাবেন।'):view==='trash'?t('Files you move to trash will appear here.','ট্র্যাশে সরানো ফাইল এখানে দেখা যাবে।'):t('Drop something here, or upload your first file.','এখানে ফাইল ছেড়ে দিন, অথবা প্রথম ফাইল আপলোড করুন।')} action={search?t('Clear search & filters','অনুসন্ধান ও ফিল্টার মুছুন'):view==='trash'||view==='favorites'?t('Back to My drive','আমার ড্রাইভে ফিরুন'):t('Upload files','ফাইল আপলোড')} onAction={()=>{if(search){setSearch('');setKind('all');setDateFilter('all');}else if(view==='trash'||view==='favorites')navigate('all');else fileInput.current?.click();}}/>}
        <div className="files-footer"><span>{visible.length} {t('files','ফাইল')}<span className="footer-dot">·</span>{formatBytes(visible.reduce((sum,file)=>sum+file.bytes,0))}</span><span><ShieldCheck size={13}/>{t('Originals stay original. Always.','মূল ফাইল সবসময় মূল ফাইলই থাকে।')}</span></div></section>}
        <footer className="workspace-footer"><span><span className="footer-green-dot"/>{t('A little more space. A little more peace of mind.','একটু বেশি জায়গা। একটু বেশি স্বস্তি।')}</span><button onClick={()=>openDialog({type:'security'})}>{t('How your files are stored','ফাইল যেভাবে রাখা হয়')}<ArrowRight size={13}/></button></footer>
      </main>
    </div>
    {dragging&&<div className="drop-overlay"><div><CloudUpload size={58}/><h2>{t('Drop it like it’s home.','আপনার ফাইল এখানে ছেড়ে দিন।')}</h2><p>{serverMode?t('Original files. Up to 500 MiB each. Telegram confirms every completed upload.','মূল ফাইল। প্রতিটি সর্বোচ্চ ৫০০ MiB। টেলিগ্রাম প্রতিটি সম্পন্ন আপলোড নিশ্চিত করে।'):t('Original files. Up to 500 MiB each. Saved in this browser demo.','মূল ফাইল। প্রতিটি সর্বোচ্চ ৫০০ MiB। এই ডেমো ব্রাউজারে সেভ হবে।')}</p></div></div>}
    {showDock && (
      dockOpen ? (
        <aside className="transfer-dock" aria-label={t('Transfers','স্থানান্তর')}>
          <div className="transfer-dock-header">
            <div className="transfer-dock-title">
              {activeTransfers.some(t => t.status === 'saving') ? (
                <LoaderCircle size={14} className="spin text-green"/>
              ) : activeTransfers.some(t => t.status === 'paused') ? (
                <Pause size={14} style={{color: '#d97706'}}/>
              ) : (
                <CheckCheck size={14} className="text-green"/>
              )}
              <strong>
                {activeTransfers.length > 0
                  ? t(`${activeTransfers.length} transferring (${overallPct}%)`,`${activeTransfers.length}টি চলছে (${overallPct}%)`)
                  : t('Transfers completed','স্থানান্তর সম্পন্ন')}
              </strong>
            </div>
            <div className="transfer-dock-actions">
              <button
                className="icon-button"
                onClick={()=>setDockOpen(false)}
                aria-label={t('Minimize to icon','আইকনে ছোট করুন')}
                title={t('Minimize to icon','আইকনে ছোট করুন')}
              >
                <ChevronDown size={14}/>
              </button>
              <button
                className="icon-button"
                onClick={()=>setDismissedDock(true)}
                aria-label={t('Close','বন্ধ করুন')}
                title={t('Close','বন্ধ করুন')}
              >
                <X size={14}/>
              </button>
            </div>
          </div>
          <div className="transfer-dock-body">
            <div className="transfer-dock-list">
              {[...activeTransfers, ...recentFinishedTransfers].slice(0, 4).map(item => {
                const progressBytes = item.stagedBytes ?? item.stageBytes ?? (item.status === 'completed' ? item.bytes : 0);
                const progressPct = Math.min(100, Math.round((progressBytes / Math.max(1, item.bytes)) * 100));
                const isActive = !['completed', 'cancelled', 'failed'].includes(item.status);
                const isDownload = item.direction === 'download';
                return (
                  <div className="transfer-dock-item" key={item.id}>
                    <div className="transfer-dock-item-icon">
                      <TypeIcon kind={item.kind || kindFor('', item.name)} size={15}/>
                      <span className={`transfer-direction-badge ${isDownload ? 'download' : 'upload'}`}>
                        {isDownload ? <ArrowDown size={7}/> : <ArrowUp size={7}/>}
                      </span>
                    </div>
                    <div className="transfer-dock-item-info">
                      <div className="transfer-dock-item-name" title={item.name}>{item.name}</div>
                      <div className="transfer-dock-progress-track">
                        <div
                          className={`transfer-dock-progress-fill ${item.status === 'completed' ? 'completed' : item.status === 'paused' ? 'paused' : ''}`}
                          style={{width: `${item.status === 'completed' ? 100 : progressPct}%`}}
                        />
                      </div>
                      <div className="transfer-dock-item-meta">
                        <span>{formatBytes(progressBytes)} / {formatBytes(item.bytes)}</span>
                        <strong>{item.status === 'completed' ? (item.direction === 'download' ? t('Downloaded','ডাউনলোড সম্পন্ন') : t('Uploaded','আপলোড সম্পন্ন')) : item.status === 'paused' ? t('Paused','বিরতি') : `${progressPct}%`}</strong>
                      </div>
                    </div>
                    {isActive && (
                      <div className="transfer-dock-item-action">
                        {item.status === 'saving' && (
                          <button className="icon-button" onClick={()=>pauseTransfer(item.id)} aria-label={`Pause ${item.name}`} title={t('Pause','বিরতি')}>
                            <Pause size={12}/>
                          </button>
                        )}
                        {item.status === 'paused' && (
                          <button className="icon-button resume-button" onClick={()=>resumeTransfer(item.id)} aria-label={`Resume ${item.name}`} title={t('Resume','চালিয়ে যান')}>
                            <Play size={12}/>
                          </button>
                        )}
                        <button className="icon-button" onClick={()=>cancelTransfer(item.id)} aria-label={`Cancel ${item.name}`} title={t('Cancel','বাতিল')}>
                          <X size={12}/>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="transfer-dock-footer">
              <button className="text-button" onClick={()=>{navigate('transfers');setDockOpen(true);}}>
                {t('View all transfers →','সব স্থানান্তর দেখুন →')}
              </button>
            </div>
          </div>
        </aside>
      ) : (
        <button
          className="transfer-fab"
          onClick={()=>setDockOpen(true)}
          aria-label={t('View transfer progress','স্থানান্তর অগ্রগতি দেখুন')}
          title={t(`Transferring: ${overallPct}% (Click to expand)`,`স্থানান্তর: ${overallPct}% (দেখতে ক্লিক করুন)`)}
        >
          <svg className="transfer-fab-svg" width="54" height="54" viewBox="0 0 54 54">
            <circle
              className="transfer-fab-ring-bg"
              cx="27"
              cy="27"
              r={ringRadius}
              strokeWidth="4"
            />
            <circle
              className={`transfer-fab-ring-fill ${isPaused ? 'paused' : isCompleted ? 'completed' : ''}`}
              cx="27"
              cy="27"
              r={ringRadius}
              strokeWidth="4"
              strokeDasharray={ringCircumference}
              strokeDashoffset={ringOffset}
            />
          </svg>
          <div className="transfer-fab-content">
            {isCompleted ? (
              <CheckCheck size={20} className="text-green" />
            ) : isPaused ? (
              <Pause size={17} style={{color: '#d97706'}} />
            ) : (
              <>
                <span className="transfer-fab-dir">
                  {hasDownload ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
                </span>
                <span className="transfer-fab-pct">{overallPct}%</span>
              </>
            )}
          </div>
          {activeTransfers.length > 1 && (
            <span className="transfer-fab-badge">{activeTransfers.length}</span>
          )}
        </button>
      )
    )}
    {toast&&<div className="toast" role="status"><Check size={17}/><span>{toast}</span><button onClick={()=>setToast('')} aria-label="Dismiss notification"><X size={15}/></button></div>}
    {activeAudioFile && (
      <aside className="audio-player-bar" aria-label={t('Audio player','অডিও প্লেয়ার')}>
        <div className="audio-player-left">
          <div className={`audio-player-disc ${isPlayingAudio ? 'spinning' : ''}`}>
            <Music2 size={16}/>
          </div>
          <div className="audio-player-meta">
            <strong title={activeAudioFile.name}>{activeAudioFile.name}</strong>
            <span>{formatBytes(activeAudioFile.bytes)}</span>
          </div>
        </div>
        <div className="audio-player-center">
          <div className="audio-player-controls">
            <button
              type="button"
              className="audio-ctrl-btn"
              onClick={()=>seekRelative(-10)}
              title={t('Rewind 10s','১০ সেকেন্ড পেছনে')}
              aria-label={t('Rewind 10s','১০ সেকেন্ড পেছনে')}
            >
              <RotateCcw size={15}/>
            </button>
            <button
              type="button"
              className="audio-main-play-btn"
              onClick={()=>void toggleAudioPlay(activeAudioFile)}
              title={isPlayingAudio ? t('Pause','বিরতি') : t('Play','চালান')}
              aria-label={isPlayingAudio ? t('Pause','বিরতি') : t('Play','চালান')}
            >
              {audioLoading ? (
                <LoaderCircle size={18} className="spin"/>
              ) : isPlayingAudio ? (
                <Pause size={18}/>
              ) : (
                <Play size={18} style={{marginLeft:'2px'}}/>
              )}
            </button>
            <button
              type="button"
              className="audio-ctrl-btn"
              onClick={()=>seekRelative(10)}
              title={t('Forward 10s','১০ সেকেন্ড সামনে')}
              aria-label={t('Forward 10s','১০ সেকেন্ড সামনে')}
            >
              <RotateCw size={15}/>
            </button>
          </div>
          <div className="audio-player-scrub">
            <span className="audio-time">{formatAudioTime(audioCurrentTime)}</span>
            <div
              className="audio-scrub-track"
              onClick={handleScrubClick}
              role="slider"
              aria-valuemin={0}
              aria-valuemax={audioDuration||100}
              aria-valuenow={audioCurrentTime}
              tabIndex={0}
            >
              <div className="audio-scrub-fill" style={{width:`${audioProgress}%`}}/>
              <div className="audio-scrub-thumb" style={{left:`${audioProgress}%`}}/>
            </div>
            <span className="audio-time">{formatAudioTime(audioDuration)}</span>
          </div>
        </div>
        <div className="audio-player-right">
          <button
            type="button"
            className="icon-button"
            onClick={()=>{
              if(audioRef.current){
                audioRef.current.muted = !isMuted;
                setIsMuted(!isMuted);
              }
            }}
            title={isMuted ? t('Unmute','শব্দ চালু') : t('Mute','শব্দ বন্ধ')}
            aria-label={isMuted ? t('Unmute','শব্দ চালু') : t('Mute','শব্দ বন্ধ')}
          >
            {isMuted ? <VolumeX size={17}/> : <Volume2 size={17}/>}
          </button>
          <button
            type="button"
            className="icon-button audio-close-btn"
            onClick={closeAudioPlayer}
            title={t('Close player','প্লেয়ার বন্ধ করুন')}
            aria-label={t('Close player','প্লেয়ার বন্ধ করুন')}
          >
            <X size={17}/>
          </button>
        </div>
      </aside>
    )}
    <audio
      ref={audioRef}
      style={{display:'none'}}
      onTimeUpdate={()=>{
        if(audioRef.current){
          const cur=audioRef.current.currentTime;
          const dur=audioRef.current.duration||0;
          setAudioCurrentTime(cur);
          setAudioDuration(dur);
          setAudioProgress(dur>0?(cur/dur)*100:0);
        }
      }}
      onLoadedMetadata={()=>{
        if(audioRef.current){
          setAudioDuration(audioRef.current.duration||0);
          setAudioLoading(false);
        }
      }}
      onWaiting={()=>setAudioLoading(true)}
      onPlaying={()=>{
        setAudioLoading(false);
        setIsPlayingAudio(true);
      }}
      onPause={()=>setIsPlayingAudio(false)}
      onEnded={()=>{
        setIsPlayingAudio(false);
        setAudioProgress(0);
        setAudioCurrentTime(0);
      }}
      onError={()=>{
        setAudioLoading(false);
        setIsPlayingAudio(false);
        notify(t('Unable to play audio. Download the file to listen locally.','অডিও চালানো যায়নি। শুনতে ফাইলটি ডাউনলোড করুন।'));
      }}
    />
    {dialog&&<Modal title={dialog.type==='new-folder'?t('A new little space','নতুন একটি জায়গা'):dialog.type==='rename'?t('Rename file','ফাইলের নাম পরিবর্তন'):dialog.type==='move'?t('Move to a folder','ফোল্ডারে সরান'):dialog.type==='folder'?t('Manage folder','ফোল্ডার পরিচালনা'):dialog.type==='remove'?t('Remove from this workspace?','ওয়ার্কস্পেস থেকে সরাবেন?'):dialog.type==='connect'?t('Your Telegram, connected.','আপনার টেলিগ্রাম যুক্ত করুন।'):dialog.type==='settings'?t('Make yourself at home','আপনার মতো করে সাজান'):dialog.type==='security'?t('A clear view of your storage','আপনার স্টোরেজ সম্পর্কে'):dialog.type==='disconnect'?t('Disconnect Telegram?','টেলিগ্রাম বিচ্ছিন্ন করবেন?'):dialog.type==='recovery'?t('Recover from Telegram?','টেলিগ্রাম থেকে রিকভার করবেন?'):t('A little help getting started','শুরু করার নির্দেশনা')} onClose={closeDialog} wide={dialog.type==='settings'}>
      {(['new-folder','rename','move','folder'] as string[]).includes(dialog.type)&&<form onSubmit={submitForm}><p className="modal-description">{dialog.type==='rename'?t('This changes the display name in your drive. The original attachment keeps its name.','এটি ড্রাইভে দেখানো নাম বদলায়। মূল ফাইলের নাম বদলায় না।'):dialog.type==='move'?t('Organization changes here. Your original file stays just as it is.','ফাইল গুছিয়ে রাখুন। মূল ফাইল যেমন আছে তেমনই থাকবে।'):dialog.type==='new-folder'&&view==='photos'?t('Create a dedicated photo album folder. It will appear here and in My drive.','একটি ফটো অ্যালবাম ফোল্ডার তৈরি করুন। এটি এখানে এবং মাই ড্রাইভে থাকবে।'):dialog.type==='new-folder'&&view==='videos'?t('Create a video collection folder. It will appear here and in My drive.','একটি ভিডিও ফোল্ডার তৈরি করুন। এটি এখানে এবং মাই ড্রাইভে থাকবে।'):dialog.type==='new-folder'&&view==='documents'?t('Create a document folder. It will appear here and in My drive.','একটি ডকুমেন্ট ফোল্ডার তৈরি করুন। এটি এখানে এবং মাই ড্রাইভে থাকবে।'):dialog.type==='new-folder'&&view==='audio'?t('Create an audio playlist folder. It will appear here and in My drive.','একটি অডিও ফোল্ডার তৈরি করুন। এটি এখানে এবং মাই ড্রাইভে থাকবে।'):t('Give your files a place to belong. Folders stay inside your filedeck.ai catalog.','ফাইলগুলো গুছিয়ে রাখুন। ফোল্ডার filedeck.ai ক্যাটালগে থাকে।')}</p>{(dialog.type==='new-folder'||dialog.type==='folder')&&<label className="field-label">{t('Folder type & category','ফোল্ডারের ধরন ও ক্যাটাগরি')}<div className="folder-type-selector"><button type="button" className={`folder-type-chip ${folderKindChoice==='all'?'selected':''}`} onClick={()=>setFolderKindChoice('all')}><FolderIcon size={14}/><span>{t('General','সাধারণ')}</span></button><button type="button" className={`folder-type-chip photo ${folderKindChoice==='image'?'selected':''}`} onClick={()=>setFolderKindChoice('image')}><Image size={14}/><span>{t('Photos','ছবি')}</span></button><button type="button" className={`folder-type-chip video ${folderKindChoice==='video'?'selected':''}`} onClick={()=>setFolderKindChoice('video')}><Film size={14}/><span>{t('Videos','ভিডিও')}</span></button><button type="button" className={`folder-type-chip document ${folderKindChoice==='document'?'selected':''}`} onClick={()=>setFolderKindChoice('document')}><FileText size={14}/><span>{t('Docs','ডকুমেন্ট')}</span></button><button type="button" className={`folder-type-chip audio ${folderKindChoice==='audio'?'selected':''}`} onClick={()=>setFolderKindChoice('audio')}><Music2 size={14}/><span>{t('Audio','অডিও')}</span></button></div></label>}{dialog.type!=='move'&&<label className="field-label">{t('Name','নাম')}<input autoFocus value={formValue} onChange={event=>setFormValue(event.target.value)} placeholder={t('Something worth keeping','মনে রাখার মতো কিছু')} maxLength={255} required/></label>}{(dialog.type==='move'||dialog.type==='folder')&&<label className="field-label">{t('Destination folder','যে ফোল্ডারে সরাবেন')}<select value={moveTarget} onChange={event=>setMoveTarget(event.target.value)}><option value="">{dialog.type==='folder'?t('Keep current location','বর্তমান অবস্থানে রাখুন'):t('My drive (root)','আমার ড্রাইভ (মূল)')}</option>{dialog.type==='folder'&&<option value="__root">{t('My drive (root)','আমার ড্রাইভ (মূল)')}</option>}{catalog.folders.filter(folder=>dialog.type!=='folder'||canMoveFolder(catalog.folders,dialog.folder.id,folder.id)).map(folder=><option key={folder.id} value={folder.id}>{getFolderKind(folder)==='image'?'📷 ':getFolderKind(folder)==='video'?'🎬 ':getFolderKind(folder)==='document'?'📄 ':getFolderKind(folder)==='audio'?'🎵 ':''}{folder.name}</option>)}</select></label>}{formError&&<p className="form-error" role="alert">{formError}</p>}<div className="modal-actions"><button type="button" className="button button-light" onClick={closeDialog}>{t('Cancel','বাতিল')}</button><button type="submit" disabled={savingForm} className="button primary">{dialog.type==='new-folder'?t('Create folder','ফোল্ডার তৈরি'):dialog.type==='move'?t('Move files','ফাইল সরান'):t('Save changes','সেভ করুন')}<ArrowRight size={15}/></button></div>{dialog.type==='folder'&&<div className="folder-sync-section">
  <strong><Smartphone size={16}/>{t('Device folder sync & backup','ডিভাইস ফোল্ডার সিঙ্ক ও ব্যাকআপ')}</strong>
  <p>{t('Connect a native folder from your phone or computer. Newly added photos and files will automatically back up to this Filedeck folder in Telegram.','আপনার ফোন বা কম্পিউটারের একটি ফোল্ডার যুক্ত করুন। নতুন ছবি বা ফাইল ড্রাইভের এই ফোল্ডারে স্বয়ংক্রিয়ভাবে ব্যাকআপ হয়ে যাবে।')}</p>
  {dialog.folder.syncSource?(
    <div className="folder-sync-card">
      <div className="sync-meta"><CheckCheck size={14} className="text-green"/><span>{dialog.folder.syncSource.pathName}</span></div>
      <div className="sync-time">{t('Last synced: ','সর্বশেষ সিঙ্ক: ')}{dialog.folder.syncSource.lastSyncedAt?formatDate(dialog.folder.syncSource.lastSyncedAt):t('Never','কখনো নয়')}</div>
      <div className="settings-button-row" style={{marginTop:'10px',marginBottom:0}}>
        <button type="button" className="button button-light" onClick={()=>{void runFolderSync(dialog.folder);closeDialog();}}>
          <RefreshCw size={13}/>{t('Sync now','এখনই সিঙ্ক')}
        </button>
        <button type="button" className="button button-light danger-text" onClick={async()=>{
          await setCatalog(prev=>({
            ...prev,
            folders:prev.folders.map(f=>f.id===dialog.folder.id?{...f,syncSource:undefined}:f)
          }));
          closeDialog();
          notify(t('Folder sync disconnected.','ফোল্ডার সিঙ্ক বিচ্ছিন্ন করা হয়েছে।'));
        }}>
          {t('Disconnect sync','সিঙ্ক বন্ধ করুন')}
        </button>
      </div>
    </div>
  ):(
    <button type="button" className="button button-light" onClick={async()=>{
      const picked=await pickFolderForSync();
      if(picked){
        if(picked.handle)registerWebDirectoryHandle(dialog.folder.id,picked.handle);
        const updatedFolder:Folder={...dialog.folder,syncSource:picked.source};
        await setCatalog(prev=>({
          ...prev,
          folders:prev.folders.map(f=>f.id===dialog.folder.id?updatedFolder:f)
        }));
        closeDialog();
        notify(t(`Connected to "${picked.source.pathName}". Starting initial sync…`,`"${picked.source.pathName}" ফোল্ডারের সাথে যুক্ত হয়েছে। সিঙ্ক শুরু হচ্ছে…`));
        void runFolderSync(updatedFolder);
      }
    }}>
      <Smartphone size={15}/>{t('Connect phone / local folder','মোবাইল / লোকাল ফোল্ডার যুক্ত করুন')}
    </button>
  )}
</div>}{dialog.type==='folder'&&<div className="folder-delete"><p>{t('Removing a folder also removes its subfolders. What should happen to their files?','ফোল্ডার সরালে ভেতরের ফোল্ডারও সরবে। ফাইলগুলো কী করবেন?')}</p><button type="button" onClick={()=>deleteFolder(dialog.folder,false)}>{t('Remove folder & move files to My drive','ফোল্ডার সরিয়ে ফাইল আমার ড্রাইভে রাখুন')}</button><button type="button" className="danger-text" onClick={()=>deleteFolder(dialog.folder,true)}>{t('Remove folder & move files to trash','ফোল্ডার সরিয়ে ফাইল ট্র্যাশে রাখুন')}</button></div>}</form>}
      {dialog.type==='remove'&&<><div className="warning-icon"><Trash2 size={28}/></div><p className="modal-description">{serverMode?t(`Remove ${dialog.ids.length} file(s) from your app catalog. Their Telegram messages will remain untouched. A catalog tombstone prevents recovery scans from immediately importing them again.`,`${dialog.ids.length}টি ফাইল অ্যাপের ক্যাটালগ থেকে সরবে। টেলিগ্রামের মেসেজ অপরিবর্তিত থাকবে। রিকভারি স্ক্যান এগুলো সাথে সাথে আবার আমদানি করবে না।`):t(`This permanently removes ${dialog.ids.length} file(s) and their locally saved originals from this demo browser. No Telegram messages will be deleted.`,`এটি ডেমো ব্রাউজার থেকে ${dialog.ids.length}টি ফাইল ও মূল কপি স্থায়ীভাবে সরাবে। টেলিগ্রামের কোনো মেসেজ মুছবে না।`)}</p>{formError&&<p className="form-error">{formError}</p>}<div className="modal-actions"><button className="button button-light" onClick={closeDialog}>{t('Keep files','ফাইল রাখুন')}</button><button className="button danger-button" onClick={()=>removeFiles(dialog.ids)}>{t('Remove from app','অ্যাপ থেকে সরান')}</button></div></>}
      {dialog.type==='connect'&&<ConnectPanel gateway={gateway} serverMode={serverMode} locale={locale} onConnected={async()=>{
        if(serverMode){await refreshServer();}
        else{
          const me=await telegramGateway.me();
          setAccount(me);
          let cat=await telegramGateway.loadCatalog();
          if(!cat||cat.files.length===0){
            cat=await telegramGateway.restoreCatalogFromTelegram()||await telegramGateway.scanAndRecoverSavedMessages()||cat;
          }
          updateCatalogState(cat);
          readyRef.current=true;
          setReady(true);
          if(cat)void saveCatalog(cat);
        }
        closeDialog();
        notify(t('Telegram connected. Your drive is ready.','টেলিগ্রাম যুক্ত হয়েছে। আপনার ড্রাইভ প্রস্তুত।'));
      }}/>}
      {dialog.type==='settings'&&<div className="settings-content">
        <div className="settings-profile"><div className="avatar">N</div><div><h3>{t('Personal workspace','ব্যক্তিগত ওয়ার্কস্পেস')}</h3><span>{account?.telegram_connected?`${account.name} · ${t('Telegram connected','টেলিগ্রাম যুক্ত আছে')}`:(serverMode?t('Server storage · Connect Telegram to continue','সার্ভার স্টোরেজ · টেলিগ্রাম যুক্ত করুন'):t('Zero-cost browser mode · Connect Telegram to store files','জিরো-কস্ট ব্রাউজার মোড · টেলিগ্রাম যুক্ত করুন'))}</span></div><span className="demo-badge">{account?.telegram_connected?'TELEGRAM':serverMode?'SERVER':'LOCAL'}</span></div>
        <div className="setting-group"><h3><HardDrive size={17}/>{t('Your storage','আপনার স্টোরেজ')}</h3><div className="setting-row"><div><strong>{account?.telegram_connected?t('Originals in your Telegram Saved Messages','টেলিগ্রাম সেভড মেসেজে মূল ফাইল'):t('Stored in this browser','এই ব্রাউজারে সেভ করা')}</strong><p>{activeFiles.length} {t('files','ফাইল')} · {formatBytes(totalBytes)} {t('in your catalog','ক্যাটালগে')}</p></div><button className="button button-light" onClick={()=>openDialog({type:'connect'})}><Send size={15}/>{account?.telegram_connected?t('Storage connection','স্টোরেজ সংযোগ'):t('Connect Telegram','টেলিগ্রাম যুক্ত করুন')}</button></div><p className="setting-hint">{account?.telegram_connected?t('Files are stored as uncompressed documents directly in your Telegram Saved Messages. Zero servers involved.','ফাইলগুলো কোনো মধ্যবর্তী সার্ভার ছাড়াই সরাসরি আপনার টেলিগ্রাম সেভড মেসেজে সংরক্ষিত হচ্ছে।'):t('Demo originals stay on this device. Connect Telegram above to save files directly to your Telegram cloud.','ডেমোর মূল ফাইল এই ডিভাইসে থাকে। টেলিগ্রামে সরাসরি সংরক্ষণ করতে উপরে টেলিগ্রাম যুক্ত করুন।')}</p>
          {serverMode&&account&&<div className="settings-button-row"><button className="button button-light" onClick={()=>refreshServer().then(()=>notify(t('Catalog refreshed.','ক্যাটালগ আপডেট হয়েছে।'))).catch(error=>notify(explainError(error)))}><Archive size={15}/>{t('Refresh catalog','ক্যাটালগ আপডেট')}</button><button className="button button-light" onClick={()=>openDialog({type:'recovery'})}><Search size={15}/>{t('Recover from Telegram','টেলিগ্রাম থেকে রিকভার')}</button></div>}
          {!serverMode&&account?.telegram_connected&&<div className="settings-button-row"><button className="button button-light" onClick={async()=>{
            try{
              notify(t('Syncing files from Telegram…','টেলিগ্রাম থেকে ফাইল সিঙ্ক হচ্ছে…'));
              const cat=await telegramGateway.restoreCatalogFromTelegram()||await telegramGateway.scanAndRecoverSavedMessages();
              if(cat&&cat.files.length>0){
                updateCatalogState(cat);
                void saveCatalog(cat);
                notify(t(`Synced ${cat.files.length} file(s) from Telegram.`,`টেলিগ্রাম থেকে ${cat.files.length}টি ফাইল সিঙ্ক হয়েছে।`));
              }else{
                notify(t('Catalog is up to date.','ক্যাটালগ আপ টু ডেট আছে।'));
              }
            }catch(e){
              notify(explainError(e));
            }
          }}><Archive size={15}/>{t('Sync with Telegram','টেলিগ্রাম সিঙ্ক')}</button></div>}
        </div>
        <div className="setting-group"><h3><Languages size={17}/>{t('Language','ভাষা')}</h3><div className="language-options"><button className={locale==='en'?'chosen':''} onClick={()=>{setLocale('en');localStorage.setItem('cloudnest-locale','en');document.documentElement.lang='en';}}>English{locale==='en'&&<Check size={16}/>}</button><button className={locale==='bn'?'chosen':''} onClick={()=>{setLocale('bn');localStorage.setItem('cloudnest-locale','bn');document.documentElement.lang='bn';}}>বাংলা{locale==='bn'&&<Check size={16}/>}</button></div></div>
        <div className="setting-group"><h3><Archive size={17}/>{t('Take your catalog with you','আপনার ক্যাটালগ সাথে রাখুন')}</h3><p className="setting-hint">{t('Export folders, filenames, tags and metadata as JSON. This does not include original file bytes. Keep this export to preserve your virtual organization.','ফোল্ডার, নাম, ট্যাগ এবং মেটাডেটা JSON হিসেবে রপ্তানি করুন। এতে মূল ফাইল থাকে না। ভার্চুয়াল ফোল্ডার ও ট্যাগ সংরক্ষণ করতে এটি রাখুন।')}</p><div className="settings-button-row"><button className="button button-light" onClick={exportCatalog}><Download size={16}/>{t('Export catalog','ক্যাটালগ রপ্তানি')}</button>{!serverMode&&<button className="button button-light" onClick={()=>importInput.current?.click()}><Upload size={16}/>{t('Import catalog','ক্যাটালগ আমদানি')}</button>}</div></div>
        <div className="setting-group"><h3><ShieldCheck size={17}/>{t('Sessions & privacy','সেশন ও গোপনীয়তা')}</h3><p className="setting-hint">{account?.telegram_connected?t('Connected directly from this browser via WebSockets. Disconnecting removes your session from this browser.','ব্রাউজার থেকে সরাসরি টেলিগ্রাম সার্ভারে যুক্ত। ডিসকানেক্ট করলে এই ব্রাউজার থেকে সেশন মুছে যাবে।'):t('No Telegram session is connected yet. Connect your account to use Telegram cloud storage.','এখনো কোনো টেলিগ্রাম সেশন যুক্ত নেই।')}</p>
          {account&&<div className="settings-button-row">{serverMode&&<button className="button button-light" onClick={signOut}>{t('Sign out this device','এই ডিভাইস থেকে সাইন আউট')}</button>}<button className="button button-light danger-text" onClick={()=>openDialog({type:'disconnect'})}>{t('Disconnect Telegram session','টেলিগ্রাম সেশন বিচ্ছিন্ন')}</button></div>}
          <button className="text-button" onClick={()=>openDialog({type:'security'})}>{t('How storage & sessions work','স্টোরেজ ও সেশন যেভাবে কাজ করে')}<ArrowRight size={14}/></button>
        </div>
      </div>}
      {dialog.type==='recovery'&&<><div className="disclosure"><Archive size={24}/><div><strong>{t('Scan Saved Messages only','শুধু Saved Messages স্ক্যান করুন')}</strong><p>{t('Index original attachments in Saved Messages for this linked Telegram account. Existing catalog references and removed-file tombstones are respected. This does not read unrelated chats.','যুক্ত টেলিগ্রাম অ্যাকাউন্টের Saved Messages-এর মূল ফাইল ইনডেক্স করুন। বিদ্যমান রেফারেন্স ও সরানো ফাইলের রেকর্ড মানা হবে। অন্য চ্যাট পড়া হবে না।')}</p></div></div><p className="modal-description">{t('Telegram history can recover original file references. Your virtual folders and tags require a metadata export or database backup. Flood-wait pauses the scan until Telegram permits it.','টেলিগ্রামের ইতিহাস থেকে মূল ফাইলের রেফারেন্স রিকভার করা যায়। ভার্চুয়াল ফোল্ডার ও ট্যাগের জন্য মেটাডেটা রপ্তানি বা ডাটাবেস ব্যাকআপ দরকার। টেলিগ্রাম অপেক্ষা করতে বললে স্ক্যান থামবে।')}</p><div className="modal-actions"><button className="button button-light" onClick={closeDialog}>{t('Cancel','বাতিল')}</button><button className="button primary" onClick={()=>gateway.beginSync().then(job=>{setSyncJob(job);closeDialog();notify(t('Recovery scan started. Progress is visible in your drive.','রিকভারি স্ক্যান শুরু হয়েছে। ড্রাইভে অগ্রগতি দেখুন।'));}).catch(error=>setFormError(explainError(error)))}>{t('Scan selected storage','নির্বাচিত স্টোরেজ স্ক্যান')}</button></div>{formError&&<p className="form-error" role="alert">{formError}</p>}</>}
      {dialog.type==='disconnect'&&<><div className="warning-icon"><ShieldCheck size={28}/></div><p className="modal-description">{t('Disconnect the server’s Telegram session? New transfers will stop. Existing Telegram messages stay intact. If Telegram is unavailable, revocation remains pending until it can be verified.','সার্ভারের টেলিগ্রাম সেশন বিচ্ছিন্ন করবেন? নতুন ট্রান্সফার বন্ধ হবে। টেলিগ্রামের মেসেজ অপরিবর্তিত থাকবে। টেলিগ্রাম বন্ধ থাকলে সেশন বাতিল যাচাই করা পর্যন্ত অপেক্ষায় থাকবে।')}</p><div className="modal-actions"><button className="button button-light" onClick={closeDialog}>{t('Keep connected','সংযোগ রাখুন')}</button><button className="button danger-button" onClick={disconnect}>{t('Disconnect session','সেশন বিচ্ছিন্ন করুন')}</button></div></>}
      {(dialog.type==='security'||dialog.type==='help')&&<div className="help-content">{dialog.type==='help'?<><div className="help-step"><span>01</span><div><h3>{t('Start with a little exploring','একটু ঘুরে দেখুন')}</h3><p>{serverMode?t('Connect your own Telegram account, then explicitly choose Saved Messages as your storage destination. Only selected storage is indexed.','নিজের টেলিগ্রাম অ্যাকাউন্ট যুক্ত করে Saved Messages-কে স্টোরেজ হিসেবে বেছে নিন। শুধু নির্বাচিত স্টোরেজ ইনডেক্স হবে।'):t('These are sample files in a local demo workspace. Open a file, star a favorite, or create a folder. Every sample has an original to download.','এগুলো স্থানীয় ডেমোর নমুনা ফাইল। ফাইল খুলুন, পছন্দে রাখুন বা ফোল্ডার তৈরি করুন। প্রতিটি নমুনা ডাউনলোড করা যায়।')}</p></div></div><div className="help-step"><span>02</span><div><h3>{t('Bring something of your own','আপনার ফাইল যোগ করুন')}</h3><p>{serverMode?t('Choose originals up to 500 MiB. Transfers resume from verified server offsets after you reselect the exact original. Staging completion does not mean Telegram confirmed the upload.','সর্বোচ্চ ৫০০ MiB মূল ফাইল বেছে নিন। একই মূল ফাইল আবার বেছে নিলে যাচাই করা সার্ভার অবস্থান থেকে আপলোড চলবে। সার্ভারে গ্রহণ মানে টেলিগ্রামে নিশ্চিত হওয়া নয়।'):t('Drag files into your drive or use Upload files. Original bytes are kept in this browser using IndexedDB, up to the available device quota. Maximum 500 MiB per file.','ফাইল টেনে আনুন বা আপলোড করুন। মূল ফাইল ব্রাউজারের IndexedDB-তে ডিভাইসের সীমার মধ্যে থাকে। প্রতিটি সর্বোচ্চ ৫০০ MiB।')}</p></div></div><div className="help-step"><span>03</span><div><h3>{t('Keep it beautifully organized','সুন্দরভাবে গুছিয়ে রাখুন')}</h3><p>{t('Rename, move, tag and search. Trash is reversible. Export a copy of your catalog from Settings. Camera backup is planned for native mobile apps.','নাম বদলান, সরান, ট্যাগ দিন এবং খুঁজুন। ট্র্যাশ থেকে ফেরানো যায়। সেটিংসে ক্যাটালগ রপ্তানি করুন। ক্যামেরা ব্যাকআপ ভবিষ্যতের নেটিভ অ্যাপের জন্য।')}</p></div></div></>:<><div className="disclosure"><ShieldCheck size={24}/><div><strong>{t('Clear by design','সবকিছু পরিষ্কারভাবে')}</strong><p>{serverMode?t('This deployment uses authenticated server storage. Files are confirmed only after Telegram returns a valid original attachment reference.','এই বিল্ড যাচাই করা সার্ভার স্টোরেজ ব্যবহার করে। টেলিগ্রাম মূল ফাইলের বৈধ রেফারেন্স দেওয়ার পরেই ফাইল নিশ্চিত হয়।'):t('This build is a local demo, not a connected cloud backup. No sample or uploaded file has been sent to Telegram.','এই বিল্ড স্থানীয় ডেমো, সংযুক্ত ক্লাউড ব্যাকআপ নয়। কোনো ফাইল টেলিগ্রামে পাঠানো হয়নি।')}</p></div></div><h3>{t('When Telegram is connected','টেলিগ্রাম যুক্ত হলে')}</h3><p>{t('The intended web service uses a server-side TDLib session. The server can technically access more than the selected storage chats. Our app allowlist does not change Telegram’s session permission scope.','পরিকল্পিত ওয়েব সেবা সার্ভারের TDLib সেশন ব্যবহার করে। সার্ভার নির্বাচিত চ্যাটের বাইরেও প্রযুক্তিগতভাবে অ্যাক্সেস পায়। অ্যাপের তালিকা টেলিগ্রামের সেশনের পরিধি বদলায় না।')}</p><h3>{t('Your originals, independently accessible','মূল ফাইলে স্বাধীন অ্যাক্সেস')}</h3><p>{t('Ordinary uploaded originals should remain accessible in your own Telegram storage chat. Virtual folders and tags live in the app catalog and need a metadata backup. Telegram cloud messages are not Secret Chats or end-to-end encrypted storage.','সাধারণ মূল ফাইল নিজের টেলিগ্রাম স্টোরেজ চ্যাটে থাকবে। ভার্চুয়াল ফোল্ডার ও ট্যাগ অ্যাপের ক্যাটালগে থাকে এবং মেটাডেটার ব্যাকআপ দরকার। ক্লাউড মেসেজ সিক্রেট চ্যাট বা এন্ড-টু-এন্ড এনক্রিপ্টেড স্টোরেজ নয়।')}</p><h3>{t('Trash is an app action','ট্র্যাশ অ্যাপের কাজ')}</h3><p>{t('Moving a file to trash does not delete a Telegram message. Remote deletion must always be a separate, explicit action. Public sharing and native background photo backup are outside this web MVP.','ট্র্যাশে সরালে টেলিগ্রামের মেসেজ মোছে না। রিমোট ডিলিট সবসময় আলাদা স্পষ্ট কাজ হবে। পাবলিক শেয়ারিং এবং পটভূমিতে ছবির ব্যাকআপ এই ওয়েব MVP-র বাইরে।')}</p></>}<button className="button primary full-width" onClick={closeDialog}>{t('Got it, make some space','বুঝেছি, শুরু করা যাক')}<ArrowRight size={16}/></button></div>}
    </Modal>}
    {duplicatePrompt&&<Modal title={t('You already have this original','এই মূল ফাইলটি আপনার কাছে আছে')} onClose={()=>{duplicateDecision.current?.('cancel');duplicateDecision.current=null;setDuplicatePrompt(null);}}><p className="modal-description">{t(`“${duplicatePrompt.name}” has the same verified SHA-256 and byte count as “${duplicatePrompt.existing.name}” in this browser. Keep another original copy or organize the existing bytes in this location.`,`এই ব্রাউজারে “${duplicatePrompt.name}” এবং “${duplicatePrompt.existing.name}”-এর যাচাই করা SHA-256 ও বাইট সংখ্যা এক। আরেকটি মূল কপি রাখুন অথবা একই বাইট এই ফোল্ডারে গুছিয়ে রাখুন।`)}</p><div className="duplicate-options"><button className="button button-light" onClick={()=>{duplicateDecision.current?.('keep');duplicateDecision.current=null;setDuplicatePrompt(null);}}>{t('Keep another copy','আরেকটি কপি রাখুন')}</button><button className="button primary" disabled={!duplicatePrompt.reuseAvailable} onClick={()=>{duplicateDecision.current?.('reuse');duplicateDecision.current=null;setDuplicatePrompt(null);}}>{t('Reuse existing original','বিদ্যমান মূল ফাইল ব্যবহার করুন')}</button></div>{!duplicatePrompt.reuseAvailable&&<p className="fine-print">{t('The previous original is missing from this browser. Keep another copy to save these bytes.','আগের মূল ফাইল এই ব্রাউজারে নেই। বাইট সেভ করতে আরেকটি কপি রাখুন।')}</p>}<button className="text-button auth-start-over" onClick={()=>{duplicateDecision.current?.('cancel');duplicateDecision.current=null;setDuplicatePrompt(null);}}>{t('Cancel this upload','এই আপলোড বাতিল')}</button></Modal>}
    {importCandidate&&<Modal title={t('Restore your organization?','ফোল্ডার ও ট্যাগ ফিরিয়ে আনবেন?')} onClose={()=>setImportCandidate(null)}><p className="modal-description">{t(`Import ${importCandidate.folders.length} folders and ${importCandidate.files.length} file records? This replaces the demo catalog metadata. Existing original bytes are kept; the export itself does not contain them. Files imported from another browser may be unavailable.`,`${importCandidate.folders.length}টি ফোল্ডার ও ${importCandidate.files.length}টি ফাইল রেকর্ড আমদানি করবেন? এটি ডেমো ক্যাটালগের মেটাডেটা প্রতিস্থাপন করবে। বিদ্যমান মূল ফাইল থাকবে, রপ্তানিতে মূল ফাইল নেই। অন্য ব্রাউজারের ফাইল অনুপস্থিত থাকতে পারে।`)}</p>{importError&&<p className="form-error" role="alert">{importError}</p>}<div className="modal-actions"><button className="button button-light" onClick={()=>setImportCandidate(null)}>{t('Cancel','বাতিল')}</button><button className="button primary" onClick={restoreImport}>{t('Import metadata','মেটাডেটা আমদানি')}</button></div></Modal>}
    {preview&&<Modal title={preview.name} onClose={()=>setPreview(null)} wide><div className="viewer"><div className="viewer-media">{previewError?<div className="preview-fallback"><Info size={34}/><p>{previewError}</p></div>:!previewUrl?<div className="preview-loading-card"><LoaderCircle size={32} className="spin"/><strong>{t('Loading preview from Telegram…','টেলিগ্রাম থেকে প্রিভিউ লোড হচ্ছে…')}</strong>{previewProgress!==null&&<><div className="preview-progress-track"><div className="preview-progress-fill" style={{width:`${previewProgress}%`}}/></div><p>{previewBytes?`${formatBytes(previewBytes.current)} / ${formatBytes(previewBytes.total)} (${previewProgress}%)`:`${previewProgress}%`}</p></>}{!previewProgress&&<p>{preview.name} · {formatBytes(preview.bytes)}</p>}</div>:safePreview(preview)==='image'?<img src={previewUrl} alt={preview.name}/>:safePreview(preview)==='video'?(
  <div className="video-player-box" style={{width:'100%',display:'flex',justifyContent:'center',alignItems:'center',background:'#000',borderRadius:'8px',overflow:'hidden',minHeight:'220px'}}>
    <video
      key={previewUrl}
      src={previewUrl}
      controls
      playsInline
      autoPlay
      style={{maxWidth:'100%',maxHeight:'65vh',display:'block',margin:'auto'}}
      onError={()=>{
        setPreviewError(t('This video codec cannot be played directly in this browser. Download the original to open it locally.','এই ভিডিও কোডেকটি ব্রাউজারে সরাসরি চালানো যাচ্ছে না। মূল ফাইলটি ডাউনলোড করে খুলুন।'));
      }}
    />
  </div>
):safePreview(preview)==='audio'?<div className="audio-preview"><Music2 size={55}/><audio src={previewUrl} controls onError={()=>setPreviewError(t('This audio format cannot be played here. Download the original.','এই অডিও ফরম্যাট এখানে চলবে না। মূল ফাইল ডাউনলোড করুন।'))}/></div>:safePreview(preview)==='pdf'?<iframe src={previewUrl} title={preview.name} sandbox="" referrerPolicy="no-referrer"/>:<div className="preview-fallback"><TypeIcon kind={preview.kind} size={48}/><h3>{t('Some things are best opened at home.','কিছু ফাইল নিজের অ্যাপে খোলাই ভালো।')}</h3><p>{t('A safe preview isn’t available for this format. Download the original to open it with your favorite app.','এই ফরম্যাটের নিরাপদ প্রিভিউ নেই। মূল ফাইল ডাউনলোড করে উপযুক্ত অ্যাপে খুলুন।')}</p></div>}</div><div className="viewer-actions"><button className="button primary" onClick={()=>download(preview)}><Download size={16}/>{t('Download original','মূল ফাইল ডাউনলোড')}</button><button className={`button button-light ${preview.favorite?'favorited':''}`} onClick={()=>favorite(preview)}><Star size={16} fill={preview.favorite?'currentColor':'none'}/>{preview.favorite?t('Favorited','পছন্দে আছে'):t('Favorite','পছন্দে রাখুন')}</button></div><dl className="file-details"><div><dt>{t('Original filename','মূল ফাইলের নাম')}</dt><dd>{preview.originalName}</dd></div><div><dt>{t('Size','আকার')}</dt><dd>{formatBytes(preview.bytes)} <span>({preview.bytes.toLocaleString()} bytes)</span></dd></div><div><dt>{t('Added','যোগ হয়েছে')}</dt><dd>{formatDate(preview.createdAt)}</dd></div><div><dt>{t('Location','অবস্থান')}</dt><dd>{catalog.folders.find(folder=>folder.id===preview.folderId)?.name||t('My drive','আমার ড্রাইভ')}</dd></div><div><dt>{t('Source','উৎস')}</dt><dd>{preview.source==='server'?t('Your Telegram storage','আপনার টেলিগ্রাম স্টোরেজ'):preview.asset?t('Bundled demo sample','ডেমোর নমুনা'):t('This browser · not Telegram','এই ব্রাউজার · টেলিগ্রাম নয়')}</dd></div><div><dt>{t('File type','ফাইলের ধরন')}</dt><dd>{preview.mime}</dd></div>{preview.sha256&&<div className="hash-detail"><dt>SHA-256</dt><dd>{preview.sha256}</dd></div>}</dl><div className="tags-section"><label htmlFor="tag-input"><Tag size={15}/>{t('Tags','ট্যাগ')}</label><div className="tag-list">{preview.tags.map(tag=><button key={tag} onClick={()=>{const next=preview.tags.filter(item=>item!==tag);updateTags(preview,next);}}>{tag}<X size={12}/></button>)}<input id="tag-input" value={tagValue} onChange={event=>setTagValue(event.target.value)} placeholder={t('Add a tag + Enter','ট্যাগ লিখে Enter দিন')} maxLength={40} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();const tag=tagValue.trim();if(tag&&!preview.tags.includes(tag)){const next=[...preview.tags,tag];updateTags(preview,next);}setTagValue('');}}}/></div></div></div></Modal>}
  </div>;
}

function Empty({icon,title,text,action,onAction}: {icon:React.ReactNode;title:string;text:string;action:string;onAction:()=>void}) {return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{text}</p><button className="button button-light" onClick={onAction}>{action}<ArrowRight size={15}/></button></div>;}
function extractVideoFrame(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    try {
      if (typeof window === 'undefined' || typeof document === 'undefined') {
        resolve('');
        return;
      }
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      const objectUrl = URL.createObjectURL(blob);
      video.src = objectUrl;

      let timer: NodeJS.Timeout | null = null;
      let finished = false;

      const finish = (result: string) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        URL.revokeObjectURL(objectUrl);
        video.src = '';
        video.load();
        resolve(result);
      };

      timer = setTimeout(() => finish(''), 6000);

      video.onloadedmetadata = () => {
        const dur = video.duration;
        const target = dur && !isNaN(dur) ? Math.min(2, Math.max(0.1, dur * 0.15)) : 0.5;
        video.currentTime = target;
      };

      video.onseeked = () => {
        try {
          const width = video.videoWidth || 360;
          const height = video.videoHeight || 200;
          const targetWidth = Math.min(380, width);
          const targetHeight = Math.max(1, Math.round((height / width) * targetWidth));
          const canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            finish(dataUrl);
            return;
          }
        } catch {
          // ignore
        }
        finish('');
      };

      video.onerror = () => finish('');
    } catch {
      resolve('');
    }
  });
}

function LocalThumbnail({file}:{file:DriveFile}) {
  const isVideo = file.kind === 'video';
  const [url,setUrl]=useState(()=>isVideo?(videoFrameCache.get(file.id)||''):(thumbnailCache.get(file.id)||''));
  const [loading,setLoading]=useState(()=>isVideo?!videoFrameCache.has(file.id):!thumbnailCache.has(file.id));
  useEffect(()=>{
    let disposed=false;
    const cachedFrame = isVideo ? videoFrameCache.get(file.id) : thumbnailCache.get(file.id);
    if(cachedFrame){
      setUrl(cachedFrame);
      setLoading(false);
      return;
    }
    (async()=>{
      try {
        setLoading(true);
        if(file.asset){
          if(isVideo){
            mediaBlobUrlCache.set(file.id, file.asset);
            const resp=await fetch(file.asset);
            const blob=await resp.blob();
            const frame=await extractVideoFrame(blob);
            if(frame&&!disposed){
              videoFrameCache.set(file.id,frame);
              setUrl(frame);
              setLoading(false);
              return;
            }
          }
          if(!disposed){
            if(isVideo) videoFrameCache.set(file.id, file.asset);
            else thumbnailCache.set(file.id, file.asset);
            setUrl(file.asset);
            setLoading(false);
            return;
          }
        }
        const cached = await getOriginal(file.originalId || file.id);
        if(cached && !disposed){
          const localUrl = URL.createObjectURL(cached);
          if(isVideo){
            mediaBlobUrlCache.set(file.id, localUrl);
            const frameUrl=await extractVideoFrame(cached);
            if(frameUrl&&!disposed){
              videoFrameCache.set(file.id,frameUrl);
              setUrl(frameUrl);
              setLoading(false);
              return;
            }
          }else{
            thumbnailCache.set(file.id, localUrl);
            setUrl(localUrl);
            setLoading(false);
            return;
          }
        }
        if(file.remoteMessageId){
          const blob = await telegramGateway.downloadFile(file.remoteMessageId);
          if(blob && !disposed){
            void saveOriginal(file.id, blob);
            const localUrl = URL.createObjectURL(blob);
            if(isVideo){
              mediaBlobUrlCache.set(file.id, localUrl);
              const frameUrl=await extractVideoFrame(blob);
              if(frameUrl&&!disposed){
                videoFrameCache.set(file.id,frameUrl);
                setUrl(frameUrl);
                setLoading(false);
                return;
              }
            }else{
              thumbnailCache.set(file.id, localUrl);
              setUrl(localUrl);
              setLoading(false);
            }
          }
        }
      } catch (e) {
        console.warn('Could not load thumbnail for', file.name, e);
      } finally {
        if(!disposed) setLoading(false);
      }
    })();
    return()=>{disposed=true;};
  },[file.id,file.originalId,file.remoteMessageId,file.name,file.kind,file.asset,isVideo]);

  if (url) {
    return (
      <div className="thumb-media-wrapper">
        <img src={url} alt={file.name} loading="lazy" onError={()=>setUrl('')}/>
        {file.kind==='video'&&<span className="play-badge"><Play size={20} fill="currentColor"/></span>}
        {file.kind==='video'&&<span className="video-tag-pill"><Film size={10}/><span>{file.name.split('.').pop()?.toUpperCase()||'VIDEO'}</span></span>}
      </div>
    );
  }
  if (loading) {
    return (
      <div className="local-image-placeholder video-placeholder">
        <LoaderCircle size={22} className="spin" style={{opacity: 0.5}}/>
        {file.kind==='video'&&<span className="play-badge" style={{opacity: 0.6}}><Play size={18} fill="currentColor"/></span>}
        {file.kind==='video'&&<span className="video-tag-pill"><Film size={10}/><span>{file.name.split('.').pop()?.toUpperCase()||'VIDEO'}</span></span>}
      </div>
    );
  }
  return (
    <div className="local-image-placeholder">
      {file.kind==='video'?<Film size={38}/>:<FileImage size={40}/>}
      {file.kind==='video'&&<span className="play-badge"><Play size={20} fill="currentColor"/></span>}
      {file.kind==='video'&&<span className="video-tag-pill"><Film size={10}/><span>{file.name.split('.').pop()?.toUpperCase()||'VIDEO'}</span></span>}
    </div>
  );
}
