import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile as cb} from "node:child_process";
import {promisify} from "node:util";
import {FINGAL_INDEX,fingalWeeklyLinks,parseFingalLegacyText} from "./council-weekly-fingal.mjs";
const exec=promisify(cb);
async function source(url){
 const u=new URL(url);
 if(u.protocol!=="https:"||u.hostname!=="www.fingal.ie")throw Error("Unsafe council source");
 const r=await fetch(u,{signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error("Fingal HTTP "+r.status);
 return Buffer.from(await r.arrayBuffer());
}
const docs=fingalWeeklyLinks((await source(FINGAL_INDEX)).toString("utf8"));
const reports=[];
for(const week of [38,35,32]){
 const target=docs.find(x=>x.week===week);
 if(!target)throw Error("Fingal legacy week missing "+week);
 const bytes=await source(target.url);
 const dir=await mkdtemp(join(tmpdir(),"fingal-backfill-"));
 try{
  const file=join(dir,"weekly.doc");await writeFile(file,bytes);
  const {stdout}=await exec("antiword",["-w","0",file],{timeout:30000,maxBuffer:25000000});
  try{
   const result=parseFingalLegacyText(stdout,target.url);
   reports.push({week,datedRows:result.tableRows,decisions:result.decisions.length,
    excluded:result.excluded,refused:result.decisions.filter(x=>x.decision_text==="Refused").length,
    samples:result.decisions.slice(0,12).map(({reference,decision_date,decision_text})=>({reference,decision_date,decision_text}))});
  }catch(error){reports.push({week,error:String(error.message||error)})}
 }finally{await rm(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({readOnly:true,reports},null,2));
if(reports.every(x=>x.error))process.exitCode=1;
