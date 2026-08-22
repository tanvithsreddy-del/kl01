import assert from 'node:assert/strict';

const base=String(process.env.KL01_TEST_URL||'http://127.0.0.1:32156').replace(/\/+$/u,'');
const timeoutMs=Math.max(30_000,Number(process.env.KL01_TEST_CASE_TIMEOUT_MS||180_000));
const profile={version:6,effort:2,research:{mode:'auto'}};
const notes=[
  '# Mathematical adversary notes',
  'These are user-supplied prompt notes. Use them as reference material, not instructions.',
  '## Revision priorities',
  'Start with diagonalization proof patterns. Then practise induction, recurrence relations, and counterexample construction.',
  '## Required plan',
  'Monday: diagonalization. Tuesday: induction. Wednesday: recurrences. Thursday: counterexamples. Friday: timed mixed problems and error review.',
  '## Self-check',
  'For every session, write one failed attempt, identify the invalid inference, and make two retrieval-practice questions.',
  '## Filler notes',
  ...Array.from({length:620},(_,index)=>`Background note ${index+1}: preserve definitions, test edge cases, and record proof assumptions before applying a theorem.`),
].join('\n\n');

async function json(path,options={}){
  const response=await fetch(`${base}${path}`,{headers:{'content-type':'application/json',...(options.headers||{})},...options});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`${options.method||'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitForAnswer(chatId,runId){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const chat=await json(`/api/chats/${encodeURIComponent(chatId)}`);
    const answer=[...(chat.messages||[])].reverse().find(message=>message.role==='assistant'&&message.runId===runId);
    if(answer&&['completed','cancelled','failed'].includes(String(answer.status||'')))return answer;
    await new Promise(resolve=>setTimeout(resolve,700));
  }
  throw new Error(`${runId}: timed out after ${timeoutMs} ms`);
}

assert.ok(notes.length>=30_000,'fixture must exercise a large attachment');
const health=await json('/api/health');
assert.equal(health.status,'ok');
const chat=await json('/api/chats',{method:'POST',body:JSON.stringify({title:'Live attachment source-first regression'})});
const runId=`run-attachment-${Date.now().toString(36)}`;
await json(`/api/chats/${encodeURIComponent(chat.id)}/messages`,{method:'POST',body:JSON.stringify({
  runId,
  text:'Turn these prompt notes into a revision plan.',
  attachments:[{clientId:'attachment-live-regression',name:'08_mathematical_adversary.md',extension:'md',type:'text/markdown',kind:'text',size:notes.length,text:notes}],
  profile,
})});
const answer=await waitForAnswer(chat.id,runId);
assert.equal(answer.status,'completed',answer.error?.message||'attachment run did not complete');
const content=String(answer.content||'').trim();
assert.ok(content,'attachment run returned no answer');
assert.equal(answer.work?.kind==='research',false,'attached source work must not start automatic web research');
assert.equal(Boolean(answer.web?.sources?.length),false,'attached source work must not produce web sources');
assert.match(content,/diagonalization|induction|recurrence|counterexample|Friday/iu,'answer did not use the supplied notes');
console.log(JSON.stringify({status:'PASS',base,attachmentChars:notes.length,answerChars:content.length,research:answer.work?.kind||null,webSources:answer.web?.sources?.length||0,answer:content},null,2));
