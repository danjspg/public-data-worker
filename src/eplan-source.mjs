import { EPLAN_AUTHORITIES } from './planning-source-registry.mjs';

const EPLAN_BASE_URL='https://www.eplanning.ie';
const EPLAN_V6_BASE_URL='https://eplanning.ie/ePlan';
const RETRYABLE=new Set([408,425,429,500,502,503,504]);
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
const normaliseReference=(value)=>String(value||'').trim().replace(/\s+/g,'').toUpperCase();
const BROWSER_HEADERS={
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':'en-GB,en;q=0.9',
};

function htmlText(value){
  return String(value||'').replace(/<br\s*\/?>/gi,' ').replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&#39;|&apos;/gi,"'").replace(/&quot;/gi,'"')
    .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\s+/g,' ').trim();
}
function parseIrishDate(value){
  const m=String(value||'').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if(!m)return null;
  const iso=`${m[3]}-${m[2]}-${m[1]}`;
  const d=new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==iso?null:iso;
}
function detailFields(html){
  const fields=new Map();
  for(const row of String(html||'').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const cells=[...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m)=>htmlText(m[1]));
    for(let i=0;i+1<cells.length;i+=2){
      const label=cells[i].replace(/:$/,'').trim().toLowerCase();
      const value=cells[i+1]?.trim()||'';
      if(label&&!fields.has(label))fields.set(label,value);
    }
  }
  return fields;
}
function tabFields(html,tabId){
  const escaped=String(tabId).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const tab=String(html||'').match(new RegExp(`<div\\b[^>]*\\bid=["']${escaped}["'][^>]*>([\\s\\S]*?)(?=<div\\b[^>]*class=["'][^"']*tab-pane|$)`,'i'));
  return detailFields(tab?.[1]||'');
}
function parseEplanApplication(html,authorityCode,expectedReference){
  const config=EPLAN_AUTHORITIES[authorityCode];
  if(!config)return {ok:false,reason:'unsupported_authority'};
  const fields=detailFields(html), applicant=tabFields(html,'Applicant'), development=tabFields(html,'Development'), decision=tabFields(html,'Decision'), appeal=tabFields(html,'Appeal');
  const fileNumber=normaliseReference(fields.get('file number'));
  if(!fileNumber||fileNumber!==normaliseReference(expectedReference))return {ok:false,reason:'reference_mismatch',fileNumber:fileNumber||null};
  const date=(map,key)=>parseIrishDate(map.get(key));
  const text=(map,key)=>htmlText(map.get(key))||null;
  const url=`${EPLAN_BASE_URL}/${config.path}/AppFileRefDetails/${encodeURIComponent(fileNumber)}/0`;
  return {
    ok:true,
    local_authority:config.name,
    local_authority_code:authorityCode,
    source_application_id:null,
    reference:fileNumber,
    web_reference:fileNumber,
    application_type:text(fields,'application type'),
    proposal:text(development,'development description'),
    location:text(development,'development address'),
    applicant_name:text(applicant,'applicant name'),
    agent_name:null,
    status:text(fields,'planning status'),
    decision_text:text(decision,'decision type')||text(fields,'decision type')||text(decision,'decision description'),
    registration_date:date(fields,'received date'),
    valid_date:date(fields,'validated date'),
    decision_due_date:date(fields,'decision due date'),
    decision_date:date(decision,'decision date')||date(fields,'decision date'),
    final_grant_date:date(decision,'grant date'),
    further_information_requested_date:date(fields,'further info requested'),
    further_information_received_date:date(fields,'further info received'),
    withdrawal_date:date(fields,'withdrawn date'),
    appeal_lodged_date:date(fields,'appeal date'),
    appeal_decision_date:date(appeal,'decision date'),
    expiry_date:date(fields,'expiry date'),
    source_url:url,
    source_api_url:url,
  };
}
async function fetchWithRetry(url,options={},timeoutMs=20000){
  let lastError=null;
  for(let attempt=1;attempt<=4;attempt++){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetch(url,{...options,headers:{'User-Agent':'Public records data worker',...(options.headers||{})},signal:controller.signal});
      if(response.ok)return response;
      lastError=new Error(`HTTP ${response.status}`);
      if(!RETRYABLE.has(response.status))return response;
    }catch(error){lastError=error;}finally{clearTimeout(timer);}
    if(attempt<4)await sleep(attempt*750);
  }
  throw lastError||new Error('request failed');
}
async function fetchEplanApplication(authorityCode,reference){
  const config=EPLAN_AUTHORITIES[authorityCode];
  if(!config)return {ok:false,reason:'unsupported_authority'};
  const ref=normaliseReference(reference);
  const url=`${EPLAN_BASE_URL}/${config.path}/AppFileRefDetails/${encodeURIComponent(ref)}/0`;
  try{
    const response=await fetchWithRetry(url,{},20000);
    if(response.status===404)return {ok:false,reason:'not_found',url};
    if(!response.ok)return {ok:false,reason:`http_${response.status}`,url};
    return {...parseEplanApplication(await response.text(),authorityCode,ref),url};
  }catch(error){return {ok:false,reason:'fetch_error',error:String(error),url};}
}
function extractRequestToken(html){
  const tokens=[...String(html||'').matchAll(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/gi)];
  return tokens.length?tokens[tokens.length-1][1]:null;
}
function cookiesFromResponse(response){
  const raw=typeof response.headers.getSetCookie==='function'?response.headers.getSetCookie():[response.headers.get('set-cookie')||''];
  const values=new Map();
  for(const item of raw.filter(Boolean)){
    const first=item.split(';')[0];
    const separator=first.indexOf('=');
    if(separator>0)values.set(first.slice(0,separator),first.slice(separator+1));
  }
  return values;
}
function mergeCookieMaps(...maps){
  const merged=new Map();
  for(const map of maps)for(const [key,value] of map)merged.set(key,value);
  return merged;
}
function cookieHeader(map){return [...map].map(([key,value])=>`${key}=${value}`).join('; ');}
function extractDetailReferences(html){
  const refs=new Set();
  const patterns=[
    /AppFileRefDetails\/([^/"'?#]+)\/[0-9]+(?:\?[^"']*)?/gi,
    /AppFileRefDetails\/([^/"'?#]+)(?:\/0)?/gi,
    /(?:FileRef|fileRef|filenumber|fileNumber)=([^&"'#]+)/gi,
  ];
  for(const pattern of patterns){
    for(const match of String(html||'').matchAll(pattern)){
      try{refs.add(normaliseReference(decodeURIComponent(match[1])));}catch{refs.add(normaliseReference(match[1]));}
    }
  }
  return [...refs].filter(Boolean);
}
function extractPagingUrls(html,authorityId){
  const urls=new Set();
  const patterns=[
    /href=["']([^"']*\/ePlan\/searchresults\/Default\/\d+\?[^"']*)["']/gi,
    /href=["']([^"']*searchresults[^"']*(?:page|Page)=[^"']+)["']/gi,
  ];
  for(const pattern of patterns){
    for(const m of String(html||'').matchAll(pattern)){
      const href=m[1].replace(/&amp;/g,'&');
      try{urls.add(new URL(href,`${EPLAN_V6_BASE_URL}/searchresults?localAuthorityId=${authorityId}`).toString());}catch{}
    }
  }
  return [...urls];
}
async function fetchEplanReceivedReferences(authorityCode,days=42){
  const config=EPLAN_AUTHORITIES[authorityCode];
  if(!config||!Number.isInteger(config.id))throw new Error('unsupported_eplan_authority');
  const authorityId=config.id;
  const listingUrl=`${EPLAN_V6_BASE_URL}/SearchListing/RECEIVED?localAuthorityId=${authorityId}`;
  const page=await fetchWithRetry(listingUrl,{headers:BROWSER_HEADERS},20000);
  if(!page.ok)throw new Error(`eplan v6 listing HTTP ${page.status}`);
  const html=await page.text(),token=extractRequestToken(html),getCookies=cookiesFromResponse(page);
  if(!token)throw new Error('eplan v6 request verification token missing');
  const windowDays=[7,14,28,35,42].find((value)=>value>=days)||42;
  const body=new URLSearchParams();
  body.append('__RequestVerificationToken',token);
  body.append('AppStatus','0');
  body.append('RdoTimeLimit',windowDays===7?'0':String(windowDays));
  body.append('CheckBoxList[0].Id',String(authorityId));
  body.append('CheckBoxList[0].Name',config.name);
  body.append('CheckBoxList[0].IsSelected','True');
  body.append('SearchType','Listing');
  body.append('CountyTownCount','31');
  body.append('CountyTownCouncilNames',`${config.name}:${authorityId},`);
  const searchUrl=`${EPLAN_V6_BASE_URL}/searchresults?localAuthorityId=${authorityId}`;
  const response=await fetchWithRetry(searchUrl,{
    method:'POST',redirect:'follow',
    headers:{...BROWSER_HEADERS,'Content-Type':'application/x-www-form-urlencoded','Origin':'https://eplanning.ie','Referer':listingUrl,Cookie:cookieHeader(getCookies)},
    body:body.toString()
  },30000);
  if(!response.ok)throw new Error(`eplan v6 search HTTP ${response.status}`);
  if(/aspxerrorpath=/i.test(response.url))throw new Error('eplan_v6_listing_server_error');
  const sessionCookies=mergeCookieMaps(getCookies,cookiesFromResponse(response));
  const resultHtml=await response.text();
  const refs=new Set(extractDetailReferences(resultHtml));
  const pages=extractPagingUrls(resultHtml,authorityId).slice(0,60);
  for(const url of pages){
    const paged=await fetchWithRetry(url,{headers:{...BROWSER_HEADERS,Referer:searchUrl,Cookie:cookieHeader(sessionCookies)}},20000);
    if(!paged.ok)continue;
    for(const ref of extractDetailReferences(await paged.text()))refs.add(ref);
  }
  if(refs.size===0){
    const looksLikeListingForm=/SearchListing|View Planning Application Lists Search/i.test(resultHtml);
    const noResults=/no (?:planning )?(?:applications|records|results)|0 results|no records found/i.test(htmlText(resultHtml));
    if(looksLikeListingForm&&!noResults)throw new Error('eplan_v6_listing_submission_not_accepted');
    if(!noResults)throw new Error('eplan_v6_zero_refs_unverified');
  }
  return {references:[...refs],listing_url:listingUrl,search_url:searchUrl,window_days:windowDays,authority_id:authorityId,pages_checked:pages.length+1};
}

export { normaliseReference, parseEplanApplication, fetchEplanApplication, fetchEplanReceivedReferences };
