import { sampleProcessRss } from './process-memory.js';
export function createProcessRegistry({runtimePool}={}){
  async function snapshot(){const slots=runtimePool?.list?.()||[];const out=[];for(const slot of slots){const pid=Number(slot.process?.pid||slot.state?.pid||0)||null;const observed=await sampleProcessRss(pid);out.push({runtimeId:slot.runtimeId,targetId:slot.targetId,primary:Boolean(slot.primary),owners:[...(slot.owners||[])],state:slot.state?.status||'unknown',pid,observedRssBytes:observed.rssBytes,observedEstimated:observed.estimated,observedSource:observed.source,lastUsedAt:slot.lastUsedAt||null});}return out;}
  return{snapshot};
}
