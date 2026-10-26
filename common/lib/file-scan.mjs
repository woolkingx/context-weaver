import path from 'node:path';
import { DEFAULT_EXCLUDED_SEGMENTS } from './path-exclusion-policy.mjs';
import { FileOwner } from '../owners/files-owner.mjs';

export const DEFAULT_IGNORE_NAMES = DEFAULT_EXCLUDED_SEGMENTS;
export async function collectFiles(root, options = {}) {
  return (await (await FileOwner.forRoot(root)).listAdmittedFiles(options)).files;
}
export function toPosix(value) {
  return String(value).split(path.sep).join('/');
}
