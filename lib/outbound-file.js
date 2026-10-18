import {inspectWorkspaceMedia} from './outbound-media.js';

// Feishu upload API defines 30 MB; use decimal bytes to stay under its hard cap.
const LIMIT=30_000_000;
const ALLOWED=[
 '.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx',
 '.txt','.md','.csv','.tsv','.json','.xml','.yaml','.yml','.log','.rtf',
 '.zip','.7z','.rar','.odt','.ods','.odp',
];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const starts=(header,signature)=>header.subarray(0,signature.length).equals(signature);
const ZIP=Buffer.from([0x50,0x4b,0x03,0x04]);
const OLE=Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
const SEVEN_Z=Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c]);
const RAR=Buffer.from([0x52,0x61,0x72,0x21,0x1a,0x07]);
const ZIP_EXT=new Set(['.zip','.docx','.xlsx','.pptx','.odt','.ods','.odp']);
const OLE_EXT=new Set(['.doc','.xls','.ppt']);
const TEXT_EXT=new Set(['.txt','.md','.csv','.tsv','.json','.xml','.yaml','.yml','.log']);
export function validateWorkspaceFile(filePath,workspacePath){
 const info=inspectWorkspaceMedia(filePath,workspacePath,{kind:'file',maxBytes:LIMIT,extensions:ALLOWED});
 if(
  (info.ext==='.pdf'&&!starts(info.header,Buffer.from('%PDF-')))||
  (ZIP_EXT.has(info.ext)&&!starts(info.header,ZIP))||
  (OLE_EXT.has(info.ext)&&!starts(info.header,OLE))||
  (info.ext==='.7z'&&!starts(info.header,SEVEN_Z))||
  (info.ext==='.rar'&&!starts(info.header,RAR))||
  (info.ext==='.rtf'&&!starts(info.header,Buffer.from('{\\rtf')))||
  (TEXT_EXT.has(info.ext)&&info.sample.includes(0))
 )fail('outbound-file-magic-invalid');
 return {
  filePath:info.path,workspacePath:info.workspacePath,
  fileDigest:info.digest,fileBytes:info.bytes,fileName:info.fileName,
 };
}
export function verifyQueuedFile(body){
 const file=validateWorkspaceFile(body.filePath,body.workspacePath);
 if(file.fileDigest!==body.fileDigest||file.fileName!==body.fileName)
  fail('outbound-file-content-changed');
 return {filePath:file.filePath,fileName:file.fileName};
}
