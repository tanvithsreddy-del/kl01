import { loadCatalogue } from '../services/catalogue.js';
import { listInstalled, getSettings } from '../services/installed.js';
import * as services from '../services/services.js';
import { inspectMachine } from '../services/machine.js';
import { localDescriptor, externalDescriptor, compatibility } from './target-descriptor.js';
import { fail } from '../lib/errors.js';

export function createTargetRegistry({runtimePool,governor,machineSampler=inspectMachine}={}){
  async function descriptors(){
    const [catalogue,installed,externals,machine]=await Promise.all([loadCatalogue(),listInstalled(),services.listServices(),machineSampler().catch(()=>null)]);
    const entries=new Map((catalogue.entries||[]).map(e=>[e.id,e]));const slots=runtimePool?.list?.()||[];
    const locals=installed.map(record=>{const slot=slots.find(s=>s.targetId===`local:${record.id}`);return localDescriptor({record,catalogueEntry:entries.get(record.id)||null,runtimeState:slot?.state||null,reservations:governor?.reservationCount?.(`local:${record.id}`)||0,machine});});
    const remote=externals.map(service=>externalDescriptor({service,reservations:governor?.reservationCount?.(`external:${service.id}`)||0}));
    return[...locals,...remote];
  }
  async function get(targetId){const all=await descriptors();const found=all.find(d=>d.targetId===String(targetId||''));if(!found)throw fail('WORKFLOW_TARGET_MISSING','A model selected for this work is no longer available.',409,{targetId});return found;}
  async function preference(){const settings=await getSettings();if(settings.activeServiceId)return get(`external:${settings.activeServiceId}`).catch(()=>null);if(settings.activeModelId)return get(`local:${settings.activeModelId}`).catch(()=>null);const all=await descriptors();return all.length===1?all[0]:null;}
  async function compatible(requirements={}){return(await descriptors()).filter(d=>compatibility(d,requirements).ok);}
  return{descriptors,get,preference,compatible};
}
