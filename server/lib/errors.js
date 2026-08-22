import crypto from 'node:crypto';

export class KL01Error extends Error {
  constructor(code, publicMessage, status = 500, details = undefined, cause = undefined) {
    super(publicMessage, cause ? { cause } : undefined);
    this.name = 'KL01Error';
    this.code = code;
    this.publicMessage = publicMessage;
    this.status = status;
    this.details = details;
    this.referenceId = `ZK-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  }
}

export function fail(code, message, status = 500, details, cause) {
  return new KL01Error(code, message, status, details, cause);
}

export function normalizeError(error) {
  if (error instanceof KL01Error) return error;
  if (error?.name === 'AbortError') {
    return fail('CANCELLED', 'You stopped this response; keep the visible text or send the message again.', 499, undefined, error);
  }
  return fail('LOCAL_SERVER_FAILED', 'The local server could not finish this request; check that it is running, then retry.', 500, undefined, error);
}

export function publicError(error) {
  const e = normalizeError(error);
  return { code: e.code, message: e.publicMessage, referenceId: e.referenceId, ...(e.details ? { details: e.details } : {}) };
}
