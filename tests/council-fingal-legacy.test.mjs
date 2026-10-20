import test from "node:test";
import assert from "node:assert/strict";
import {parseFingalLegacyText} from "../src/council-weekly-fingal.mjs";
const source="https://www.fingal.ie/system/files/planning-weekly-lists/2026%20Week%2038/decisions-made.doc";
function row(date,ref,status){
 return "\nApplicant reference and planning decision\n"+date+"\nPERMISSION\n"+ref+"\nThe applicant\n"+status+"\nA full description about a development\n";
}
test("Legacy Fingal date-first grant/refusal headers",()=>{
 const sample="FINGAL WEEKLY DECISION LIST\n"+
 row("14/09/2026","F26A/0486E","GRANT PERMISSION")+
 row("15/09/2026","FW26A/0296E","REFUSE PERMISSION")+
 row("15/09/2026","FW26A/0297E","INVALID APPLICATION")+
 row("16/09/2026","F26A/0654E","REQUEST ADDITIONAL INFORMATION")+
 row("17/09/2026","F26A/0655E","GRANT")+
 row("18/09/2026","F26A/0656E","REFUSE");
 const r=parseFingalLegacyText(sample,source);
 assert.deepEqual(r.decisions.map(x=>[x.reference,x.decision_text]),[
 ["F26A/0486E","Granted"],["FW26A/0296E","Refused"],["F26A/0655E","Granted"],["F26A/0656E","Refused"]]);
});
test("Refuse report with too few rows or no decision heading",()=>{
 assert.throws(()=>parseFingalLegacyText("Single isolated mention of GRANT",source));
});
