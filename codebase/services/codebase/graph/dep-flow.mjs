import { GraphResolver } from './graph-resolve.mjs';

export class DepFlow {
  constructor({ session, resolved }) {
    this.session = session;
    this.resolved = resolved;
    this.fileNode = resolved.kind === 'file'
      ? resolved
      : GraphResolver.resolveFileNode(session, resolved.file);
  }

  project({ direction } = {}) {
    const filePath = this.fileNode?.file ?? this.resolved.file ?? this.resolved.displayName;
    const messages = [GraphResolver.createMessage(0, 'self', filePath, 'file', filePath, null)];

    if (direction === 'out' || direction === 'both') this.#projectDependsOn(messages, filePath);
    if (direction === 'in' || direction === 'both') this.#projectDependedBy(messages, filePath);

    return GraphResolver.createResult('dep', filePath, messages);
  }

  #projectDependsOn(messages, filePath) {
    const s = this.fileNode?.structure ?? {};
    for (const [, imp] of Object.entries(s.imports ?? {})) {
      messages.push(GraphResolver.createMessage(1, 'depends_on', imp.module, 'import', filePath, imp.line, {
        bindings: Object.keys(imp.bindings ?? {}),
      }));
    }
  }

  #projectDependedBy(messages, filePath) {
    const name = this.fileNode?.name ?? this.resolved.name;
    const rows = this.session.query({
      sql: `SELECT json_extract(s.structure, '$.path') AS src_file
            FROM edge_rows e
            JOIN node_rows s ON e.source_node_key = s.node_key
            JOIN node_rows t ON e.target_node_key = t.node_key
            WHERE e.edge_kind = 'imports'
              AND (t.name = ? OR json_extract(t.structure, '$.path') = ?)
            GROUP BY src_file`,
      params: [name, filePath],
    });
    for (const dep of rows) {
      messages.push(GraphResolver.createMessage(1, 'depended_by', dep.src_file, 'file', dep.src_file, null));
    }
  }
}
