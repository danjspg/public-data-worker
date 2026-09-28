// Temporary diagnostic: remove after ePlan result markup is confirmed.
const base='https://eplanning.ie/ePlan';
const authorityId=12;
const name='Kerry County Council';
const listingUrl=`${base}/SearchListing/RECEIVED?localAuthorityId=${authorityId}`;
const browserHeaders={
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':'en-GB,en;q=0.9',
};
const get=await fetch(listingUrl,{headers:browserHeaders,redirect:'follow'});
const html=await get.text();
const tokens=[...html.matchAll(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/gi)];
const token=tokens.at(-1)?.[1];
const setCookies=typeof get.headers.getSetCookie==='function'?get.headers.getSetCookie():[get.headers.get('set-cookie')||''];
const cookie=setCookies.filter(Boolean).map(v=>v.split(';')[0]).join('; ');
if(!token)throw new Error('token missing');
const body=new URLSearchParams();
body.append('__RequestVerificationToken',token);
body.append('AppStatus','0');
body.append('RdoTimeLimit','28');
body.append('CheckBoxList[0].Id',String(authorityId));
body.append('CheckBoxList[0].Name',name);
body.append('CheckBoxList[0].IsSelected','True');
body.append('SearchType','Listing');
body.append('CountyTownCount','31');
body.append('CountyTownCouncilNames',`${name}:${authorityId},`);
const postUrl=`${base}/searchresults?localAuthorityId=${authorityId}`;
const post=await fetch(postUrl,{
  method:'POST',redirect:'follow',
  headers:{
    ...browserHeaders,
    'Content-Type':'application/x-www-form-urlencoded',
    'Origin':'https://eplanning.ie',
    'Referer':listingUrl,
    ...(cookie?{Cookie:cookie}:{}),
  },
  body:body.toString(),
});
const result=await post.text();
const hrefs=[...result.matchAll(/href=["']([^"']+)["']/gi)].map(m=>m[1].replaceAll('&amp;','&'));
const interesting=hrefs.filter(h=>/plan|app|file|detail|search|result/i.test(h)).slice(0,80);
const text=String(result).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/\s+/g,' ').trim();
const tokensFound=[...new Set([
  ...[...result.matchAll(/AppFileRefDetails[^\s"'<>]*/gi)].map(m=>m[0]),
  ...[...result.matchAll(/\b(?:25|26)\d{4,6}\b/g)].map(m=>m[0]),
])].slice(0,80);
console.log(JSON.stringify({
  getStatus:get.status,
  cookieNames:setCookies.map(v=>v.split('=')[0]),
  tokenCount:tokens.length,
  postStatus:post.status,
  finalUrl:post.url,
  redirected:post.redirected,
  contentType:post.headers.get('content-type'),
  length:result.length,
  hasListingForm:/View Planning Application Lists Search/i.test(result),
  hasNoResults:/no (?:planning )?(?:applications|records|results)|0 results|no records found/i.test(text),
  interestingHrefs:interesting,
  tokenSamples:tokensFound,
  textStart:text.slice(0,3000)
},null,2));