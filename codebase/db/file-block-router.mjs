// Execute the capabilities supplied by ToolsApi. This utility does not select
// semantic modules, construct peers, or own their admission/cache lifecycle.
export class FileBlockRouter {
  static async load({ requests }) {
    const results = [];
    const errors = [];
    for (const request of requests) {
      try {
        results.push(await request());
      } catch (error) {
        errors.push({ owner: request.owner ?? null, error });
      }
    }
    return {
      blocks: results.flatMap((result) => result.blocks ?? []),
      receipts: results.flatMap((result) => result.receipts ?? []),
      readyInDb: results.length > 0 && errors.length === 0 && results.every((result) => result.readyInDb === true),
      fileBlockCount: results.reduce((count, result) => count + (result.fileBlockCount ?? result.blocks?.length ?? 0), 0),
      loadErrors: errors,
    };
  }

  static async status({ requests }) {
    const results = [];
    for (const request of requests) results.push(await request());
    return results;
  }
}
