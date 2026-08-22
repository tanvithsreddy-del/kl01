import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRunJournal } from '../server/research/journal.js';

test('run journal retries transient Windows rename contention',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'kl01-journal-retry-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let renames=0;
  const io={...fs,rename:async(...args)=>{renames+=1;if(renames<3)throw Object.assign(new Error('file temporarily locked'),{code:'EPERM'});return fs.rename(...args);}};
  const journal=createRunJournal({directory:root,fsImpl:io});
  await journal.write({runId:'run-retry-test',state:'running',generation:1,sequence:0,committedArtifactIds:[],nodeSnapshots:{},events:[]});
  assert.equal(renames,3);
  assert.equal((await journal.read('run-retry-test')).state,'running');
});
