#!/usr/bin/env node
// Read-only bounded preview of actual Orchestra metadata ledgers.
// No secrets, raw event bodies, run IDs or session content are printed.
import {openSync,readSync,fstatSync,closeSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {fromInvocation,fromObserver} from '../adapter/source-telemetry.mjs';

export const MAX_SCAN_BYTES=512*1024;
export const MAX_ROWS=2500;
export function readTail(file,limit=MAX_SCAN_BYTES){
  let fd;
  try{
    fd=openSync(file,'r');
    const stat=fstatSync(fd);
    const size=Number(stat.size);
    const start=Math.max(0,size-Math.min(Math.max(0,limit),MAX_SCAN_BYTES));
    const buffer=Buffer.alloc(Math.max(0,size-start));
    let read=0;
    while(read<buffer.length){
      const n=readSync(fd,buffer,read,buffer.length-read,start+read);
      if(n===0)break;
      read+=n;
    }
    let raw=buffer.subarray(0,read).toString('utf8');
    // Drop first partial record if tail scan starts in the middle of a line.
    if(start>0){const nl=raw.indexOf('\n');raw=nl<0?'':raw.slice(nl+1);}
    // Drop the last partial record until the producer completes its append.
    const last=raw.lastIndexOf('\n');raw=last<0?'':raw.slice(0,last);
    return {lines:raw.split('\n').filter(Boolean).slice(-MAX_ROWS), scannedBytes:read, totalBytes:size, truncated:start>0};
  }catch(error){
    if(error?.code==='ENOENT')return {lines:[],scannedBytes:0,totalBytes:0,truncated:false,missing:true};
    throw error;
  }finally{if(fd!==undefined)closeSync(fd);}
}
export function summarizeLedgers(usageFile,observerFile){
  const counts={usage:0,observer:0,unrecognized:0,unknownCost:0,byKind:{},byEngine:{}};
  const inputs=[['usage',usageFile,fromInvocation],['observer',observerFile,fromObserver]];
  const files={};
  for(const [category,file,map] of inputs){
    const source=readTail(file);
    files[category]={scannedBytes:source.scannedBytes,totalBytes:source.totalBytes,truncated:source.truncated,missing:!!source.missing};
    for(const line of source.lines){
      let event;
      try{event=map(JSON.parse(line));}catch{event=null;}
      if(!event){counts.unrecognized++;continue;}
      counts[category]++;
      counts.byKind[event.kind]=(counts.byKind[event.kind]||0)+1;
      if(event.engine)counts.byEngine[event.engine]=(counts.byEngine[event.engine]||0)+1;
      if(category==='usage' && event.costUsd===undefined)counts.unknownCost++;
    }
  }
  return {source:'bounded read-only local preview',limitBytesPerFile:MAX_SCAN_BYTES,maxRowsPerFile:MAX_ROWS,files,counts,
    caveat:'Sampled tail only. This does not verify event delivery, true cost, full-run success, or production deployment.'};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4){console.error('Usage: node scripts/source-telemetry-preview.mjs /path/to/runs/engine-usage.jsonl /path/to/runs/observer-events.jsonl');process.exit(2);}
  console.log(JSON.stringify(summarizeLedgers(process.argv[2],process.argv[3]),null,2));
}
