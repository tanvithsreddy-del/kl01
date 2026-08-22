export async function probeRuntimeCapabilities(baseUrl,{fallbackContext=0,requestedParallel=1,fetchImpl=globalThis.fetch,timeoutMs=1500}={}){
  let properties={};let propsAvailable=false;
  try{
    const signal=typeof AbortSignal?.timeout==='function'?AbortSignal.timeout(Math.max(100,Number(timeoutMs||1500))):undefined;
    const response=await fetchImpl(`${String(baseUrl).replace(/\/$/u,'')}/props`,{signal});
    if(response?.ok){properties=await response.json();propsAvailable=true;}
  }catch{}
  const contextSize=Number(properties?.default_generation_settings?.n_ctx||properties?.n_ctx||fallbackContext||0);
  const reportedParallel=Number(properties?.n_parallel||properties?.parallel||properties?.default_generation_settings?.n_parallel||0);
  const wanted=Math.max(1,Math.floor(Number(requestedParallel||1)));
  const parallelVerified=wanted>1&&reportedParallel>=wanted;
  return{properties,propsAvailable,contextSize,parallelCapacity:parallelVerified?wanted:1,parallelVerified,reportedParallel:Number.isFinite(reportedParallel)?reportedParallel:0};
}
