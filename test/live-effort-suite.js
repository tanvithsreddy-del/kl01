import assert from 'node:assert/strict';

const base=String(process.env.KL01_TEST_URL||'http://127.0.0.1:32153').replace(/\/+$/u,'');
const timeoutMs=Math.max(60_000,Number(process.env.KL01_TEST_CASE_TIMEOUT_MS||600_000));

async function json(path,options={}){
  const response=await fetch(`${base}${path}`,{headers:{'content-type':'application/json',...(options.headers||{})},...options});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`${options.method||'GET'} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}

async function run(question,profile,label){
  const chat=await json('/api/chats',{method:'POST',body:JSON.stringify({title:`Effort smoke ${label}`})});
  const runId=`run-effort-${Date.now().toString(36)}-${label}`;
  await json(`/api/chats/${encodeURIComponent(chat.id)}/messages`,{method:'POST',body:JSON.stringify({runId,text:question,attachments:[],profile})});
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const current=await json(`/api/chats/${encodeURIComponent(chat.id)}`);
    const answer=[...(current.messages||[])].reverse().find(message=>message.role==='assistant'&&message.runId===runId);
    if(answer&&['completed','failed','cancelled'].includes(String(answer.status||'')))return{chat:current,answer};
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error(`${label}: timed out after ${timeoutMs} ms`);
}

const instant=await run('who is indias pm',{effort:0,research:{mode:'auto'}},'instant');
assert.equal(instant.answer.status,'completed');
assert.match(String(instant.answer.content||''),/Narendra Modi/iu);
assert.equal(instant.answer.executionProfile?.effort,0);
assert.equal(instant.answer.work?.kind,'research');

const offline=await run('What is photosynthesis?',{version:6,effort:3,research:{mode:'off'}},'offline');
assert.equal(offline.answer.status,'completed');
assert.equal(offline.answer.executionProfile?.effort,3);
assert.equal(offline.answer.executionProfile?.modeId,'standard');
assert.equal(offline.answer.executionProfile?.response?.thinking,'quick');
assert.equal(offline.answer.work??null,null);
assert.equal(offline.answer.web??null,null);

const deep=await run('who is indias pm',{version:6,effort:3,research:{mode:'auto'}},'deep');
assert.equal(deep.answer.status,'completed');
assert.match(String(deep.answer.content||''),/Narendra Modi/iu);
assert.equal(deep.answer.executionProfile?.effort,3);
assert.equal(deep.answer.executionProfile?.modeId,'standard');
assert.equal(deep.answer.workflow??null,null,'Deep must not fan out into a workflow');
assert.equal(deep.answer.work?.kind,'research');
assert.match(String(deep.answer.content||''),/\[1\][\s\S]*Sources/iu);
assert.ok(Array.isArray(deep.answer.web?.sources)&&deep.answer.web.sources.length>0);

console.log(JSON.stringify({status:'PASS',instant:{answer:instant.answer.content,work:instant.answer.work?.status},offline:{answer:offline.answer.content,effectiveMode:offline.answer.executionProfile?.modeId,thinking:offline.answer.executionProfile?.response?.thinking,work:offline.answer.work??null},deep:{answer:deep.answer.content,mode:deep.answer.executionProfile?.modeId,workflow:deep.answer.workflow??null,work:deep.answer.work?.status,pages:deep.answer.work?.counters?.read,queries:deep.answer.work?.counters?.queries}},null,2));
