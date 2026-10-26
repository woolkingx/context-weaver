import { FileBlockRouter } from '../db/file-block-router.mjs';
import { PERSISTENT_OWNER_DEFINITIONS } from '../owners/persistent-owners.mjs';
import { OwnerCacheCoordinator } from '../db/persistent-owner-runner.mjs';
import { FileOwner } from '../../common/owners/files-owner.mjs';
import { admitOwners, assertRootAndOwners } from './owner-admission.mjs';
import { ProjectionSession } from './projection-session.mjs';

// ToolsApi loads FileBlocks for admitted owners through the router and opens
// request-scoped projection sessions. Cache lifecycle commands live in CacheAdmin.
export class ToolsApi {
  constructor({ fileBlockRouter = FileBlockRouter } = {}) {
    this.fileBlockRouter = fileBlockRouter;
  }

  async loadFileBlocks(options = {}) {
    assertRootAndOwners({ root: options.root, owners: options.owners, scope: 'runtime' });
    const {
      root, owners, fileBlockStore = null, auditLogger = null, progress = null, filePaths = null,
    } = options;

    const admission = options.admittedInputs
      ? { inputs: options.admittedInputs, errors: options.admissionErrors ?? new Map() }
      : await admitOwners(options);
    const admittedInputs = admission.inputs;
    const active = new Set(owners.filter((owner) => !admission.errors.has(owner)));
    const requests = [...PERSISTENT_OWNER_DEFINITIONS.values()]
      .filter((definition) => active.has(definition.name))
      .map((definition) => {
        const request = async () => {
          let receipt;
          const result = await new OwnerCacheCoordinator({
            name: definition.name,
            producerGeneration: definition.producerGeneration,
            produce: (payload) => definition.build(payload),
            fileBlockStore,
            auditLogger,
            progress,
            onReceipt: (value) => {
              receipt = value;
            },
          }).load({
            root,
            input: admittedInputs.get(definition.name),
            filePaths: definition.name === 'codebase' ? filePaths : null,
          });
          return { ...result, receipts: receipt ? [receipt] : [] };
        };
        request.owner = definition.name;
        return request;
      });
    const result = await FileOwner.withSession(() => this.fileBlockRouter.load({
      ...options,
      owners: [...active],
      admittedInputs,
      requests,
    }));
    return { ...result, admissionErrors: admission.errors };
  }

  // A request session is the only runtime composition boundary.  Commands may
  // issue several SQL projections, but they all observe one immutable
  // FileBlock read and one in-memory SQLite projection.
  async openProjectionSession(options = {}) {
    assertRootAndOwners({ root: options.root, owners: options.owners, scope: 'runtime' });
    return ProjectionSession.open({ toolsApi: this, ...options });
  }
}
