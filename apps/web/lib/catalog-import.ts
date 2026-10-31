import { canMoveFolder, Catalog, DriveFile, Folder, kindFor, MAX_FILE_BYTES } from './catalog';
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('The catalog contains an invalid record.');return value as Record<string,unknown>;};
const text=(value:unknown,label:string,max=255):string=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw new Error(`The catalog contains an invalid ${label}.`);return value;};
const date=(value:unknown):string=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw new Error('The catalog contains an invalid date.');return new Date(value).toISOString();};
/** Organization only: imported metadata cannot prove that any original exists. */
export function parseCatalogImport(input:unknown,current:Catalog):Catalog {
 const raw=object(input);
 if(raw.schemaVersion!==1||!Array.isArray(raw.files)||!Array.isArray(raw.folders))throw new Error('Choose a valid schema version 1 catalog export.');
 if(raw.files.length>10000||raw.folders.length>1000)throw new Error('This catalog is too large for browser demo import.');
 const folderIds=new Set<string>();
 const folders:Folder[]=raw.folders.map((value,index)=>{const folder=object(value),id=text(folder.id,'folder ID',128);if(folderIds.has(id))throw new Error('The catalog contains duplicate folder IDs.');folderIds.add(id);return {id,name:text(folder.name,'folder name'),parentId:folder.parentId===null?null:text(folder.parentId,'parent ID',128),color:['green','blue','peach','purple'][index%4]};});
 const siblings=new Set<string>();
 for(const folder of folders){if(!canMoveFolder(folders,folder.id,folder.parentId))throw new Error('The catalog contains a folder cycle, a missing parent, or more than ten folder levels.');const key=`${folder.parentId||''}\0${folder.name.toLowerCase()}`;if(siblings.has(key))throw new Error('Two imported folders have the same name in one location.');siblings.add(key);}
 const ids=new Set<string>();
 const files:DriveFile[]=raw.files.map(value=>{
  const file=object(value),id=text(file.id,'file ID',128),name=text(file.name,'filename');if(ids.has(id))throw new Error('The catalog contains duplicate file IDs.');ids.add(id);
  if(!Number.isSafeInteger(file.bytes)||Number(file.bytes)<0||Number(file.bytes)>MAX_FILE_BYTES)throw new Error('The catalog contains an invalid file size.');
  const folderId=file.folderId===null?null:text(file.folderId,'folder ID',128);if(folderId&&!folderIds.has(folderId))throw new Error('A file refers to a missing folder.');
  const mime=text(file.mime,'file type',127);if(!/^[\w.+-]+\/[\w.+-]+$/.test(mime))throw new Error('The catalog contains an invalid file type.');
  const tags=Array.isArray(file.tags)?file.tags.map(tag=>text(tag,'tag',40)):[];if(tags.length>20)throw new Error('A file contains more than twenty tags.');
  const existing=current.files.find(item=>item.id===id);
  return {id,name,originalName:existing?.originalName||text(file.originalName||name,'original filename'),mime:existing?.mime||mime,bytes:existing?.bytes??Number(file.bytes),kind:kindFor(existing?.mime||mime,name),folderId,favorite:file.favorite===true,createdAt:date(file.createdAt),trashedAt:file.trashedAt===null?null:date(file.trashedAt),tags:[...new Set(tags)],source:'browser',asset:existing?.asset,originalId:existing?.originalId,sha256:existing?.sha256,availability:existing?.availability||(!existing?'missing':undefined)};
 });
 return {schemaVersion:1,files,folders,transfers:[]};
}
