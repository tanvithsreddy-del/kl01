import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const base=String(process.env.KL01_TEST_URL||'http://127.0.0.1:32160').replace(/\/+$/u,'');
const timeoutMs=Math.max(30_000,Number(process.env.KL01_TEST_CASE_TIMEOUT_MS||240_000));
const modelId=String(process.env.KL01_TEST_MODEL_ID||'balanced');
const bookPath=String(process.env.KL01_TEST_BOOK||'').trim();
const profile={version:6,effort:2,research:{mode:'auto'}};

if(!bookPath)throw new Error('Set KL01_TEST_BOOK to a real plain-text or Markdown engineering textbook.');
const book=await fs.readFile(bookPath,'utf8');
assert.ok(book.length>250_000,'the live textbook must be a genuinely large document');

async function json(route,options={}){
  const response=await fetch(`${base}${route}`,{headers:{'content-type':'application/json',...(options.headers||{})},...options});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`${options.method||'GET'} ${route}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function waitForAnswer(chatId,runId){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const chat=await json(`/api/chats/${encodeURIComponent(chatId)}`);
    const answer=[...(chat.messages||[])].reverse().find(message=>message.role==='assistant'&&message.runId===runId);
    if(answer&&['completed','cancelled','failed'].includes(String(answer.status||'')))return answer;
    await new Promise(resolve=>setTimeout(resolve,800));
  }
  throw new Error(`${runId}: timed out after ${timeoutMs} ms`);
}
async function ask(chatId,index,text,attachments=[]){
  const runId=`run-student-doc-${Date.now().toString(36)}-${index}`;
  const started=Date.now();
  await json(`/api/chats/${encodeURIComponent(chatId)}/messages`,{method:'POST',body:JSON.stringify({runId,text,attachments,profile})});
  const answer=await waitForAnswer(chatId,runId);
  return {index,text,runId,durationMs:Date.now()-started,answer};
}

await json(`/api/models/${encodeURIComponent(modelId)}/activate`,{method:'POST',body:'{}'});
const chat=await json('/api/chats',{method:'POST',body:JSON.stringify({title:`Real textbook · ${modelId}`})});
const attachment={clientId:`book-${Date.now().toString(36)}`,name:path.basename(bookPath),extension:'txt',type:'text/plain',kind:'text',size:Buffer.byteLength(book),text:book};
const cases=[
  {text:"According to this textbook, explain Ohm's law simply and include the relationship between current, voltage, and resistance. Use the attached textbook only.",attachments:[attachment],expect:/current|ampere/iu,also:/resistance|ohm/iu,reject:/100\s+lamps|61\.11|divided circuits?|magnetic flux|eddy currents?/iu,maxWords:220},
  {text:'Why does resistance reduce the current? Explain that same textbook section like I am a first-year student.',expect:/resistance|opposition|current/iu,reject:/100\s+lamps|61\.11|eddy currents?|magnetic|dynamo|pole pieces?|requires more energy/iu},
  {text:'Find the question that asks what a watt is. Answer it in two short sentences.',expect:/watt/iu,also:/(?:power due|ampere[\s\S]{0,80}volt)/iu,reject:/watt-hour|electrical consumption/iu},
  {text:'bhai primary cell ka depolarizer kya karta hai? book se simple bata',expect:/hydrogen/iu,also:/polari[sz]ation/iu,reject:/(?:depolarizer\s+(?:is|means)\s+(?:the\s+)?electrolyte|zinc\s+in\s+acid|hydrogen\s+ions)/iu,maxWords:120},
  {text:'Make a compact three-day revision plan from this book for electric current, resistance, and energy. Include one self-test question per day.',expect:/day\s*1|first\s+day/iu,also:/day\s*3|third\s+day/iu,threeDayPlan:true,maxWords:260},
];
const report=[];
for(const [index,item] of cases.entries()){
  const row=await ask(chat.id,index+1,item.text,item.attachments||[]);
  const answer=String(row.answer.content||'').trim();
  assert.equal(row.answer.status,'completed',row.answer.error?.message||item.text);
  assert.ok(answer,item.text);
  assert.match(answer,item.expect,item.text);
  if(item.also)assert.match(answer,item.also,item.text);
  if(item.reject)assert.doesNotMatch(answer,item.reject,item.text);
  const words=(answer.match(/[\p{L}\p{N}]+/gu)||[]).length;
  if(item.maxWords)assert.ok(words<=item.maxWords,`${item.text}: ${words} words exceeds ${item.maxWords}`);
  if(item.threeDayPlan){assert.match(answer,/resistance/iu,item.text);assert.match(answer,/energy/iu,item.text);assert.ok((answer.match(/self[- ]test/giu)||[]).length>=3,`${item.text}: fewer than three self-tests`);assert.match(answer.trim(),/[.!?…)]$/u,`${item.text}: answer ended mid-sentence`);}
  assert.equal(row.answer.work?.kind==='research',false,`${item.text}: local textbook question incorrectly started web research`);
  assert.equal(Boolean(row.answer.web?.sources?.length),false,`${item.text}: local textbook question used web sources`);
  assert.ok(Array.isArray(row.answer.documentContext?.documents)&&row.answer.documentContext.documents.length===1,`${item.text}: no persisted local document context`);
  report.push({index:index+1,question:item.text,status:row.answer.status,durationMs:row.durationMs,answer,documents:row.answer.documentContext.documents.map(doc=>doc.name),excerpts:row.answer.documentContext.selection?.length||0});
  console.log(JSON.stringify(report.at(-1)));
}
const documents=await json(`/api/chats/${encodeURIComponent(chat.id)}/documents`);
assert.equal(documents.documents.length,1,'the textbook should be stored once for this chat');
assert.equal(documents.documents[0].name,path.basename(bookPath));
console.log(JSON.stringify({status:'PASS',base,modelId,book:{path:bookPath,chars:book.length,bytes:Buffer.byteLength(book)},chatId:chat.id,documents:documents.documents,report},null,2));
