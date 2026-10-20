import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile as cb} from 'node:child_process';
import {promisify} from 'node:util';
import {SOUTH_DUBLIN_INDEX,findSouthDublinDecisionDocuments,parseSouthDublinDecisions} from './council-weekly-southdublin.mjs';
const exec=promisify(cb);
const host='planning.southdublin.ie';
async function download(raw,pdf=false){
 const url=new URL(raw);
 if(url.protocol!=='https:'||url.hostname!==host)throw Error('Nonofficial South Dublin URL');
 const r=await fetch(url,{headers:{'User-Agent':'OpenList council weekly data audit'},signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('Council HTTP '+r.status);
 if(!pdf)return r.text();
 const b=Buffer.from(await r.arrayBuffer());
 if(b.length<500||b.length>20000000||b.subarray(0,5).toString()!=='%PDF-')throw Error('Invalid PDF response');
 return b;
}
const html=await download(SOUTH_DUBLIN_INDEX);
const documents=findSouthDublinDecisionDocuments(html).slice(0,3);
const reports=[];
for(const url of documents){
 const buf=await download(url,true);
 const dir=await mkdtemp(join(tmpdir(),'southdublin-pilot-'));
 try{
  const path=join(dir,'decisions.pdf');await writeFile(path,buf);
  const modes=[];
  for(const mode of ['-raw','-layout']){
    try{
      const {stdout}=await exec('pdftotext',[mode,'-enc','UTF-8',path,'-'],{timeout:30000,maxBuffer:20000000});
      const records=parseSouthDublinDecisions(stdout,url);
      const references=[...new Set([...stdout.matchAll(/\\bSDZ?\\d{2}[AB]\\/\\d{4}W?\\b/gi)].map(m=>m[0].replace(/W$/i,'')))];
      const missing=references.filter(ref=>!records.some(x=>x.reference.replace(/W$/,'')===ref));
      modes.push({mode,parsed:records.length,refused:records.filter(x=>x.decision_text==='Refused').length,
        hasRetentionRefusal:records.some(x=>x.reference==='SD26B/0392W'),
        missingRefs:missing.slice(0,20),sample:records.slice(0,5)});
    }catch(error){modes.push({mode,error:String(error.message||error).slice(0,150)})}
  }
  reports.push({url,modes});
 }finally{await rm(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({researchOnly:true,documents:reports.length,reports},null,2));
