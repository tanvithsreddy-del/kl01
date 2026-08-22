import { fail } from '../lib/errors.js';

export function createCancellationTree({signal=null,label='run'}={}){
  const root=new AbortController();const children=new Map();
  const abortFromParent=()=>root.abort(signal?.reason||fail('CANCELLED','You stopped this work.',499));
  if(signal?.aborted)abortFromParent();else signal?.addEventListener?.('abort',abortFromParent,{once:true});
  function child(id){const key=String(id);if(children.has(key))return children.get(key);const controller=new AbortController();const forward=()=>controller.abort(root.signal.reason||fail('CANCELLED','You stopped this work.',499));if(root.signal.aborted)forward();else root.signal.addEventListener('abort',forward,{once:true});const item={id:key,controller,signal:controller.signal,abort:reason=>controller.abort(reason||fail('CANCELLED','You stopped this step.',499)),dispose:()=>{root.signal.removeEventListener('abort',forward);children.delete(key);}};children.set(key,item);return item;}
  function abort(reason){if(!root.signal.aborted)root.abort(reason||fail('CANCELLED','You stopped this work.',499));for(const item of children.values())if(!item.signal.aborted)item.abort(root.signal.reason);}
  function close(){signal?.removeEventListener?.('abort',abortFromParent);for(const item of [...children.values()])item.dispose();}
  return{label,signal:root.signal,child,abort,close,size:()=>children.size};
}
