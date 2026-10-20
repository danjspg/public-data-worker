import test from "node:test";
import assert from "node:assert/strict";
import {fingalIsoDate,fingalWeeklyLinks,parseFingalWeeklyText} from "../src/council-weekly-fingal.mjs";
const official="https://www.fingal.ie/system/files/planning-weekly-lists/2026%20Week%2041/decisions-made_0.doc";
const header="FINGAL COUNTY COUNCIL WEEKLY DECISION LIST\nDate Decision Ref Information\n";
function row(ref,date,type,outcome){
 return "[file]\n"+ref+"\t"+date+"\t"+type+"\tApplicant Person\nAn address\n"+outcome+"\nFurther description mentioning permission\n";
}
test("only official weekly decision links from August onward",()=>{
 const html='<tr><td>Week 41</td><td><a href="/system/files/planning-weekly-lists/2026%20Week%2041/decisions-made_0.doc">Decisions</a></td></tr>'+
 '<tr><td>Week 31</td><td><a href="/system/files/planning-weekly-lists/2026%20Week%2031/decisions-made.doc">Old</a></td></tr>';
 const docs=fingalWeeklyLinks(html);
 assert.equal(docs.length,1);assert.equal(docs[0].url,official);
});
test("Fingal explicit grants and refusals, never invalidity or bare permission",()=>{
 const input=header+
 row("FW26A/0324E","08/10/2026","RETENTION","REFUSE PERMISSION for RETENTION")+
 row("FW26A/0323E","08/10/2026","PERMISSION","GRANT PERMISSION & GRANT RETENTION")+
 row("F26A/0884E","02/10/2026","PERMISSION","INVALID APPLICATION")+
 row("F26A/0811E","01/10/2026","PERMISSION","Description of PERMISSION requested")+
 row("F26A/0790E","02/10/2026","PERMISSION","GRANT PERMISSION")+
 row("FW26A/0367E","05/10/2026","PERMISSION","INVALID APPLICATION");
 const x=parseFingalWeeklyText(input,official);
 assert.deepEqual(x.decisions.map(y=>[y.reference,y.decision_date,y.decision_text]),[
 ["FW26A/0324E","2026-10-08","Refused"],
 ["FW26A/0323E","2026-10-08","Granted"],
 ["F26A/0790E","2026-10-02","Granted"]]);
 assert.equal(x.excluded,3);
});
test("Fingal date validation and unrecognised document fail closed",()=>{
 assert.equal(fingalIsoDate("31/02/2026"),null);
 assert.throws(()=>parseFingalWeeklyText("No decision headings",official));
});
