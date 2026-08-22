export const DISCOVERY_VERSION = 'web-discovery-v3';
export const DEFAULT_SEARCH_POLICY = Object.freeze({
  id:'duckduckgo-html',
  policyReviewedAt:'2026-08-08',
  policyUrl:'https://duckduckgo.com/acceptable-use',
  policyStatus:'reviewed',
  reviewMaxAgeDays:90,
  note:'Low-rate, user-initiated search only. Search results are discovery hints, never evidence.',
});

export const WIKIMEDIA_DISCOVERY_POLICY = Object.freeze({
  id:'wikimedia-rest',
  policyUrl:'https://www.mediawiki.org/wiki/API:REST_API/Reference',
  policyStatus:'documented-api',
  note:'Low-rate, user-initiated entity discovery through documented Wikimedia APIs.',
});

const TRACKING_PARAMS = new Set(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid','mc_cid','mc_eid','ref','ref_src']);
const STRUCTURAL_FAILURES = new Set(['BLOCKED','CAPTCHA','PARSE_CHANGED']);
const ADAPTER_STALL_MS = 10_000;
function adapterSignal(parent, timeoutMs = ADAPTER_STALL_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Discovery provider stalled'), { code:'DISCOVERY_TIMEOUT' })), timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once:true });
  return { signal:controller.signal, close(){ clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}
const CIRCUIT_FAILURES = 3;
const CIRCUIT_MS = 5 * 60_000;

export function policyReviewCurrent(policy, at = Date.now()) {
  const reviewed=Date.parse(String(policy?.policyReviewedAt||''));
  const maxDays=Number(policy?.reviewMaxAgeDays||0);
  return policy?.policyStatus==='reviewed' && Number.isFinite(reviewed) && maxDays>0 && (at-reviewed) <= maxDays*86400000 && at>=reviewed-86400000;
}

function clean(value='') { return String(value || '').normalize('NFKC').replace(/\s+/gu,' ').trim(); }
function hostOf(url) { try { return new URL(url).hostname.toLowerCase().replace(/^www\./u,''); } catch { return ''; } }

export function canonicalizeUrl(input) {
  const url = new URL(String(input || ''));
  if(!['http:','https:'].includes(url.protocol))throw new TypeError('Only HTTP and HTTPS URLs can be discovered.');
  if(url.username||url.password)throw new TypeError('Credential-bearing URLs cannot be discovered.');
  if(!url.hostname)throw new TypeError('A discovered URL must include a host.');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.has(key.toLowerCase()) || /^utm_/iu.test(key)) url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/u,'');
  return url.href;
}

export function unwrapDuckDuckGoUrl(input) {
  let url;
  try { url = new URL(String(input || ''), 'https://duckduckgo.com/'); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) {
    if (url.searchParams.has('ad_domain') || url.searchParams.has('ad_provider')) return null;
    const target = url.searchParams.get('uddg');
    if (!target) return null;
    try {
      const decoded = decodeURIComponent(target);
      const parsed = new URL(decoded);
      if (!['http:','https:'].includes(parsed.protocol)) return null;
      return canonicalizeUrl(parsed.href);
    } catch { return null; }
  }
  if (!['http:','https:'].includes(url.protocol)) return null;
  return canonicalizeUrl(url.href);
}

function typedFailure(error) {
  const code = String(error?.code || 'NETWORK_FAILURE');
  const status=Number(error?.details?.status||0);
  if (code.includes('CAPTCHA')) return 'CAPTCHA';
  if (/TIMEOUT|DEADLINE/u.test(code)) return 'TIMEOUT';
  if (status===429 || /RATE_LIMIT|TOO_MANY_REQUESTS/u.test(code)) return 'RATE_LIMIT';
  if (code.includes('BLOCK') || code === 'WEB_HTTP_STATUS' && status === 403) return 'BLOCKED';
  return 'NETWORK_FAILURE';
}

function duckSnippet(pageText,title,domain,allTitles){
  if(!title||title===domain)return'';
  const lines=String(pageText||'').split(/\r?\n+/u).map(clean).filter(Boolean);
  const index=lines.findIndex(line=>line===title||line.includes(title));
  if(index<0)return'';
  for(const line of lines.slice(index+1,index+7)){
    if(line===title||allTitles.has(line))break;
    const low=line.toLocaleLowerCase('en');
    if(line.length<24||/^\d+[.)]?$/u.test(line)||/^https?:\/\//iu.test(line)||low===domain||low.includes(`${domain}/`))continue;
    return line.slice(0,1000);
  }
  return'';
}
function retryAfterMs(error,{maxMs=30_000}={}) {
  const raw=error?.details?.retryAfter ?? error?.retryAfter ?? null;
  if(raw==null||raw==='')return Math.min(maxMs,5_000);
  const seconds=Number(raw);
  if(Number.isFinite(seconds))return Math.max(250,Math.min(maxMs,Math.ceil(seconds*1000)));
  const stamp=Date.parse(String(raw));
  if(Number.isFinite(stamp))return Math.max(250,Math.min(maxMs,stamp-Date.now()));
  return Math.min(maxMs,5_000);
}

export function parseDuckDuckGoPage(page, { query = '', maxResults = 12, engine = 'duckduckgo-html', parserVersion = 'ddg-html-v2' } = {}) {
  const rawText=String(page?.text||'');
  const text = clean(rawText);
  const links=(Array.isArray(page?.links)?page.links:[]).map(link=>({link,target:unwrapDuckDuckGoUrl(link?.href)})).filter(item=>item.target&&hostOf(item.target)&&!hostOf(item.target).endsWith('duckduckgo.com'));
  const allTitles=new Set(links.map(item=>clean(item.link?.text)).filter(Boolean));
  const results=[]; const seen=new Set();
  for (const {link,target} of links) {
    const domain = hostOf(target);
    if (!domain || domain.endsWith('duckduckgo.com') || seen.has(target)) continue;
    seen.add(target);
    const title = clean(link.text).slice(0,500) || domain;
    const snippet=duckSnippet(rawText,title,domain,allTitles);
    results.push({
      url:target, title, snippet, displayDomain:domain, timestampHint:null,
      engine, engineRank:results.length + 1, parserVersion, parseConfidence:title === domain ? 0.65 : snippet ? 0.98 : 0.9,
      sponsored:false, query,
    });
    if (results.length >= maxResults) break;
  }
  if (results.length) return { outcome:'RESULTS', results, parserVersion, confidence:0.95 };
  if (/\b(?:captcha|verify\s+you\s+are\s+human|unusual\s+traffic)\b/iu.test(text.slice(0,3000))) return { outcome:'CAPTCHA', results:[], parserVersion, confidence:1 };
  if (/\b(?:access\s+denied|temporarily\s+blocked|automated\s+requests)\b/iu.test(text.slice(0,3000))) return { outcome:'BLOCKED', results:[], parserVersion, confidence:1 };
  if (/\b(?:no results|no more results|did not match any documents)\b/iu.test(text)) return { outcome:'ZERO_RESULTS', results:[], parserVersion, confidence:0.9 };
  return { outcome:'PARSE_CHANGED', results:[], parserVersion, confidence:0.2 };
}

export function parseSearxngJson(value, { query = '', maxResults = 12 } = {}) {
  let payload;
  try { payload = typeof value === 'string' ? JSON.parse(value) : value; } catch { return { outcome:'PARSE_CHANGED', results:[], parserVersion:'searxng-json-v1', confidence:0.1 }; }
  if (!payload || !Array.isArray(payload.results)) return { outcome:'PARSE_CHANGED', results:[], parserVersion:'searxng-json-v1', confidence:0.1 };
  const results=[]; const seen=new Set();
  for (const item of payload.results) {
    let url;
    try { url = canonicalizeUrl(item?.url); } catch { continue; }
    if (!/^https?:/iu.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({
      url, title:clean(item?.title).slice(0,500) || hostOf(url), snippet:clean(item?.content).slice(0,1000),
      displayDomain:hostOf(url), timestampHint:item?.publishedDate || item?.published_date || null,
      engine:'searxng', engineRank:results.length + 1, parserVersion:'searxng-json-v1', parseConfidence:0.98, sponsored:false, query,
    });
    if (results.length >= maxResults) break;
  }
  return { outcome:results.length ? 'RESULTS' : 'ZERO_RESULTS', results, parserVersion:'searxng-json-v1', confidence:1 };
}

function safeJson(page) {
  try { return JSON.parse(String(page?.text || '')); }
  catch { return null; }
}
function plainSnippet(value='') { return clean(String(value || '').replace(/<[^>]+>/gu,' ')).slice(0,1000); }
function entityId(value) { return /^Q\d+$/u.test(String(value || '')) ? String(value) : ''; }
function claimTime(statement, property) {
  const value=statement?.qualifiers?.[property]?.[0]?.datavalue?.value?.time;
  return typeof value==='string' ? value.replace(/^\+/u,'').slice(0,10) : null;
}
export function currentOfficeStatement(entity,{today=new Date().toISOString().slice(0,10)}={}) {
  const claims=Array.isArray(entity?.claims?.P1308) ? entity.claims.P1308 : [];
  const eligible=claims.filter(statement => statement?.rank!=='deprecated'&&statement?.mainsnak?.snaktype==='value' && entityId(statement?.mainsnak?.datavalue?.value?.id) && (!claimTime(statement,'P582')||claimTime(statement,'P582')>=today) && (!claimTime(statement,'P580')||claimTime(statement,'P580')<=today));
  eligible.sort((a,b)=>((b?.rank==='preferred'?2:1)-(a?.rank==='preferred'?2:1))||String(claimTime(b,'P580')||'').localeCompare(String(claimTime(a,'P580')||'')));
  return eligible[0] || null;
}
function officeSearchMatch(items,officeQuery,target,role){
  const exact=items.find(item=>clean(item?.label).toLocaleLowerCase('en')===officeQuery.toLocaleLowerCase('en'));
  if(exact)return exact;
  const targetTokens=clean(target).toLocaleLowerCase('en').split(/[^\p{L}\p{N}]+/u).filter(token=>token.length>1);
  const roleTokens=clean(role).toLocaleLowerCase('en').split(/[^\p{L}\p{N}]+/u).filter(token=>token.length>2);
  return items.find(item=>{const hay=clean(`${item?.label||''} ${item?.description||''}`).toLocaleLowerCase('en');return targetTokens.every(token=>hay.includes(token))&&roleTokens.some(token=>hay.includes(token));})||null;
}
function officialWebsite(entity) {
  for (const statement of Array.isArray(entity?.claims?.P856) ? entity.claims.P856 : []) {
    const value=statement?.mainsnak?.datavalue?.value;
    try { const url=new URL(String(value||'')); if(['http:','https:'].includes(url.protocol)) return canonicalizeUrl(url.href); } catch {}
  }
  return null;
}
function wikidataOfficeAdapter(web) {
  return {
    id:'wikidata-office', policy:WIKIMEDIA_DISCOVERY_POLICY,
    supports(plan){ return plan?.claimClass==='current-office' && Boolean(plan?.target && plan?.officeRole); },
    async search(_query,{signal,maxResults=12,plan=null}={}) {
      const officeQuery=`${plan?.officeRole || ''} of ${plan?.target || ''}`.replace(/\s+/gu,' ').trim().slice(0,200);
      if(!officeQuery) return {outcome:'ZERO_RESULTS',results:[],parserVersion:'wikidata-office-v1',confidence:1};
      try {
        async function searchOffice(searchText){const searchUrl=new URL('https://www.wikidata.org/w/api.php');searchUrl.searchParams.set('action','wbsearchentities');searchUrl.searchParams.set('search',searchText);searchUrl.searchParams.set('language','en');searchUrl.searchParams.set('uselang','en');searchUrl.searchParams.set('type','item');searchUrl.searchParams.set('limit','5');searchUrl.searchParams.set('format','json');const searchPage=await web.fetch(searchUrl.href,{signal,deadlineMs:4500,maxBytes:512*1024,headers:{accept:'application/json'}});const search=safeJson(searchPage);return Array.isArray(search?.search)?search.search:[];}
        let searchText=officeQuery;let items=await searchOffice(searchText);let selected=officeSearchMatch(items,searchText,plan.target,plan.officeRole);
        if(!selected&&!/^the\s+/iu.test(clean(plan.target))){searchText=`${clean(plan.officeRole)} of the ${clean(plan.target)}`;items=await searchOffice(searchText);selected=officeSearchMatch(items,searchText,plan.target,plan.officeRole);}
        const officeId=entityId(selected?.id); if(!officeId)return {outcome:'ZERO_RESULTS',results:[],parserVersion:'wikidata-office-v1',confidence:1};
        const officePage=await web.fetch(`https://www.wikidata.org/wiki/Special:EntityData/${officeId}.json`,{signal,deadlineMs:4500,maxBytes:1024*1024,headers:{accept:'application/json'}});
        const officePayload=safeJson(officePage); const office=officePayload?.entities?.[officeId];
        if(!office)return {outcome:'PARSE_CHANGED',results:[],parserVersion:'wikidata-office-v1',confidence:0.2};
        const statement=currentOfficeStatement(office); const personId=entityId(statement?.mainsnak?.datavalue?.value?.id);
        if(!personId)return {outcome:'ZERO_RESULTS',results:[],parserVersion:'wikidata-office-v1',confidence:1};
        const personPage=await web.fetch(`https://www.wikidata.org/wiki/Special:EntityData/${personId}.json`,{signal,deadlineMs:3500,maxBytes:768*1024,headers:{accept:'application/json'}});
        const personPayload=safeJson(personPage); const person=personPayload?.entities?.[personId];
        const personName=clean(person?.labels?.en?.value || person?.labels?.mul?.value || '');
        if(!person||!personName)return {outcome:'PARSE_CHANGED',results:[],parserVersion:'wikidata-office-v1',confidence:0.2};
        const officeLabel=clean(office?.labels?.en?.value || office?.labels?.mul?.value || officeQuery);
        const startDate=claimTime(statement,'P580'); const retrievedAt=new Date().toISOString(); const site=officialWebsite(office); const results=[];
        if(site) results.push({url:site,title:`Official website — ${officeLabel}`,snippet:`Wikidata links this as the official website for ${officeLabel}.`,displayDomain:hostOf(site),timestampHint:startDate,engine:'wikidata-office',engineRank:1,parserVersion:'wikidata-office-v1',parseConfidence:0.99,sponsored:false,query:officeQuery});
        const wd=`https://www.wikidata.org/wiki/${officeId}`;
        const evidenceText=`${personName} is the current ${plan.officeRole} of ${plan.target}. Wikidata lists ${personName} as the current holder of ${officeLabel}.`;
        results.push({url:wd,title:`${personName} — ${officeLabel}`,snippet:`Wikidata lists ${personName} as the current holder of ${officeLabel}.`,displayDomain:'wikidata.org',timestampHint:retrievedAt,engine:'wikidata-office',engineRank:results.length+1,parserVersion:'wikidata-office-v2',parseConfidence:0.99,sponsored:false,query:officeQuery,structuredEvidence:{kind:'wikidata-current-office',text:evidenceText,authority:0.92,retrievedFrom:'Wikidata entity data',officeId,personId,personName,officeLabel,officeRole:clean(plan.officeRole),target:clean(plan.target),startDate,retrievedAt}});
        return {outcome:'RESULTS',results:results.slice(0,maxResults),parserVersion:'wikidata-office-v1',confidence:0.99};
      } catch(error) { return {outcome:typedFailure(error),results:[],parserVersion:'wikidata-office-v1',confidence:0,error}; }
    },
  };
}
function wikipediaSearchAdapter(web) {
  return {
    id:'wikipedia-rest', policy:WIKIMEDIA_DISCOVERY_POLICY,
    supports(plan){
      const excluded=(plan?.excludeDomains||[]).some(value=>{const domain=clean(value).toLocaleLowerCase().replace(/^www\./u,'');return domain==='wikipedia.org'||domain.endsWith('.wikipedia.org');});
      if(excluded)return false;
      const constrained=clean(plan?.sourceConstraint?.domain||'').toLocaleLowerCase().replace(/^www\./u,'');
      if(constrained&&constrained!=='wikipedia.org'&&!constrained.endsWith('.wikipedia.org'))return false;
      return !['news-current','sports-current','market-current','fx-current','retail-current'].includes(plan?.claimClass);
    },
    async search(query,{signal,maxResults=12}={}) {
      const url=new URL('https://en.wikipedia.org/w/rest.php/v1/search/page');
      url.searchParams.set('q',String(query||'').slice(0,400)); url.searchParams.set('limit',String(Math.max(1,Math.min(10,maxResults))));
      try {
        const page=await web.fetch(url.href,{signal,deadlineMs:4500,maxBytes:1024*1024,headers:{accept:'application/json'}});
        const payload=safeJson(page); if(!payload || !Array.isArray(payload.pages))return {outcome:'PARSE_CHANGED',results:[],parserVersion:'wikipedia-rest-v1',confidence:0.2};
        const results=[];
        for(const item of payload.pages){const title=clean(item?.title||'');if(!title)continue;const target=`https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ','_'))}`;results.push({url:target,title,snippet:plainSnippet(item?.excerpt||item?.description||''),displayDomain:'wikipedia.org',timestampHint:null,engine:'wikipedia-rest',engineRank:results.length+1,parserVersion:'wikipedia-rest-v1',parseConfidence:0.99,sponsored:false,query});if(results.length>=maxResults)break;}
        return {outcome:results.length?'RESULTS':'ZERO_RESULTS',results,parserVersion:'wikipedia-rest-v1',confidence:1};
      } catch(error){return {outcome:typedFailure(error),results:[],parserVersion:'wikipedia-rest-v1',confidence:0,error};}
    },
  };
}
function duckDuckGoGetAdapter(web) {
  const id='duckduckgo-noai',parserVersion='ddg-noai-v1';
  return {id,policy:DEFAULT_SEARCH_POLICY,async search(query,{signal,maxResults=12}={}){const url=`https://noai.duckduckgo.com/?q=${encodeURIComponent(String(query||'').slice(0,499))}`;try{const page=await web.fetch(url,{signal,deadlineMs:5000,maxBytes:2*1024*1024,headers:{accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2','accept-language':'en-US,en;q=0.8'}});return parseDuckDuckGoPage(page,{query,maxResults,engine:id,parserVersion});}catch(error){return{outcome:typedFailure(error),results:[],parserVersion,confidence:0,error};}}};
}

function duckDuckGoFormAdapter(web, { id, endpoint, parserVersion }) {
  return {
    id, policy:DEFAULT_SEARCH_POLICY,
    async search(query, { signal, maxResults = 12 } = {}) {
      const body = new URLSearchParams({ q:String(query || '').slice(0,499), b:'', kl:'wt-wt' }).toString();
      try {
        const page = await web.fetch(endpoint, {
          signal, deadlineMs:7000, maxBytes:2 * 1024 * 1024,
          method:'POST', body,
          headers:{ 'content-type':'application/x-www-form-urlencoded', accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2', 'accept-language':'en-US,en;q=0.8', 'sec-fetch-dest':'document', 'sec-fetch-mode':'navigate', 'sec-fetch-site':'same-origin', 'sec-fetch-user':'?1', 'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36', referer:endpoint },
        });
        return parseDuckDuckGoPage(page, { query, maxResults, engine:id, parserVersion });
      } catch (error) {
        return { outcome:typedFailure(error), results:[], parserVersion, confidence:0, error };
      }
    },
  };
}

function duckDuckGoBrowserAdapter(web) {
  const id='duckduckgo-browser'; const parserVersion='ddg-browser-v1';
  return {
    id, policy:DEFAULT_SEARCH_POLICY,
    async search(query, { signal, maxResults = 12 } = {}) {
      const url=`https://duckduckgo.com/?q=${encodeURIComponent(String(query || '').slice(0,499))}&ia=web`;
      try {
        const page=await web.render(url,{signal,deadlineMs:7000,maxBytes:2*1024*1024});
        return parseDuckDuckGoPage(page,{query,maxResults,engine:id,parserVersion});
      } catch(error) {
        return { outcome:typedFailure(error), results:[], parserVersion, confidence:0, error };
      }
    },
  };
}

function searxngAdapter(web, endpoint) {
  let base;
  try { base = new URL(String(endpoint || '')); } catch { return null; }
  if (!['http:','https:'].includes(base.protocol)) return null;
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return {
    id:'searxng', policy:{ id:'searxng', policyStatus:'user-configured', policyReviewedAt:null, policyUrl:null },
    async search(query, { signal, maxResults = 12 } = {}) {
      const url = new URL('search', base);
      url.searchParams.set('q', query); url.searchParams.set('format','json'); url.searchParams.set('safesearch','1');
      try {
        const page = await web.fetch(url.href, { signal, deadlineMs:7000, maxBytes:2 * 1024 * 1024 });
        return parseSearxngJson(page.text, { query, maxResults });
      } catch (error) {
        return { outcome:typedFailure(error), results:[], parserVersion:'searxng-json-v1', confidence:0, error };
      }
    },
  };
}

export function createDiscoveryService({ web, preferences, adapters = null } = {}) {
  if (!web) throw new Error('web service required');
  const health = new Map();

  function currentHealth(id) {
    const item = health.get(id) || { failures:0, structuralFailures:0, successes:0, openUntil:0, lastOutcome:null };
    if (item.openUntil && item.openUntil <= Date.now()) { item.openUntil=0; item.structuralFailures=0; }
    health.set(id,item); return item;
  }
  function mark(id, outcome, error=null) {
    const item=currentHealth(id); item.lastOutcome=outcome;
    if (outcome === 'RESULTS' || outcome === 'ZERO_RESULTS') { item.successes += 1; item.failures=0; item.structuralFailures=0; item.openUntil=0; item.cooldownReason=null; }
    else {
      item.failures += 1;
      if(outcome==='RATE_LIMIT'){item.openUntil=Math.max(item.openUntil||0,Date.now()+retryAfterMs(error));item.cooldownReason='RATE_LIMIT';}
      if (STRUCTURAL_FAILURES.has(outcome)) item.structuralFailures += 1;
      if (item.structuralFailures >= CIRCUIT_FAILURES) { item.openUntil = Math.max(item.openUntil||0,Date.now() + CIRCUIT_MS); item.cooldownReason='CIRCUIT_OPEN'; }
    }
  }
  async function adapterList() {
    if (Array.isArray(adapters)) return adapters;
    const all = await preferences?.getAllSettings?.() || {};
    const endpoint = all.network?.discoveryEndpoint || null;
    const list=[];
    const sx = endpoint ? searxngAdapter(web, endpoint) : null;
    if (sx) list.push(sx);
    list.push(wikidataOfficeAdapter(web));
    list.push(wikipediaSearchAdapter(web));
    if (policyReviewCurrent(DEFAULT_SEARCH_POLICY)) {
      list.push(duckDuckGoFormAdapter(web,{ id:'duckduckgo-html', endpoint:'https://html.duckduckgo.com/html/', parserVersion:'ddg-html-v2' }));
      list.push(duckDuckGoFormAdapter(web,{ id:'duckduckgo-lite', endpoint:'https://lite.duckduckgo.com/lite/', parserVersion:'ddg-lite-v1' }));
      list.push(duckDuckGoGetAdapter(web));
      list.push(duckDuckGoBrowserAdapter(web));
    }
    return list;
  }

  async function discover(plan, { signal = null, maxResults = 12, complementary = false, onAttempt = null } = {}) {
    if (!plan?.useWeb) return { status:'not-needed', candidates:[], attempts:[], adapterHealth:status().health };
    if (Array.isArray(plan.directUrls) && plan.directUrls.length) {
      const candidates=[];
      for (const raw of plan.directUrls.slice(0,maxResults)) {
        try { const url=canonicalizeUrl(raw); candidates.push({ url, title:hostOf(url), snippet:'', displayDomain:hostOf(url), timestampHint:null, engine:'direct-url', engineRank:candidates.length+1, parserVersion:'direct-v1', parseConfidence:1, sponsored:false, query:plan.query }); } catch {}
      }
      return { status:candidates.length ? 'success' : 'failed', candidates, attempts:[{ adapter:'direct-url', query:plan.query, outcome:candidates.length ? 'RESULTS' : 'ZERO_RESULTS', count:candidates.length }] };
    }
    const allAdapters=(await adapterList()).filter(adapter => typeof adapter.supports!=='function' || adapter.supports(plan));
    const attempts=[]; const candidates=[]; const seen=new Set();
    const perAdapterMax=complementary?Math.min(maxResults,Math.max(6,Math.ceil(maxResults/2))):maxResults;
    async function runAdapter(adapter,query,{recovery=false}={}){
      const started=Date.now();onAttempt?.({adapter:adapter.id,query,recovery});
      const child=adapterSignal(signal);let result;
      try{result=await adapter.search(query,{signal:child.signal,maxResults:perAdapterMax,plan});}
      catch(error){result={outcome:error?.code==='DISCOVERY_TIMEOUT'?'TIMEOUT':typedFailure(error),results:[],error};}
      finally{child.close();}
      const outcome=result?.outcome||'NETWORK_FAILURE';mark(adapter.id,outcome,result?.error||null);
      attempts.push({adapter:adapter.id,query,outcome,durationMs:Math.max(0,Date.now()-started),count:result?.results?.length||0,parserVersion:result?.parserVersion||null,recovery,...(result?.error?{errorCode:String(result.error.code||result.error.name||'ERROR').slice(0,80),causeCode:String(result.error.cause?.code||result.error.cause?.name||'').slice(0,80)||null,transportAttempts:Array.isArray(result.error?.details?.transportAttempts)?result.error.details.transportAttempts.slice(0,3).map(item=>({id:String(item?.id||'').slice(0,40),code:String(item?.code||'').slice(0,60),cause:item?.cause?String(item.cause).slice(0,60):null,curlExitCode:Number.isFinite(Number(item?.curlExitCode))?Number(item.curlExitCode):null})):null}:{})});
      for(const item of result?.results||[]){let key;try{key=canonicalizeUrl(item.url);}catch{continue;}if(seen.has(key))continue;seen.add(key);candidates.push({...item,url:key,query});if(candidates.length>=maxResults)break;}
      return outcome;
    }
    for (const query of (plan.variants?.length ? plan.variants : [plan.query]).slice(0,3)) {
      for (const adapter of allAdapters) {
        const h=currentHealth(adapter.id);
        if (h.openUntil > Date.now()) { attempts.push({ adapter:adapter.id, query, outcome:h.cooldownReason==='RATE_LIMIT'?'RATE_LIMIT_COOLDOWN':'CIRCUIT_OPEN', count:0, retryAt:h.openUntil }); continue; }
        const outcome=await runAdapter(adapter,query);
        if (candidates.length >= maxResults) break;
        const resultAdapters=new Set(attempts.filter(item=>item.query===query&&item.outcome==='RESULTS').map(item=>item.adapter)).size;
        if (outcome === 'RESULTS' && candidates.length > 0 && (!complementary || resultAdapters>=2)) break;
      }
      if (candidates.length > 0 && !complementary) break;
      if (candidates.length >= maxResults) break;
    }
    if(!candidates.length&&!signal?.aborted&&attempts.some(item=>['PARSE_CHANGED','TIMEOUT','NETWORK_FAILURE'].includes(item.outcome))){
      const recoveryAdapter=allAdapters.find(adapter=>['searxng','duckduckgo-html','duckduckgo-lite'].includes(adapter.id)&&currentHealth(adapter.id).openUntil<=Date.now());
      const recoveryQuery=(plan.variants?.length?plan.variants[0]:plan.query);
      if(recoveryAdapter&&recoveryQuery)await runAdapter(recoveryAdapter,recoveryQuery,{recovery:true});
    }
    let reason=null;
    if (!candidates.length) {
      const outcomes=attempts.map(item=>item.outcome);
      if (!allAdapters.length) reason='NO_DISCOVERY_ADAPTERS';
      else if (outcomes.includes('CAPTCHA') || outcomes.includes('BLOCKED')) reason='DISCOVERY_BLOCKED';
      else if (outcomes.includes('PARSE_CHANGED')) reason='DISCOVERY_PARSE_CHANGED';
      else if (outcomes.includes('NETWORK_FAILURE')) reason='DISCOVERY_NETWORK_FAILED';
      else if (outcomes.includes('TIMEOUT')) reason='DISCOVERY_TIMEOUT';
      else if (outcomes.includes('ZERO_RESULTS')) reason='ZERO_RESULTS';
      else reason='NO_DISCOVERY_RESULTS';
    }
    return { status:candidates.length ? 'success' : 'failed', reason, candidates, attempts, adapterHealth:status().health };
  }

  function status() {
    const out={};
    for (const [id,item] of health) out[id]={ failures:item.failures, structuralFailures:item.structuralFailures, successes:item.successes, circuitOpen:item.openUntil > Date.now(), openUntil:item.openUntil || null, cooldownReason:item.cooldownReason||null, lastOutcome:item.lastOutcome };
    return { version:DISCOVERY_VERSION, defaultAdapter:'duckduckgo-html', defaultPolicyCurrent:policyReviewCurrent(DEFAULT_SEARCH_POLICY), policy:DEFAULT_SEARCH_POLICY, health:out };
  }
  return { discover, status, policyReviewCurrent };
}
