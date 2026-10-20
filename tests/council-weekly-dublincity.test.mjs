import test from "node:test";
import assert from "node:assert/strict";
import {dublinDocLinks,dublinDocxXmlText,parseDublinCityDecisions} from "../src/council-weekly-dublincity.mjs";
const source="https://www.dublincity.ie/sites/default/files/2026-10/a1-wpl-41-26.docx";
function row(ref,status,date){
 return "\n______________________________________________________________________\nPart 1 - Reg Ref "+ref+"APPLICATION type "+status+" DATE\t"+date+
 "\nDecision description: applicant requests permission to grant extension\n";
}
test("DOCX official five-area discovery accepts reupload suffix",()=>{
 const html='<a href="/sites/default/files/2026-10/a1-wpl-41-26.docx">a1</a><a href="/sites/default/files/2026-10/a2-wpl-41-26_0.docx">a2</a>'+
 '<a href="/sites/default/files/2026-10/a3-wpl-41-26.docx">a3</a>'+
 '<a href="/sites/default/files/2026-10/a4-wpl-41-26.docx">a4</a>'+
 '<a href="/sites/default/files/2026-10/a5-wpl-41-26.docx">a5</a>'+
 '<a href="/sites/default/files/2026-07/a3-wpl-30-26.docx">old</a>';
 const docs=dublinDocLinks(html);
 assert.equal(docs.length,5);assert.equal(docs[1].area,2);
});
test("DOCX XML text conversion keeps paragraphs and tabs",()=>{
 const xml="<w:document><w:p><w:t>WEB1234/26</w:t><w:tab/><w:t>APPLICATION</w:t></w:p><w:p><w:t>GRANT</w:t></w:p><w:p><w:t>"+("More planning description information. ".repeat(20))+"</w:t></w:p></w:document>";
 const txt=dublinDocxXmlText(xml);
 assert.match(txt,/WEB1234\/26\s+APPLICATION/);
 assert.match(txt,/GRANT/);
});
test("Parse only explicit decision status before DATE",()=>{
 const body="OFFICIAL WEEKLY LIST OF PLANNING APPLICATIONS\n"+
 row("WEB1334/26","GRANT PERMISSION","07/10/2026")+
 row("WEB1315/26","ADDITIONAL INFORMATION","09/10/2026")+
 row("WEB1724/26","REFUSE PERMISSION","06/10/2026")+
 row("WEB1886/26","APPLICATION REGISTERED","06/10/2026")+
 row("WEB1987/26","GRANT RETENTION","06/10/2026");
 const parsed=parseDublinCityDecisions(body,source);
 assert.deepEqual(parsed.decisions.map(x=>[x.reference,x.decision_date,x.decision_text]),[
  ["WEB1334/26","2026-10-07","Granted"],
  ["WEB1724/26","2026-10-06","Refused"],
  ["WEB1987/26","2026-10-06","Granted"]
 ]);
});
test("Ignore dates before August and missing status or missing markers",()=>{
 const body="OFFICIAL LIST\n"+
 row("WEB1334/26","GRANT PERMISSION","07/07/2026")+
 row("WEB1360/26","ADDITIONAL INFORMATION","09/10/2026")+
 row("WEB1361/26","REQUEST FOR PERMISSION","10/10/2026");
 const parsed=parseDublinCityDecisions(body,source);
 assert.equal(parsed.decisions.length,0);
 assert.throws(()=>parseDublinCityDecisions("empty",source));
});
