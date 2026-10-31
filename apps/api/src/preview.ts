/** Return only formats whose bytes can be handed to a constrained browser decoder. */
export function sniffPreview(bytes:Uint8Array):string|null {
  const data=Buffer.from(bytes);
  if(data.length>=8&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(data.length>=3&&data[0]===255&&data[1]===216&&data[2]===255)return 'image/jpeg';
  if(['GIF87a','GIF89a'].includes(data.subarray(0,6).toString('ascii')))return 'image/gif';
  if(data.subarray(0,4).toString('ascii')==='RIFF'&&data.subarray(8,12).toString('ascii')==='WEBP')return 'image/webp';
  if(data.subarray(0,5).toString('ascii')==='%PDF-')return 'application/pdf';
  if(data.subarray(0,4).toString('ascii')==='RIFF'&&data.subarray(8,12).toString('ascii')==='WAVE')return 'audio/wav';
  if(data.subarray(0,3).toString('ascii')==='ID3'||data.length>=2&&data[0]===255&&(data[1]&224)===224)return 'audio/mpeg';
  if(data.subarray(4,8).toString('ascii')==='ftyp'){
    const brand=data.subarray(8,12).toString('ascii');
    if(['avif','avis'].includes(brand))return 'image/avif';
    if(['M4A ','M4B '].includes(brand))return 'audio/mp4';
    if(['isom','iso2','mp41','mp42','avc1','M4V '].includes(brand))return 'video/mp4';
  }
  return null;
}
