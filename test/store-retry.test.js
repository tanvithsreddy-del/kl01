import assert from 'node:assert/strict';
import test from 'node:test';
import { retryTransientFileOperation } from '../server/services/store.js';

test('chat storage retries transient Windows file contention',async()=>{
  let attempts=0;
  const result=await retryTransientFileOperation(async()=>{attempts+=1;if(attempts<4)throw Object.assign(new Error('temporarily locked'),{code:'EPERM'});return'written';});
  assert.equal(result,'written');
  assert.equal(attempts,4);
});

test('chat storage does not retry permanent write failures',async()=>{
  let attempts=0;
  await assert.rejects(()=>retryTransientFileOperation(async()=>{attempts+=1;throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}),/disk full/u);
  assert.equal(attempts,1);
});
