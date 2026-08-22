import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RUN_JOURNAL_SCHEMA, canonicalJson, sha256, validateArtifactEnvelope } from './contracts.js';
import { fail } from '../lib/errors.js';

const RUN_STATES=new Set(['created','preparing','running','waiting-for-user','stopping','interrupted-resumable','completed','cancelled','failed']);
function safeRunId(value=''){ return String(value).replace(/[^a-zA-Z0-9._-]/gu,'-').slice(0,120); }
function bodyForHash(value){ const { journalHash:_hash, ...rest } = value || {}; return rest; }
function hashValid(value){return Boolean(value&&value.runId&&value.journalHash===sha256(bodyForHash(value)));}
function validate(value){ return Boolean(value && value.schemaVersion===RUN_JOURNAL_SCHEMA && hashValid(value)); }
function snapshotValid(value){return Boolean(validate(value)&&RUN_STATES.has(String(value.state||''))&&Number.isInteger(Number(value.generation||1))&&Number(value.generation||1)>=1&&Number.isInteger(Number(value.sequence??value.lastSeq??0))&&Number(value.sequence??value.lastSeq??0)>=0&&Array.isArray(value.committedArtifactIds||[])&&value.nodeSnapshots&&typeof value.nodeSnapshots==='object'&&!Array.isArray(value.nodeSnapshots)&&Array.isArray(value.events||[]));}
const TRANSIENT_FILE_CODES=new Set(['EBUSY','EACCES','EPERM','EEXIST','ENOTEMPTY']);
async function retryTransient(operation){const waits=[0,12,35,80,180,350];let last;for(const wait of waits){if(wait)await delay(wait);try{return await operation();}catch(error){last=error;if(!TRANSIENT_FILE_CODES.has(error?.code))throw error;}}throw last;}

export function createRunJournal({ directory, retentionMs = 30 * 60 * 1000, fsImpl = fs } = {}) {
  const io=fsImpl;
  if (!directory) throw new Error('journal directory required');
  const quarantineDir=path.join(directory,'.quarantine');
  const fileFor = runId => path.join(directory, `${safeRunId(runId)}.json`);
  const artifactDirFor = runId => path.join(directory, `${safeRunId(runId)}.artifacts`);
  const artifactFileFor = (runId,artifactId) => path.join(artifactDirFor(runId), `${safeRunId(artifactId)}.json`);
  async function ensure(){ await io.mkdir(directory,{recursive:true}); }
  async function syncDirectory(dir){
    let handle=null;
    try{handle=await io.open(dir,'r');await handle.sync();}
    catch(error){if(!['EINVAL','ENOTSUP','EPERM','EACCES','EISDIR','EBADF'].includes(error?.code))throw error;}
    finally{await handle?.close().catch(()=>{});}
  }
  async function atomicWrite(file,value){
    await ensure();
    const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
    try{
      await io.mkdir(path.dirname(file),{recursive:true});
      const handle=await io.open(tmp,'w',0o600);
      try { await handle.writeFile(`${canonicalJson(value)}\n`,'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await retryTransient(()=>io.rename(tmp,file));
      await syncDirectory(path.dirname(file));
    }catch(error){await io.rm(tmp,{force:true}).catch(()=>{});throw error;}
  }
  async function quarantine(file,reason='corrupt'){
    await io.mkdir(quarantineDir,{recursive:true});
    const base=path.basename(file);const target=path.join(quarantineDir,`${base}.${Date.now()}.${safeRunId(reason)}`);
    try{await io.rename(file,target);return target;}catch(error){if(error?.code==='ENOENT')return null;throw error;}
  }
  async function write(snapshot){
    const body={ schemaVersion:RUN_JOURNAL_SCHEMA, ...structuredClone(snapshot), pid:process.pid, updatedAt:new Date().toISOString() };
    const value={...body,journalHash:sha256(body)};
    try { await atomicWrite(fileFor(body.runId),value); return value; }
    catch(error){ throw fail('RUN_JOURNAL_WRITE','KL01 could not checkpoint this work safely. The run was stopped to avoid losing or corrupting research.',507,{runId:body.runId,causeCode:error?.code||null},error); }
  }
  async function writeArtifact(runId,artifact){if(!validateArtifactEnvelope(artifact))throw fail('RUN_ARTIFACT_INVALID','A research artifact failed integrity validation before checkpoint.',500,{runId,artifactId:artifact?.artifactId||null});try{await io.mkdir(artifactDirFor(runId),{recursive:true});await atomicWrite(artifactFileFor(runId,artifact.artifactId),artifact);return artifact;}catch(error){throw fail('RUN_ARTIFACT_WRITE','KL01 could not checkpoint validated research safely. The run was stopped to avoid losing evidence.',507,{runId,artifactId:artifact.artifactId,causeCode:error?.code||null},error);}}
  async function readArtifact(runId,artifactId){let value;try{value=JSON.parse(await io.readFile(artifactFileFor(runId,artifactId),'utf8'));}catch(error){if(error?.code==='ENOENT')return null;throw fail('RUN_ARTIFACT_CORRUPT','Saved research evidence could not be read safely.',500,{runId,artifactId},error);}if(!validateArtifactEnvelope(value))throw fail('RUN_ARTIFACT_CORRUPT','Saved research evidence failed integrity validation.',500,{runId,artifactId});return value;}
  async function listArtifacts(runId){try{const dir=artifactDirFor(runId);const out=[];for(const name of await io.readdir(dir)){if(!name.endsWith('.json'))continue;const value=await readArtifact(runId,name.slice(0,-5));if(value)out.push(value);}return out;}catch(error){if(error?.code==='ENOENT')return[];throw error;}}
  async function recoverValidArtifacts(runId){
    const dir=artifactDirFor(runId);const valid=[];const rejected=[];let names=[];try{names=await io.readdir(dir);}catch(error){if(error?.code==='ENOENT')return{valid,rejected};throw error;}
    for(const name of names){if(!name.endsWith('.json'))continue;const file=path.join(dir,name);try{const value=JSON.parse(await io.readFile(file,'utf8'));if(validateArtifactEnvelope(value)){valid.push(value);continue;}const q=await quarantine(file,'artifact-hash');rejected.push({file:q||file,code:'RUN_ARTIFACT_HASH'});}catch{const q=await quarantine(file,'artifact-corrupt').catch(()=>null);rejected.push({file:q||file,code:'RUN_ARTIFACT_CORRUPT'});}}
    return{valid,rejected};
  }
  async function remove(runId){
    const journalFile=fileFor(runId);const artifactDir=artifactDirFor(runId);
    try{await io.rm(artifactDir,{recursive:true,force:true});}catch(error){throw fail('RUN_CLEANUP_FAIL','KL01 could not finish removing temporary work files. Cleanup will be retried.',507,{runId,part:'artifacts',causeCode:error?.code||error?.name||null},error);}
    try{await io.unlink(journalFile);}catch(error){if(error?.code!=='ENOENT')throw fail('RUN_CLEANUP_FAIL','KL01 could not finish removing the temporary work journal. Cleanup will be retried.',507,{runId,part:'journal',causeCode:error?.code||error?.name||null},error);}
    return true;
  }
  async function read(runId){
    let value;try{value=JSON.parse(await io.readFile(fileFor(runId),'utf8'));}catch(error){if(error?.code==='ENOENT')return null;throw fail('RUN_JOURNAL_CORRUPT','Saved active-work state could not be read safely.',500,{runId},error);}
    if(value?.schemaVersion!==RUN_JOURNAL_SCHEMA&&hashValid(value))throw fail('RUN_RECOVERY_SCHEMA','Saved work uses an unsupported recovery schema and will not be resumed.',409,{runId,schemaVersion:value?.schemaVersion||null});
    if(!validate(value))throw fail('RUN_JOURNAL_CORRUPT','Saved active-work state failed integrity validation.',500,{runId});
    if(!snapshotValid(value))throw fail('RUN_SNAPSHOT_CORRUPT','Saved active-work state has an invalid snapshot structure.',500,{runId});
    return value;
  }
  async function recover(){
    await ensure();const entries=[];const now=Date.now();const names=await io.readdir(directory);
    for(const name of names)if(name.endsWith('.tmp'))await io.rm(path.join(directory,name),{force:true}).catch(()=>{});
    for(const name of names){
      if(!name.endsWith('.json'))continue;const file=path.join(directory,name);let value=null;let runId=name.slice(0,-5);
      try{value=JSON.parse(await io.readFile(file,'utf8'));runId=value?.runId||runId;}catch{const recovered=await recoverValidArtifacts(runId).catch(()=>({valid:[],rejected:[]}));const q=await quarantine(file,'journal-parse').catch(()=>null);entries.push({runId,status:'corrupt',quarantinedFile:q||file,recoveredArtifacts:recovered.valid,rejectedArtifacts:recovered.rejected,minimalSnapshot:{runId,state:'interrupted-uncheckpointed',committedArtifactIds:recovered.valid.map(a=>a.artifactId)}});continue;}
      if(value?.schemaVersion!==RUN_JOURNAL_SCHEMA&&hashValid(value)){const recovered=await recoverValidArtifacts(runId).catch(()=>({valid:[],rejected:[]}));const q=await quarantine(file,'unsupported-schema').catch(()=>null);entries.push({runId,status:'unsupported-schema',schemaVersion:value?.schemaVersion||null,quarantinedFile:q||file,recoveredArtifacts:recovered.valid,minimalSnapshot:{runId,state:'interrupted-uncheckpointed',committedArtifactIds:recovered.valid.map(a=>a.artifactId)}});continue;}
      if(!validate(value)){const recovered=await recoverValidArtifacts(runId).catch(()=>({valid:[],rejected:[]}));const q=await quarantine(file,'journal-hash').catch(()=>null);entries.push({runId,status:'corrupt',quarantinedFile:q||file,recoveredArtifacts:recovered.valid,rejectedArtifacts:recovered.rejected,minimalSnapshot:{runId,state:'interrupted-uncheckpointed',committedArtifactIds:recovered.valid.map(a=>a.artifactId)}});continue;}
      if(!snapshotValid(value)){const recovered=await recoverValidArtifacts(runId).catch(()=>({valid:[],rejected:[]}));const q=await quarantine(file,'snapshot-corrupt').catch(()=>null);entries.push({runId,status:'snapshot-corrupt',quarantinedFile:q||file,recoveredArtifacts:recovered.valid,rejectedArtifacts:recovered.rejected,minimalSnapshot:{runId,state:'interrupted-uncheckpointed',committedArtifactIds:recovered.valid.map(a=>a.artifactId)}});continue;}
      const age=now-Date.parse(value.updatedAt||value.createdAt||0);
      if(Number.isFinite(age)&&age>retentionMs){try{await remove(value.runId);entries.push({runId:value.runId,status:'expired'});}catch(error){entries.push({...value,status:'cleanup-pending',cleanupError:{code:error?.code||'RUN_CLEANUP_FAIL',message:error?.publicMessage||error?.message}});}continue;}
      if(['completed','cancelled','failed'].includes(value.state)){try{await remove(value.runId);entries.push({runId:value.runId,status:value.state,cleanupRetried:true});}catch(error){entries.push({...value,status:'cleanup-pending',cleanupError:{code:error?.code||'RUN_CLEANUP_FAIL',message:error?.publicMessage||error?.message}});}continue;}
      entries.push({...value,state:'interrupted-resumable',recovered:true});
    }
    return entries;
  }
  async function purgeTerminal(){await ensure();const recovered=await recover();return recovered.filter(x=>['completed','cancelled','failed','expired'].includes(x.status)&&x.cleanupRetried!==false).length;}
  return {ensure,write,read,writeArtifact,readArtifact,listArtifacts,recoverValidArtifacts,remove,recover,purgeTerminal,fileFor,artifactDirFor,artifactFileFor,validate,snapshotValid,quarantine};
}
