// Read-only Fingal Aug/Sep Word weekly document compatibility probe.
// All freeform names/descriptions masked before logging.
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile as cb} from "node:child_process";
import {promisify} from "node:util";
import {fingalWeeklyLinks,FINGAL_INDEX,FINGAL_REFERENCE} from "./council-weekly-fingal.mjs";
const exec=promisify(cb);
async function get(url){
 const u=new URL(url);
 if(u.protocol!=="https:"||u.hostname!=="www.fingal.ie")throw Error("Not official council");
 const r=await fetch(url,{signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error("Fingal HTTP "+r.status);
 return Buffer.from(await r.arrayBuffer());
}
const archive=fingalWeeklyLinks((await get(FINGAL_INDEX)).toString("utf8"));
function mask(s){
 // Preserve status terms, date, reference strings and basic table delimiters
 // while removing all other words (including applicants and street names).
 return s.replace(/\b(?:[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]*)\b/g,w=>
  /^(?:GRANT|GRANTED|REFUSE|REFUSED|REFUSAL|PERMISSION|DECISION|INVALID|APPLICATION|ADDITIONAL|INFORMATION|REG|REF|RECEIVED|WITHDRAWN|FINAL|CONDITIONS|REQUEST|MADE|DATE|RETENTION|DECISIONS|REGISTRATION|SUBJECT|TO|OF|NOTIFIED|OUTLINE)$/i.test(w)?w.toUpperCase():"x");
}
const report=[];
for(const w of [38,35,32]){
 const doc=archive.find(d=>d.week===w);
 if(!doc)throw Error("Missing historic Fingal week "+w);
 const dir=await mkdtemp(join(tmpdir(),"fingal-legacy-"));
 try{
  const file=join(dir,"council.doc");
  await writeFile(file,await get(doc.url));
  const modes=[];
  for(const mode of ["-w","-w"]){
    const args=mode==="-w"&&modes.length===0?["-w","0",file]:["-w","200",file];
    const {stdout}=await exec("antiword",args,{timeout:30000,maxBuffer:20000000});
    const refs=[...new Set([...stdout.matchAll(/\b(?:FW?\d{2}[AB]\/\d{4}E?|LRD\d{4}\/S3E?)\b/gi)].map(m=>m[0].toUpperCase()))];
    const terms=[...stdout.matchAll(/\b(?:GRANT\s+PERMISSION|REFUSE\s+PERMISSION|INVALID\s+APPLICATION|REQUEST\s+ADDITIONAL\s+INFORMATION)\b/gi)].length;
    const lines=stdout.split("\n");
    const around=refs.slice(0,4).map(ref=>{
      const line=lines.findIndex(l=>l.includes(ref));
      return {reference:ref,context:mask(lines.slice(Math.max(0,line-2),line+5).join("\n")).slice(0,520)};
    });
    modes.push({width:args[1],chars:stdout.length,refs:refs.length,statusPhrases:terms,
      header:mask(stdout.slice(0,1100)).slice(0,1100),around});
  }
  report.push({week:w,url:doc.url,modes});
 }finally{await rm(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({readOnly:true,report},null,2));
