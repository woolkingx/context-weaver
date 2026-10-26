import { ERROR_CODES, getRecoveryHint } from './error-registry.mjs';

/** Shared structured error contract for common and runtime layers. */
export class ErrorObject extends Error {
  constructor({
    code, message, cause = null, stack = null, context = {},
  }) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ErrorObject';
    this.code = code || ERROR_CODES.UNKNOWN_ERROR;
    this.cause = cause;
    this.stack = stack || cause?.stack || this.stack;
    this.context = { ...context, stack: stack || this.stack };
    this.recovery_hint = getRecoveryHint(this.code);
    this.timestamp = new Date().toISOString();
    this.severity = 'error';
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      timestamp: this.timestamp,
      severity: this.severity,
      context: this.context,
      recovery_hint: this.recovery_hint,
      ...(this.cause ? { cause: this.cause.message } : {}),
    };
  }

  format(format = 'md') {
    return format === 'json' ? JSON.stringify(this.toJSON()) : this.message;
  }
}

export function createError(code, message, { cause = null, context = {} } = {}) {
  if (!Object.hasOwn(ERROR_CODES, code)) throw new Error(`Invalid error code: ${code}`);
  return new ErrorObject({
    code, message, cause, context,
  });
}

export default ErrorObject;
