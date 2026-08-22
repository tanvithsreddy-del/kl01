import assert from 'node:assert/strict';
import { createWebService } from '../server/web/service.js';
import { createDiscoveryService } from '../server/web/discovery.js';
import { createPageReader } from '../server/research/page-reader.js';

const preferences={getAllSettings:async()=>({network:{proxy:null,discoveryEndpoint:null}})};
const web=createWebService({preferences,idleStopMs:0});
const discovery=createDiscoveryService({web,preferences});
const report=[];
let officeCandidate=null;
try{
  const cases=[
    {query:'Node.js current LTS',claimClass:'software-latest',freshness:'current',strategy:'balanced'},
    {query:'president of India',claimClass:'current-office',target:'India',officeRole:'president',freshness:'current',strategy:'source-first'},
    {query:'OpenAI latest model release',claimClass:'news-current',freshness:'current',strategy:'diverse'},
  ];
  for(const item of cases){const started=performance.now();const result=await discovery.discover({useWeb:true,variants:[item.query],...item},{maxResults:8,complementary:true});assert.equal(result.status,'success',`${item.query}: ${result.reason}`);assert.ok(result.candidates.length>=2,item.query);if(item.claimClass==='current-office'){officeCandidate=result.candidates.find(candidate=>candidate.structuredEvidence);assert.ok(officeCandidate?.structuredEvidence?.officeId);assert.ok(officeCandidate?.structuredEvidence?.personId);}report.push({kind:'discovery',query:item.query,candidates:result.candidates.length,engines:[...new Set(result.candidates.map(x=>x.engine))],attempts:result.attempts.map(x=>({adapter:x.adapter,outcome:x.outcome,durationMs:x.durationMs,recovery:x.recovery||false})),durationMs:Math.round(performance.now()-started)});}
  const reader=createPageReader({web,sourceOperations:{record:async()=>{}}});
  const structured=await reader.read(officeCandidate,{question:'Who is the current president of India?',claims:[{text:'current president of India'}]});assert.equal(structured.status,'usable');assert.equal(structured.mode,'structured-api');report.push({kind:'structured-office',title:structured.title,officeId:structured.structuredEvidence.officeId,personId:structured.structuredEvidence.personId,mode:structured.mode});
  const started=performance.now();const page=await reader.read({url:'https://nodejs.org/en/download',title:'Download Node.js'},{question:'What is the current Node.js LTS release?',claims:[{text:'current Node.js LTS release'}]});assert.equal(page.status,'usable');assert.ok(page.excerpts.length>0);report.push({kind:'read',url:page.url,mode:page.mode,title:page.title,textChars:page.textChars,excerpts:page.excerpts.length,durationMs:Math.round(performance.now()-started)});
  const renderStarted=performance.now();const rendered=await web.render('https://example.com/',{timeoutMs:10_000});assert.equal(rendered.title,'Example Domain');assert.equal(rendered.browserContextIsolated,true);report.push({kind:'render',url:rendered.url,title:rendered.title,requests:rendered.requests,bytes:rendered.bytes,durationMs:Math.round(performance.now()-renderStarted)});
  console.log(JSON.stringify({status:'PASS',report},null,2));
}finally{await web.close();}
