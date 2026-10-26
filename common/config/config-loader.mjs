import { readFileSync } from 'node:fs';
import { ConfigOwner } from './ConfigOwner.mjs';

export { ConfigOwner };
export function defaultConfig({ schemaPath } = {}) {
  return JSON.parse(readFileSync(schemaPath ?? new URL('./config.schema.json', import.meta.url), 'utf8'));
}
export function configError(code, source, filePath, errors) {
  const detail = Array.isArray(errors) ? errors.join('; ') : String(errors); const error = new Error(`${code}: ${detail}`); error.code = code; error.source = source; error.path = filePath; error.errors = Array.isArray(errors) ? errors : [detail]; return error;
}
export default ConfigOwner;
