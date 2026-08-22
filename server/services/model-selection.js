import * as externalServices from './services.js';
import { addModelMarker, getChat } from './chats.js';
import { clearActiveModel, getInstalled, getSettings, setModelPreference } from './installed.js';
import { fail } from '../lib/errors.js';

// Restarting is deliberately a local-only operation. Keeping the small
// controller separate makes the no-external-side-effects and duplicate-click
// guarantees explicit and independently testable.
export function createLocalRestartController({ runtime, preferenceTarget, getInstalled, governor = null, schedulePublish = async () => {} } = {}) {
  let pending = null;
  async function restart() {
    if (pending) return pending;
    pending = (async () => {
      const target = await preferenceTarget();
      if (!target || target.kind !== 'local') throw fail('LOCAL_MODEL_NOT_SELECTED', 'Select a local model before restarting the AI.', 409);
      const current = runtime.getState();
      if (current.modelId && Number(governor?.reservationCount?.(`local:${current.modelId}`) || 0) > 0) {
        throw fail('MODEL_RESERVED', 'A response is using this model; stop that response before restarting the AI.', 409, { modelId: current.modelId });
      }
      const model = await getInstalled(target.id);
      if (model?.pendingRemoval) throw fail('MODEL_UNINSTALL_PENDING', 'This model is being removed and cannot restart.', 409, { modelId: target.id });
      const result = await runtime.activate(target.id, { persistSelection: false });
      await schedulePublish();
      return {
        ...result,
        selectedTarget: target,
        restart: { status: 'restarted', modelId: target.id },
      };
    })();
    try { return await pending; } finally { pending = null; }
  }
  return { restart, isBusy: () => Boolean(pending) };
}

export function createModelSelectionService({runtime,governor=null}){
  const listeners=new Set();let lastSignature=null;let publishQueue=Promise.resolve();
  async function preferenceTarget(){
    const settings=await getSettings();
    if(settings.activeServiceId){const svc=await externalServices.listServices().then(list=>list.find(s=>s.id===settings.activeServiceId));return svc?{kind:'external',id:svc.id,name:svc.name,model:svc.model,targetId:`external:${svc.id}`}:null;}
    if(settings.activeModelId){const model=await getInstalled(settings.activeModelId).catch(()=>null);return model?{kind:'local',id:model.id,name:model.displayName||model.id,targetId:`local:${model.id}`}:null;}
    return null;
  }
  async function runtimeState(){
    const preference=await preferenceTarget();const actual=runtime.getState();
    if(preference?.kind==='external')return{status:'external-ready',modelId:null,modelName:preference.model,baseUrl:null,port:null,contextSize:(await externalServices.getService(preference.id)).contextSize||null,failure:null,service:await externalServices.getActiveServicePublic(),selectedTarget:preference,actualRuntime:actual};
    if(preference?.kind==='local'){
      if(actual.modelId===preference.id)return{...actual,selectedTarget:preference,actualRuntime:actual};
      return{status:'selected-pending',modelId:preference.id,modelName:preference.name,baseUrl:null,port:null,contextSize:null,failure:null,selectedTarget:preference,actualRuntime:actual,deferredReason:actual.modelId&&governor?.reservationCount?.(`local:${actual.modelId}`)>0?'active-run-owns-runtime':'not-loaded'};
    }
    return{...actual,status:actual.status==='ready'?'runtime-unselected':actual.status,selectedTarget:null,actualRuntime:actual};
  }
  async function publish(){const next=await runtimeState();const signature=JSON.stringify(next);if(signature===lastSignature)return false;lastSignature=signature;for(const listener of listeners)listener(structuredClone(next));return true;}
  function schedulePublish(){publishQueue=publishQueue.then(publish,publish);return publishQueue;}
  const unsubscribeRuntime=runtime.subscribe(()=>{schedulePublish();});
  function subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}
  async function list(){return{services:await externalServices.listServices(),active:await externalServices.getActiveServicePublic(),selected:await preferenceTarget()};}
  async function save(input){const result=await externalServices.saveService(input);await schedulePublish();return result;}
  async function remove(id){const result=await externalServices.removeService(id);await schedulePublish();return result;}
  async function markerIfChanged(chatId,before,after){if(!chatId||!after?.id||(before?.kind===after.kind&&before?.id===after.id))return null;const chat=await getChat(chatId).catch(()=>null);if(!chat?.messages?.length)return null;return addModelMarker(chatId,after);}
  async function currentTarget(){return preferenceTarget();}
  async function activateLocal(id,chatId=null){
    const model=await getInstalled(id);if(model.pendingRemoval)throw fail('MODEL_UNINSTALL_PENDING','This model is being removed and cannot start new work.',409,{modelId:id});const before=await preferenceTarget();await externalServices.deactivateService();await setModelPreference(id);const state=runtime.getState();const owned=state.modelId?Number(governor?.reservationCount?.(`local:${state.modelId}`)||0)>0:false;let result;
    if(state.modelId===id&&state.status==='ready')result=state;else if(owned)result={...state,status:'selected-pending',selectedModelId:id,preferenceDeferred:true};else result=await runtime.activate(id,{persistSelection:false});
    const after={kind:'local',id,name:model.displayName||id,targetId:`local:${id}`};await markerIfChanged(chatId,before,after);await schedulePublish();return{...result,selectedTarget:after};
  }
  async function activateExternal(id,chatId=null){const before=await preferenceTarget();const result=await externalServices.activateService(id);const active=await externalServices.getActiveServicePublic();const after=active?{kind:'external',id:active.id,name:active.name,model:active.model,targetId:`external:${active.id}`}:null;const state=runtime.getState();if(state.modelId&&Number(governor?.reservationCount?.(`local:${state.modelId}`)||0)===0)await runtime.stop();await markerIfChanged(chatId,before,after);await schedulePublish();return{...result,selectedTarget:after};}
  async function stop(){const state=runtime.getState();if(state.modelId&&Number(governor?.reservationCount?.(`local:${state.modelId}`)||0)>0)throw fail('MODEL_RESERVED','Another active run owns this model process; stop that run first.',409,{modelId:state.modelId});await externalServices.deactivateService();const result=await runtime.stop();await schedulePublish();return result;}
  async function deselectLocal(id=null){if(id)await getInstalled(id);const state=runtime.getState();await clearActiveModel(id);if((!id||state.modelId===id)&&Number(governor?.reservationCount?.(`local:${state.modelId}`)||0)===0)await runtime.stop();await schedulePublish();return{status:'deselected',modelId:id||state.modelId||null,deferred:Boolean(state.modelId&&Number(governor?.reservationCount?.(`local:${state.modelId}`)||0)>0)};}
  async function restoreTarget(target){if(!target){await externalServices.deactivateService();await clearActiveModel();await schedulePublish();return runtimeState();}if(target.kind==='external')return activateExternal(target.id);if(target.kind==='local')return activateLocal(target.id);return runtimeState();}
  const localRestart = createLocalRestartController({ runtime, preferenceTarget, getInstalled, governor, schedulePublish });
  function close(){unsubscribeRuntime();listeners.clear();}
  return{list,save,remove,activateLocal,activateExternal,currentTarget,preferenceTarget,runtimeState,subscribe,stop,deselectLocal,restoreTarget,restartLocal:localRestart.restart,close};
}
