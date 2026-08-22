import { compatibility } from './target-descriptor.js';

export function fallbackCandidates({requested,descriptors,requirements={},externalChain=[]}={}){
  const chain=new Set((externalChain||[]).map(String));
  return (descriptors||[]).filter(d=>d.targetId!==requested?.targetId).filter(d=>{
    if(!compatibility(d,requirements).ok)return false;
    if(d.kind==='external'&&requested?.kind==='local'&&!chain.has(d.targetId)&&!chain.has(d.id))return false;
    if(requested?.kind==='external'&&d.kind==='external'&&!chain.has(d.targetId)&&!chain.has(d.id))return false;
    return true;
  }).sort((a,b)=>{
    const ak=a.kind==='local'?0:1,bk=b.kind==='local'?0:1;if(ak!==bk)return ak-bk;
    const am=Number(a.resources?.estimatedWorkingSetBytes||0),bm=Number(b.resources?.estimatedWorkingSetBytes||0);
    if(requested?.kind==='local'){
      const rm=Number(requested.resources?.estimatedWorkingSetBytes||0);const al=am>0&&am<rm?0:1,bl=bm>0&&bm<rm?0:1;if(al!==bl)return al-bl;
    }
    return am-bm||String(a.targetId).localeCompare(String(b.targetId));
  });
}

export function fallbackRecord({requested,selected,reason,owner}={}){return{version:1,type:'FallbackArtifact',requestedTargetId:requested?.targetId||null,selectedTargetId:selected?.targetId||null,reason:reason?.code||String(reason||'fallback'),owner:structuredClone(owner||{}),at:new Date().toISOString(),message:`${requested?.name||'Requested model'} could not continue · using ${selected?.name||'a compatible fallback'}`};}
