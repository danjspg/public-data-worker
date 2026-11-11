// Read-only metadata and newest-date probe for Cork City official open-data dataset.
// No production writes, applicant fields, Agile endpoints or retries on blocks.
const root="https://data.corkcity.ie/api/3/action/";
const id="8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
const headers={"Accept":"application/json","User-Agent":"openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)"};
async function get(action,params){
 const url=new URL(root+action);
 for(const [name,value] of Object.entries(params))url.searchParams.set(name,String(value));
 const response=await fetch(url,{headers,redirect:"error",signal:AbortSignal.timeout(16000)});
 if(response.status===403||response.status===429)throw Error("Official data host denied request: HTTP "+response.status);
 if(!response.ok)throw Error("Official CKAN API: "+action+" HTTP "+response.status);
 const json=await response.json();
 if(!json.success)throw Error("CKAN "+action+" failed: "+String(json.error?.message||json.error?.__type||"unknown").slice(0,130));
 return json.result;
}
const output={readOnly:true};
for(const [name,action,params] of [
 ["resource","resource_show",{id}],
 ["last","datastore_search",{resource_id:id,limit:2,sort:"ReceivedDate desc",fields:"ApplicationNumber,ReceivedDate"}],
 ["sql","datastore_search_sql",{sql:'SELECT MAX("ReceivedDate") AS newest, COUNT(*) AS rows FROM "'+id+'"'}]
]){
 try{
 const result=await get(action,params);
 output[name]=name==="resource"?{lastModified:result.last_modified,metadataModified:result.metadata_modified,format:result.format,datastoreActive:result.datastore_active}:
 name==="last"?{total:result.total,records:result.records?.map(x=>({applicationNumber:String(x.ApplicationNumber||"").slice(0,25),receivedDate:x.ReceivedDate}))}:
 {records:result.records?.map(x=>({newest:x.newest,count:x.rows}))};
 }catch(e){output[name]={error:String(e.message||e).slice(0,240)};if(/HTTP (403|429)/.test(String(e.message||e)))break}
}
console.log(JSON.stringify(output,null,2));
