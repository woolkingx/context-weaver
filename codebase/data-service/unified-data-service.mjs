import { CacheAdmin } from '../tools/cache-admin.mjs';
import { ToolsApi } from '../tools/tools-api.mjs';

export class UnifiedDataService {
  constructor({ runtime, ...options } = {}) {
    if (!runtime) throw new TypeError('UnifiedDataService requires runtime.');
    this.runtime = runtime;
    this.toolsApi = new ToolsApi(options);
    this.cacheAdmin = new CacheAdmin({ toolsApi: this.toolsApi, fileBlockRouter: this.toolsApi.fileBlockRouter });
  }

  openProjectionSession(options) {
    return this.toolsApi.openProjectionSession(options);
  }

  cacheStatus(options) {
    return this.cacheAdmin.status(options);
  }

  cacheBuild(options) {
    return this.cacheAdmin.build(options);
  }

  // Reached as runtime.toolsApi.cacheClear(payload); clearing needs no instance state.
  // eslint-disable-next-line class-methods-use-this
  cacheClear(options) {
    return CacheAdmin.clear(options);
  }

  async withProjectionSession(root, owners, callback) {
    const config = this.runtime.getConfig(root);
    const activeSession = this.runtime.projectionSession;
    if (activeSession) {
      if (activeSession.root !== root || owners.some((owner) => !activeSession.owners.includes(owner))) {
        throw new Error('The active Unified Data Service session does not admit this root or owner set.');
      }
      return callback(activeSession, config);
    }

    const session = await this.toolsApi.openProjectionSession({
      root,
      owners,
      config,
      auditLogger: this.runtime.auditLogger,
      progress: (step, fields) => this.runtime.progress(step, fields),
    });
    try {
      return await callback(session, config);
    } finally {
      session.close();
    }
  }
}
