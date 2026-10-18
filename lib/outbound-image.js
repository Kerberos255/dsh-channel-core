import {inspectWorkspaceMedia} from './outbound-media.js';

const LIMIT=10*1024*1024;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const isImage=b=>{
 const png=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpg=b[0]===0xff&&b[1]===0xd8&&b[2]===0xff;
 const gif=b.toString('ascii',0,6)==='GIF87a'||b.toString('ascii',0,6)==='GIF89a';
 const webp=b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
 return png||jpg||gif||webp;
};
export function validateWorkspaceImage(imagePath,workspacePath){
 const info=inspectWorkspaceMedia(imagePath,workspacePath,{
  kind:'image',maxBytes:LIMIT,minBytes:12,extensions:['.png','.jpg','.jpeg','.gif','.webp'],
 });
 if(!isImage(info.header))fail('outbound-image-magic-invalid');
 return {imagePath:info.path,workspacePath:info.workspacePath,imageDigest:info.digest,imageBytes:info.bytes};
}
export function verifyQueuedImage(body){
 const image=validateWorkspaceImage(body.imagePath,body.workspacePath);
 if(image.imageDigest!==body.imageDigest)fail('outbound-image-content-changed');
 return image.imagePath;
}
