import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunCoordinator } from '../server/services/run-coordinator.js';

function journalThatFailsCleanup({writeFails=false}={}){
  return {
    recover:async()=>[],
    write:async()=>{if(writeFails)throw Object.assign(new Error('locked journal'),{code:'EBUSY'});},
    remove:async()=>{throw Object.assign(new Error('locked cleanup'),{code:'EBUSY'});},
    writeArtifact:async()=>{},readArtifact:async()=>null,listArtifacts:async()=>[],
  };
}

test('terminal run cleanup failure cannot turn completed work into a failed run',async()=>{
  const coordinator=createRunCoordinator({journal:journalThatFailsCleanup()});
  const run=coordinator.create({runId:'run-cleanup-test',chatId:'chat-cleanup'});
  coordinator.transition(run.runId,'preparing');
  coordinator.transition(run.runId,'running');
  coordinator.transition(run.runId,'completed');
  const result=await coordinator.finalize(run.runId,'completed');
  assert.equal(result.status,'cleanup-pending');
  assert.equal(coordinator.get(run.runId).state,'completed');
  assert.equal(coordinator.activeForChat('chat-cleanup'),null);
});

test('terminal journal write failure also preserves the completed state',async()=>{
  const coordinator=createRunCoordinator({journal:journalThatFailsCleanup({writeFails:true})});
  const run=coordinator.create({runId:'run-write-test',chatId:'chat-write'});
  coordinator.transition(run.runId,'preparing');
  coordinator.transition(run.runId,'running');
  coordinator.transition(run.runId,'completed');
  const result=await coordinator.finalize(run.runId,'completed');
  assert.equal(result.status,'cleanup-pending');
  assert.equal(coordinator.get(run.runId).state,'completed');
});
