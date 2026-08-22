function pipelineError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function ensureStage(stage, index) {
  if (!stage || typeof stage.name !== 'string' || !stage.name.trim()) throw pipelineError('PIPELINE_STAGE_SHAPE', `stage ${index + 1} needs a name`);
  if (typeof stage.run !== 'function') throw pipelineError('PIPELINE_STAGE_SHAPE', `stage ${stage.name} needs a run function`);
  const timeoutMs = stage.timeoutMs == null ? 30_000 : Number(stage.timeoutMs);
  const retries = stage.retries == null ? 0 : Number(stage.retries);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw pipelineError('PIPELINE_TIMEOUT_SHAPE', `stage ${stage.name} has an invalid timeout`);
  if (!Number.isInteger(retries) || retries < 0 || retries > 8) throw pipelineError('PIPELINE_RETRY_SHAPE', `stage ${stage.name} has an invalid retry count`);
  if (stage.failureResult != null && typeof stage.failureResult !== 'function') throw pipelineError('PIPELINE_STAGE_SHAPE', `stage ${stage.name} has an invalid failureResult handler`);
  return { ...stage, name: stage.name.trim(), timeoutMs, retries, continueOnError: Boolean(stage.continueOnError) };
}

async function withTimeout(work, timeoutMs, stageName, parentSignal = null) {
  let timer;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = pipelineError('PIPELINE_STAGE_TIMEOUT', `stage ${stageName} exceeded its ${timeoutMs} ms timeout`, { stage: stageName, timeoutMs });
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

function defaultState(context) {
  const existing = context.pipelineState && typeof context.pipelineState === 'object' ? context.pipelineState : {};
  existing.turnId ||= context.turnId || null;
  existing.status ||= 'ready';
  existing.stages ||= {};
  existing.order ||= [];
  context.pipelineState = existing;
  return existing;
}

async function loadState(context) {
  if (typeof context.loadPipelineState === 'function') {
    const loaded = await context.loadPipelineState(context.turnId);
    if (loaded) {
      context.pipelineState = structuredClone(loaded);
      context.pipelineState.stages ||= {};
      context.pipelineState.order ||= [];
      return context.pipelineState;
    }
  }
  return defaultState(context);
}

async function persist(context, state, record) {
  state.stages[record.stage] = structuredClone(record);
  if (!state.order.includes(record.stage)) state.order.push(record.stage);
  if (typeof context.persistStage === 'function') await context.persistStage(structuredClone(record), structuredClone(state));
}

async function persistPipelineStatus(context, state, status, details = {}) {
  state.status = status;
  state.updatedAt = new Date().toISOString();
  Object.assign(state, details);
  if (typeof context.persistPipelineStatus === 'function') await context.persistPipelineStatus(status, structuredClone(state));
}

function terminalStage(record) {
  return record?.status === 'completed' || record?.status === 'skipped';
}

function completedPrefix(stages, state) {
  let count = 0;
  for (const stage of stages) {
    const record = state.stages[stage.name];
    if (!terminalStage(record)) break;
    count += 1;
  }
  return count;
}

function skipResultFor(error, stage, stageContext) {
  if (stage.failureResult) return stage.failureResult(error, stageContext);
  return {
    skipped: true,
    reason: {
      code: error?.code || 'PIPELINE_STAGE_FAILED',
      sentence: error?.message || `stage ${stage.name} could not finish`,
    },
  };
}

/**
 * Run an ordered, resumable stage pipeline.
 * Stage output is durably persisted through context.persistStage before the next stage may start.
 * Stages may opt into continueOnError; such failures persist as skipped and the run continues.
 */
export async function runPipeline(stagesInput, context = {}, { onStage = () => {}, signal = null } = {}) {
  if (!Array.isArray(stagesInput) || stagesInput.length === 0) throw pipelineError('PIPELINE_EMPTY', 'pipeline requires at least one stage');
  const stages = stagesInput.map(ensureStage);
  if (new Set(stages.map(stage => stage.name)).size !== stages.length) throw pipelineError('PIPELINE_STAGE_DUPLICATE', 'pipeline stage names must be unique');
  const state = await loadState(context);
  const stageResults = { ...(context.stageResults || {}) };
  for (const stage of stages) {
    const saved = state.stages[stage.name];
    if (terminalStage(saved) && Object.hasOwn(saved, 'output')) stageResults[stage.name] = structuredClone(saved.output);
  }
  context.stageResults = stageResults;

  const resumeIndex = completedPrefix(stages, state);
  if (resumeIndex > 0) onStage({ type: 'resume', completed: resumeIndex, next: stages[resumeIndex]?.name || null });
  if (resumeIndex === stages.length) {
    await persistPipelineStatus(context, state, 'completed', { incomplete: false });
    return { status: 'completed', resumed: true, result: stageResults[stages.at(-1).name], stageResults: structuredClone(stageResults), state: structuredClone(state) };
  }

  await persistPipelineStatus(context, state, 'running', { incomplete: false });
  for (let index = resumeIndex; index < stages.length; index += 1) {
    const stage = stages[index];
    if (signal?.aborted) {
      await persistPipelineStatus(context, state, 'incomplete', { incomplete: true, stoppedBefore: stage.name, reason: 'cancelled-at-stage-boundary' });
      onStage({ type: 'cancelled', stage: stage.name, boundary: 'before' });
      return { status: 'incomplete', reason: 'cancelled', stoppedBefore: stage.name, stageResults: structuredClone(stageResults), state: structuredClone(state) };
    }

    let output;
    let lastError;
    let attempts = 0;
    onStage({ type: 'start', stage: stage.name, index, total: stages.length });
    for (let attempt = 0; attempt <= stage.retries; attempt += 1) {
      attempts = attempt + 1;
      const startedAt = new Date().toISOString();
      const stageContext = { ...context, stageResults, stage: stage.name, stageIndex: index, signal };
      try {
        output = await withTimeout(stageSignal => stage.run({ ...stageContext, signal: stageSignal }), stage.timeoutMs, stage.name, signal);
        const endedAt = new Date().toISOString();
        const status = output?.pipelineStatus === 'skipped' ? 'skipped' : 'completed';
        const record = {
          stage: stage.name,
          status,
          attempts,
          promptId: output?.promptId ?? stage.promptId ?? null,
          promptVersion: output?.promptVersion ?? stage.promptVersion ?? null,
          startedAt,
          endedAt,
          output: structuredClone(output),
        };
        await persist(context, state, record);
        stageResults[stage.name] = structuredClone(output);
        onStage({ type: status === 'skipped' ? 'skip' : 'complete', stage: stage.name, index, total: stages.length, attempts, reason: output?.reason || null });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const endedAt = new Date().toISOString();
        if (attempt < stage.retries) {
          onStage({ type: 'retry', stage: stage.name, attempt: attempts, code: error?.code || 'PIPELINE_STAGE_FAILED' });
          continue;
        }
        if (stage.continueOnError) {
          output = await skipResultFor(error, stage, stageContext);
          const record = {
            stage: stage.name,
            status: 'skipped',
            attempts,
            promptId: output?.promptId ?? stage.promptId ?? null,
            promptVersion: output?.promptVersion ?? stage.promptVersion ?? null,
            startedAt,
            endedAt,
            output: structuredClone(output),
            error: { code: error?.code || 'PIPELINE_STAGE_FAILED', message: error?.message || `stage ${stage.name} failed` },
          };
          await persist(context, state, record);
          stageResults[stage.name] = structuredClone(output);
          onStage({ type: 'skip', stage: stage.name, index, total: stages.length, attempts, reason: output?.reason || record.error });
          lastError = null;
          break;
        }
        const record = {
          stage: stage.name,
          status: 'failed',
          attempts,
          promptId: stage.promptId ?? null,
          promptVersion: stage.promptVersion ?? null,
          startedAt,
          endedAt,
          error: { code: error?.code || 'PIPELINE_STAGE_FAILED', message: error?.message || `stage ${stage.name} failed` },
        };
        await persist(context, state, record);
      }
    }
    if (lastError) {
      await persistPipelineStatus(context, state, 'incomplete', { incomplete: true, failedStage: stage.name, reason: lastError?.code || 'PIPELINE_STAGE_FAILED' });
      throw lastError;
    }

    if (signal?.aborted && index < stages.length - 1) {
      const next = stages[index + 1].name;
      await persistPipelineStatus(context, state, 'incomplete', { incomplete: true, stoppedBefore: next, reason: 'cancelled-at-stage-boundary' });
      onStage({ type: 'cancelled', stage: next, boundary: 'after', completed: stage.name });
      return { status: 'incomplete', reason: 'cancelled', stoppedBefore: next, stageResults: structuredClone(stageResults), state: structuredClone(state) };
    }
  }
  await persistPipelineStatus(context, state, 'completed', { incomplete: false, stoppedBefore: null, failedStage: null, reason: null });
  return { status: 'completed', resumed: resumeIndex > 0, result: stageResults[stages.at(-1).name], stageResults: structuredClone(stageResults), state: structuredClone(state) };
}
