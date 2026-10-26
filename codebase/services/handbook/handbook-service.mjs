export class HandbookService {
  constructor({ runtime, dataService }) {
    this.runtime = runtime;
    this.dataService = dataService;
  }

  // Dispatched as owner[method](payload) by CliApplication, so it stays an instance method.
  // eslint-disable-next-line class-methods-use-this
  async read() {
    return {
      object: 'ModuleStatus',
      module: 'handbook',
      enabled: false,
      status: 'maintenance',
      code: 'HANDBOOK_MODULE_MAINTENANCE',
      message: 'The handbook module is temporarily unavailable while its Markdown runtime is under maintenance.',
    };
  }
}
