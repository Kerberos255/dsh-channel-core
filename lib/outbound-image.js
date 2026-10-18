import {openSync,readSync,closeSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const LIMIT=10*1024*1024;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const isImage=(b)=>{
 const png=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpg=b[0]===0xff&&b[1]===0xd8&&b[2]===0xff;
 const gif=b.toString('ascii',0,6)==='GIF87a'||b.toString('ascii',0,6)==='GIF89a';
 const webp=b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
 return png||jpg||gif||webp;
};
export function validateWorkspaceImage(imagePath,workspacePath){
 if(typeof imagePath!=='string'||!imagePath.trim()||imagePath.length>1024||typeof workspacePath!=='string'||!workspacePath.trim())
  fail('outbound-image-path-invalid');
 let root,file;
 try{root=realpathSync(workspacePath);file=realpathSync(path.resolve(workspacePath,imagePath));}
 catch{fail('outbound-image-not-found');}
 const canonicalRoot=path.normalize(root);
 const relative=path.relative(canonicalRoot,file);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))
  fail('outbound-image-outside-workspace');
 const ext=path.extname(file).toLowerCase();
 if(!['.png','.jpg','.jpeg','.gif','.webp'].includes(ext))fail('outbound-image-format-unsupported');
 const stat=statSync(file);
 if(!stat.isFile()||stat.size<12||stat.size>LIMIT)fail('outbound-image-size-invalid');
 let handle;
 try{handle=openSync(file,'r');const header=Buffer.alloc(16);readSync(handle,header,0,16,0);
  if(!isImage(header))fail('outbound-image-magic-invalid');
 }finally{if(handle!==undefined)closeSync(handle);}
 const sha256=createHash('sha256').update(readFileSync(file)).digest('hex');
 return {imagePath:file,workspacePath:canonicalRoot,imageDigest:sha256,imageBytes:stat.size};
}
export function verifyQueuedImage(body){
 const image=validateWorkspaceImage(body.imagePath,body.workspacePath);
 if(image.imageDigest!==body.imageDigest)fail('outbound-image-content-changed');
 return image.imagePath;
}
