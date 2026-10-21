import {writeFile,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile as callback} from "node:child_process";
import {promisify} from "node:util";
import {DLR_WEEKLY_INDEX,discoverDlrWeeks,parseDlrReceived} from "./council-weekly-dlr.mjs";
const exec=promisify(callback);
async function download(url,pdf=false){
 const u=new URL(url);
 if(u.protocol!=="https:"||u.hostname!=="www.dlrcoco.ie")throw Error("Untrusted DLR document URL");
 const r=await fetch(u,{signal:AbortSignal.timeout(30000),headers:{"User-Agent":"OpenList county council planning weekly register audit"}});
 if(!r.ok)throw Error("DLR source HTTP "+r.status);
 const b=Buffer.from(await r.arrayBuffer());
 if(pdf&&(b.length<500||b.length>20000000||b.subarray(0,5).toString()!=="%PDF-"))throw Error("Invalid official DLR PDF");
 return pdf?b:b.toString("utf8");
}
const html=await download(DLR_WEEKLY_INDEX);
const docs=discoverDlrWeeks(html);
const reports=[];
for(const doc of docs.slice(0,3)){
 const dir=await mkdtemp(join(tmpdir(),"dlr-weekly-"));
 try{
  const file=join(dir,"week.pdf");await writeFile(file,await download(doc.url,true));
  const {stdout}=await exec("pdftotext",["-raw",file,"-"],{timeout:30000,maxBuffer:24000000});
  const parsed=parseDlrReceived(stdout,doc.url);
  reports.push({week:doc.week,week_ending:doc.week_ending,url:doc.url,official:parsed.officialTotal,
   valid:parsed.applications.length,excluded:parsed.skipped,
   samples:parsed.applications.slice(0,12).map(x=>({ref:x.reference,date:x.registration_date,type:x.application_type}))});
 }finally{await rm(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({readOnly:true,documents:docs.length,reports},null,2));
