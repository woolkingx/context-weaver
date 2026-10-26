import { FileOwner } from '../../common/owners/files-owner.mjs';
import { PERSISTENT_OWNER_DEFINITIONS } from '../owners/persistent-owners.mjs';
import { validateOwners } from '../../common/tools/tools.schema.mjs';

// Admit every requested owner through FileOwner. A failing owner is reported in
// `errors` instead of aborting the others.
export async function admitOwners({ root, owners, progress = null }) {
  return FileOwner.withSession(async () => {
    const inputs = new Map();
    const errors = new Map();
    for (const owner of owners) {
      const started = performance.now();
      progress?.('owner.admission.start', { owner, root });
      try {
        const definition = PERSISTENT_OWNER_DEFINITIONS.get(owner);
        const input = await definition.admit(root);
        inputs.set(owner, input);
        progress?.('owner.admission.end', {
          owner,
          root,
          state: 'admitted',
          admitted_files: input.manifest.admittedFileCount,
          duration_ms: Math.round(performance.now() - started),
        });
      } catch (error) {
        errors.set(owner, error);
        progress?.('owner.admission.error', {
          owner,
          root,
          state: 'error',
          error_code: error.code ?? null,
          duration_ms: Math.round(performance.now() - started),
        });
      }
    }
    return { inputs, errors };
  });
}

export function assertRootAndOwners({ root, owners, scope }) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('ToolsApi call payload requires a non-empty root.');
  }
  if (!Array.isArray(owners) || owners.length === 0) {
    throw new TypeError('ToolsApi call payload requires a non-empty owners array.');
  }
  validateOwners(owners, { scope });
}
