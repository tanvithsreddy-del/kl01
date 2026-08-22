import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { isPublicAddress, authorizeDestination } from '../server/web/policy.js';
import { extractDocument } from '../server/web/extract.js';
import { parseHtmlDocument } from '../server/web/html-reader.js';
import { canonicalizeUrl, createDiscoveryService, currentOfficeStatement, parseDuckDuckGoPage } from '../server/web/discovery.js';
import { classifyPageContent, createPageReader, selectRelevantExcerpts } from '../server/research/page-reader.js';
import { directFetch } from '../server/web/direct-fetch.js';
import { parseHeaderBlock, windowsCurlRequest } from '../server/web/windows-native.js';
import { connectThroughProxy, formatUpstreamProxy, parseUpstreamProxy } from '../server/web/upstream-proxy.js';
import { createWebService } from '../server/web/service.js';
import { pageRoleFor } from '../server/research/dossier.js';
import { rankCandidates } from '../server/web/rank.js';

const publicLookup=async()=>[{address:'93.184.216.34',family:4}];
function statement(person,{rank='normal',start=null,end=null}={}){return{rank,mainsnak:{snaktype:'value',datavalue:{value:{id:person}}},qualifiers:{...(start?{P580:[{datavalue:{value:{time:`+${start}T00:00:00Z`}}}]}:{}),...(end?{P582:[{datavalue:{value:{time:`+${end}T00:00:00Z`}}}]}:{})}};}

test('destination policy blocks local and special networks',async()=>{
  assert.equal(isPublicAddress('8.8.8.8'),true);
  for(const address of ['127.0.0.1','10.0.0.1','169.254.1.1','192.168.1.1','::1','fc00::1','2001:db8::1'])assert.equal(isPublicAddress(address),false,address);
  await assert.rejects(authorizeDestination('https://example.test/',{lookup:async()=>[{address:'127.0.0.1',family:4}]}),error=>error.code==='WEB_DESTINATION_BLOCKED');
});

test('URL canonicalization is deterministic and rejects unsafe schemes and credentials',()=>{
  assert.equal(canonicalizeUrl('HTTPS://Example.COM:443/a/?utm_source=x&x=1#part'),'https://example.com/a?x=1');
  assert.throws(()=>canonicalizeUrl('file:///etc/passwd'));
  assert.throws(()=>canonicalizeUrl('https://user:pass@example.com/'));
});

test('HTML reader honors document base URLs and ignores unsafe link schemes',()=>{
  const page=parseHtmlDocument('<head><base href="https://example.com/docs/"></head><main><a href="guide">Guide</a><a href="javascript:alert(1)">Bad</a></main>',{baseUrl:'https://example.com/root'});
  assert.deepEqual(page.links,[{href:'https://example.com/docs/guide',text:'Guide'}]);
});

test('extractor accepts structured JSON suffixes and reads XML documents',()=>{
  const json=extractDocument(Buffer.from('{"ok":true}'),{contentType:'application/problem+json'});
  assert.equal(json.text,'{"ok":true}');
  const xml=extractDocument(Buffer.from('<?xml version="1.0"?><feed><title>Release feed</title><entry><link href="https://example.com/r"/>Current release</entry></feed>'),{contentType:'application/atom+xml',url:'https://example.com/feed'});
  assert.match(xml.text,/Current release/u);
  assert.equal(xml.links[0]?.href,'https://example.com/r');
});

test('search parser retains snippets and does not let incidental challenge text hide valid results',()=>{
  const page={text:'Result title\nA precise current result with useful supporting context.\nA story discusses how sites verify you are human.',links:[{href:'https://example.com/result',text:'Result title'}]};
  const parsed=parseDuckDuckGoPage(page,{query:'precise current result'});
  assert.equal(parsed.outcome,'RESULTS');
  assert.match(parsed.results[0].snippet,/useful supporting context/u);
});

test('discovery retries one transient parser miss before declaring failure',async()=>{
  let calls=0;
  const adapter={id:'duckduckgo-html',async search(){calls+=1;return calls===1?{outcome:'PARSE_CHANGED',results:[],parserVersion:'fixture-v1'}:{outcome:'RESULTS',results:[{url:'https://example.com/result',title:'Recovered result',snippet:'Recovered after a transient parser miss.',engine:'fixture',engineRank:1}],parserVersion:'fixture-v1'};}};
  const service=createDiscoveryService({web:{},adapters:[adapter]});
  const result=await service.discover({useWeb:true,query:'recovery query',variants:['recovery query']});
  assert.equal(result.status,'success');
  assert.equal(calls,2);
  assert.equal(result.attempts.at(-1).recovery,true);
});

test('Wikimedia discovery remains an independent fallback when general search is unavailable',async()=>{
  const calls=[];
  const web={
    async fetch(url){calls.push(url);assert.match(url,/en\.wikipedia\.org\/w\/rest\.php\/v1\/search\/page/u);return{text:JSON.stringify({pages:[{title:'Bhutan',excerpt:'Bhutan is a country whose capital is Thimphu.'}]})};},
    async render(){throw new Error('general search must not be required after a Wikimedia result');},
  };
  const service=createDiscoveryService({web,preferences:{getAllSettings:async()=>({network:{}})}});
  const result=await service.discover({useWeb:true,query:'capital of Bhutan',variants:['capital of Bhutan'],claimClass:'general'});
  assert.equal(result.status,'success');
  assert.equal(result.candidates[0].url,'https://en.wikipedia.org/wiki/Bhutan');
  assert.equal(result.attempts[0].adapter,'wikipedia-rest');
  assert.equal(calls.length,1);

  const excluded=await service.discover({useWeb:true,query:'capital of Bhutan',variants:['capital of Bhutan'],claimClass:'general',excludeDomains:['wikipedia.org']});
  assert.equal(excluded.candidates.some(item=>item.displayDomain==='wikipedia.org'),false);
});

test('office-holder selection ignores ended, deprecated, and future statements',()=>{
  const entity={claims:{P1308:[statement('Q1',{rank:'preferred',end:'2025-01-01'}),statement('Q2',{rank:'deprecated'}),statement('Q3',{start:'2099-01-01'}),statement('Q4',{start:'2024-01-01'}),statement('Q5',{rank:'preferred',start:'2023-01-01',end:'2029-01-01'})]}};
  assert.equal(currentOfficeStatement(entity,{today:'2026-08-12'}).mainsnak.datavalue.value.id,'Q5');
});

test('typed current-office evidence ranks ahead of presentation pages',()=>{
  const candidates=[
    {url:'https://en.wikipedia.org/wiki/Prime_Minister_of_India',title:'Prime Minister of India',snippet:'Presentation page',engineRank:1},
    {url:'https://www.wikidata.org/wiki/Q192711',title:'Narendra Modi — Prime Minister of India',snippet:'Current holder',engineRank:2,timestampHint:new Date().toISOString(),structuredEvidence:{kind:'wikidata-current-office'}},
  ];
  const ranked=rankCandidates(candidates,{query:'prime minister of India',target:'India',claimClass:'current-office',freshness:'current'});
  assert.equal(ranked[0].url,'https://www.wikidata.org/wiki/Q192711');
});

test('page boundary avoids false challenge and loading matches in substantial articles',()=>{
  const body=`This article explains loading performance and security checks. ${'Reliable public information. '.repeat(180)}`;
  assert.equal(classifyPageContent({title:'Performance guide',text:body}).usable,true);
  assert.equal(classifyPageContent({title:'Verify you are human',text:'Security check'}).code,'WEB_CAPTCHA');
});

test('excerpt selection rejects pages with no significant overlap',()=>{
  const page={title:'Gardening',text:'Tomatoes need sunlight. Compost improves soil structure. Water plants carefully.'};
  assert.deepEqual(selectRelevantExcerpts(page,{question:'What is the current Node.js LTS release?',claims:[{text:'Node.js LTS release'}]}),[]);
});

test('structured office evidence is consumed as exact bounded evidence without rereading a presentation page',async()=>{
  let fetched=false;
  const reader=createPageReader({web:{fetch:async()=>{fetched=true;throw new Error('not expected');},render:async()=>{throw new Error('not expected');}},sourceOperations:{record:async()=>{}}});
  const page=await reader.read({url:'https://www.wikidata.org/wiki/Q123',title:'Person — Office',structuredEvidence:{kind:'wikidata-current-office',text:'A Person is the current president of Example.',officeId:'Q123',personId:'Q456',retrievedAt:'2026-08-12T00:00:00Z'}},{question:'Who is the current president of Example?',claims:[{text:'current president of Example'}]});
  assert.equal(fetched,false);
  assert.equal(page.mode,'structured-api');
  assert.equal(page.excerpts[0].exact,true);
});

test('official source roles recognize bounded news and release path segments',()=>{
  assert.equal(pageRoleFor({url:'https://agency.example/news/item',sourceProfile:{classIds:['official-primary']}}).kind,'official-overview');
  assert.equal(pageRoleFor({url:'https://project.example/releases/v1',sourceProfile:{classIds:['official-project']}}).kind,'primary-document');
  assert.equal(pageRoleFor({url:'https://project.example/releases-notes',sourceProfile:{classIds:['official-project']}}).kind,'official-overview');
});

test('direct reader strips unsafe request headers and referer on cross-origin redirects',async()=>{
  const calls=[];
  const requester=async(destination,options)=>{calls.push({url:destination.url.href,headers:{...options.headers}});if(calls.length===1)return{status:302,headers:{location:'https://other.test/final'},body:Buffer.alloc(0),bytes:0};return{status:200,headers:{'content-type':'text/plain'},body:Buffer.from('final text'),bytes:10};};
  const result=await directFetch('https://first.test/start',{lookup:publicLookup,requester,headers:{referer:'https://first.test/home','x-secret':'never-send','accept-language':'en'}});
  assert.equal(result.text,'final text');
  assert.equal(calls[0].headers['x-secret'],undefined);
  assert.equal(calls[1].headers.referer,undefined);
  assert.equal(calls[1].headers['accept-language'],'en');
});

test('expired Windows request deadlines fail before spawning curl',async()=>{
  let spawned=false;
  await assert.rejects(windowsCurlRequest({url:new URL('https://example.com/'),hostname:'example.com',port:443},{address:'93.184.216.34',family:4},{deadline:99,now:()=>100,maxBytes:1024,spawnImpl:()=>{spawned=true;}}),error=>error.code==='WEB_DEADLINE');
  assert.equal(spawned,false);
});

test('Windows response parser enforces a bounded header block',()=>{
  const body=Buffer.from(`HTTP/1.1 200 OK\r\nX-Large: ${'x'.repeat(80)}\r\n\r\nbody`,'latin1');
  assert.throws(()=>parseHeaderBlock(body,{maxHeaderBytes:64}),error=>error.code==='WEB_NATIVE_PROTOCOL');
});

test('IPv6 proxy addresses format without doubled brackets',()=>{
  assert.deepEqual(parseUpstreamProxy('socks5://[2001:db8::1]:1080'),{type:'socks5',host:'2001:db8::1',port:1080});
  assert.equal(formatUpstreamProxy({type:'socks5',host:'2001:db8::1',port:1080}),'socks5://[2001:db8::1]:1080');
});

test('SOCKS5 tunnel consumes the complete connect reply before exposing application bytes',async()=>{
  const proxy=net.createServer(socket=>{let phase=0;socket.on('data',chunk=>{if(phase===0){phase=1;socket.write(Buffer.from([5,0]));return;}if(phase===1){phase=2;socket.write(Buffer.concat([Buffer.from([5,0,0,1,127,0,0,1,0,80]),Buffer.from('HELLO')]));}});});
  await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
  const port=proxy.address().port;
  try{
    const socket=await connectThroughProxy(`socks5://127.0.0.1:${port}`,[{address:'93.184.216.34',family:4}],443,{timeoutMs:1000});
    const value=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('no payload')),1000);socket.once('data',chunk=>{clearTimeout(timer);resolve(chunk.toString('utf8'));});});
    assert.equal(value,'HELLO');socket.destroy();
  }finally{await new Promise(resolve=>proxy.close(resolve));}
});

test('renderer startup falls back to the next installed browser candidate',async()=>{
  const starts=[];
  const session={async start(candidate){starts.push(candidate.id);if(candidate.id==='broken')throw Object.assign(new Error('failed'),{code:'WEB_BROWSER_EXITED'});return{generation:1,cdp:{}};},async stop(){},async close(){}};
  const service=createWebService({preferences:{getAllSettings:async()=>({network:{}})},browserSession:session,detector:async()=>[{id:'broken',path:'a'},{id:'working',path:'b'}],renderer:async(_url,{session:active})=>({mode:'render',browser:starts.at(-1),active:Boolean(active)}),idleStopMs:0});
  try{assert.deepEqual(await service.render('https://example.com/'),{mode:'render',browser:'working',active:true});assert.deepEqual(starts,['broken','working']);}
  finally{await service.close();}
});
