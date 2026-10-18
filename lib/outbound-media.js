import {realpathSync,statSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const fail=code=>{throw Object.assign(new Error(code),{code});};
/** Shared canonical-path and content-fingerprint gate for Session-bound outbound media. */
export function inspectWorkspaceMedia(requestedPath,workspacePath,{kind,maxBytes,extensions,minBytes=1}){
 if(typeof requestedPath!=='string'||!requestedPath.trim()||requestedPath.length>1024||
    typeof workspacePath!=='string'||!workspacePath.trim())fail('outbound-'+kind+'-path-invalid');
 let root,file;
 try{root=realpathSync(workspacePath);file=realpathSync(path.resolve(workspacePath,requestedPath));}
 catch{fail('outbound-'+kind+'-not-found');}
 const relative=path.relative(root,file);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))
  fail('outbound-'+kind+'-outside-workspace');
 const ext=path.extname(file).toLowerCase();
 if(!extensions.includes(ext))fail('outbound-'+kind+'-format-unsupported');
 let stat;
 try{stat=statSync(file);}catch{fail('outbound-'+kind+'-not-found');}
 if(!stat.isFile()||stat.size<minBytes||stat.size>maxBytes)fail('outbound-'+kind+'-size-invalid');
 let bytes;
 try{bytes=readFileSync(file);}catch{fail('outbound-'+kind+'-not-readable');}
 if(bytes.length!==stat.size)fail('outbound-'+kind+'-content-changed');
 return {
  path:file,workspacePath:root,fileName:path.basename(file),ext,bytes:stat.size,
  digest:createHash('sha256').update(bytes).digest('hex'),
  header:bytes.subarray(0,16),sample:bytes.subarray(0,4096),
 };
}
