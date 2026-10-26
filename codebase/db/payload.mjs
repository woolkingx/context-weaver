import { ErrorObject } from '../../common/lib/error-object.mjs';

export function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

// Reject an invalid payload before the target touches any state.
export function assertPayload({ target, method, errors }) {
  if (errors.length === 0) return;
  throw new ErrorObject({
    code: 'SCHEMA_VALIDATION_FAILED',
    message: `${target}.${method} payload is invalid: ${errors.join('; ')}`,
    context: { target, method, errors },
  });
}
