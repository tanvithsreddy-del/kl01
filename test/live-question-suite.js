import assert from 'node:assert/strict';

const base=String(process.env.KL01_TEST_URL||'http://127.0.0.1:32152').replace(/\/+$/u,'');
const timeoutMs=Math.max(30_000,Number(process.env.KL01_TEST_CASE_TIMEOUT_MS||180_000));
const startIndex=Math.max(0,Number(process.env.KL01_TEST_START_INDEX||0));
const cases=[
  {question:'who is indias pm',expect:/Narendra Modi/iu,research:true},
  {question:'who is the current president of India',expect:/Droupadi Murmu/iu,research:true},
  {question:"who is the UK's current prime minister",expect:/\bcurrent\b/iu,research:true},
  {question:'who is the current president of France',expect:/\bcurrent\b/iu,research:true},
  {question:'who is the current president of the United States',expect:/\bcurrent\b/iu,research:true},
  {question:"who is Canada's current prime minister",expect:/\bcurrent\b/iu,research:true},
  {question:'who is the current president of Nigeria',expect:/\bcurrent\b/iu,research:true},
  {question:"who is Australia's current prime minister",expect:/\bcurrent\b/iu,research:true},
  {question:'who is the current president of Mexico',expect:/\bcurrent\b/iu,research:true},
  {question:"who is Singapore's current prime minister",expect:/\bcurrent\b/iu,research:true},
  {question:'Look up the current Node.js LTS release',expect:/Node\.js\s+24(?:\.11\.0)?|24\.11\.0/iu,reject:/26\.0\.0|\(Current\)/iu,research:true},
  {question:'Use Wikipedia to find when the Eiffel Tower was completed',expect:/1889/iu,reject:/sources disagree|could not verify/iu,research:true},
  {question:'Look up the capital of Bhutan',expect:/Thimphu/iu,research:true},
  {question:'What is 27 multiplied by 43?',expect:/1[,.]?161/u,research:false},
  {question:'Reply with exactly: local hello',expect:/^local hello$/u,exact:'local hello',research:false},
  {question:'When was the Jantar Mantar in Jaipur built?',expect:/17(?:2[789]|3[0-9])|18th\s+century/iu,reject:/1876/iu,research:true},
  {question:'No, Cockroach Janta Party — look it up and explain what it is.',expect:/satir|lazy|unemployed|political\s+movement/iu,research:true},
  {question:'What is photosynthesis?',expect:/\b(?:process|conversion|converts?)\b.{0,120}\b(?:light|energy|carbon\s+dioxide)\b|\b(?:light|energy|carbon\s+dioxide)\b.{0,120}\b(?:process|conversion|converts?)\b/iu,research:true},
  {question:'Explain the difference between mass and weight.',expect:/force|gravity|amount\s+of\s+matter|kilogram|newton/iu,research:true},
  {question:'Write a four-line poem about a quiet library.',expect:/\S+/u,minLines:4,research:false},
];
const endIndex=Math.min(cases.length,Math.max(startIndex,Number(process.env.KL01_TEST_END_INDEX||cases.length)));

async function json(path,options={}){
  const response=await fetch(`${base}${path}`,{headers:{'content-type':'application/json',...(options.headers||{})},...options});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`${options.method||'GET'} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function waitForAnswer(chatId,runId){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const chat=await json(`/api/chats/${encodeURIComponent(chatId)}`);
    const answer=[...(chat.messages||[])].reverse().find(message=>message.role==='assistant'&&message.runId===runId);
    if(answer&&['completed','cancelled','failed'].includes(String(answer.status||'')))return answer;
    const snapshot=await json(`/api/runs/${encodeURIComponent(runId)}`).catch(()=>null);
    if(snapshot?.run&&['cancelled','failed'].includes(String(snapshot.run.state||'')))throw new Error(`${runId}: ${snapshot.run.state} ${snapshot.run.error?.message||''}`);
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error(`${runId}: timed out after ${timeoutMs} ms`);
}

const report=[];
for(let index=startIndex;index<endIndex;index+=1){
  const item=cases[index];const started=Date.now();
  const chat=await json('/api/chats',{method:'POST',body:JSON.stringify({title:`Live question ${index+1}`})});
  const runId=`run-liveq-${Date.now().toString(36)}-${index.toString(36).padStart(2,'0')}`;
  await json(`/api/chats/${encodeURIComponent(chat.id)}/messages`,{method:'POST',body:JSON.stringify({runId,text:item.question,attachments:[]})});
  const answer=await waitForAnswer(chat.id,runId);
  const row={
    index:index+1,question:item.question,status:answer.status,answer:String(answer.content||''),
    research:Boolean(answer.work?.kind==='research'),workStatus:answer.work?.status||null,
    pages:Number(answer.work?.counters?.read||0),claimsSupported:Number(answer.work?.counters?.claimsSupported||0),
    claimsTotal:Number(answer.work?.counters?.claimsTotal||0),modelInputTokens:Number(answer.work?.telemetry?.modelInputTokens||0),
    modelOutputTokens:Number(answer.work?.telemetry?.modelOutputTokens||0),durationMs:Date.now()-started,
  };
  assert.equal(row.status,'completed',`${item.question}: ${row.status}`);
  assert.match(row.answer,item.expect,item.question);
  if(item.exact!=null)assert.equal(row.answer.trim(),item.exact,item.question);
  if(item.reject)assert.doesNotMatch(row.answer,item.reject,item.question);
  if(item.minLines)assert.ok(row.answer.split(/\r?\n/u).filter(line=>line.trim()).length>=item.minLines,`${item.question}: expected ${item.minLines} lines`);
  assert.equal(row.research,item.research,`${item.question}: research=${row.research}`);
  if(item.research){assert.ok(Array.isArray(answer.web?.sources)&&answer.web.sources.length>0,`${item.question}: no sources`);assert.doesNotMatch(row.answer,/I could not verify|could not include enough verified evidence/iu,item.question);}
  report.push(row);console.log(JSON.stringify(row));
}
console.log(JSON.stringify({status:'PASS',base,cases:report.length,totalDurationMs:report.reduce((sum,row)=>sum+row.durationMs,0),report},null,2));
