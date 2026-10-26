const WORLD_ROUTE = Object.freeze([
  'source_modules',
  'file_blocks',
  'node_edge_projection',
  'sql_query',
  'product_view',
]);

const WORLD_CONTRACT = 'ctx-kernel-architecture.v1';
const MAX_FOCUS = 12;
const MAX_NODES = 80;
const MAX_EDGES = 120;
const MAX_NEXT = 5;

const WORLD_LAYERS = Object.freeze([
  {
    id: 'source_modules', label: 'Source Modules', truth: 'owner producers', state: 'admitted',
  },
  {
    id: 'file_blocks', label: 'files + file_blocks JSONB', truth: 'canonical lifecycle + content', state: 'canonical',
  },
  {
    id: 'node_edge_projection', label: 'node_rows + edge_rows', truth: 'derived', state: 'indexed',
  },
  {
    id: 'sql_query', label: 'SQL Query', truth: 'read-only', state: 'queried',
  },
  {
    id: 'product_view', label: 'Product View', truth: 'bounded output', state: 'returned',
  },
]);

export function buildWorldMap({
  command,
  query,
  lane = 'task_seed',
  root = null,
  owners = [],
  cache = null,
  rows = [],
  tracePaths = [],
  next = [],
  matched = null,
  proof = null,
} = {}) {
  const nodes = [];
  const edges = [];
  const nodeNames = new Set();
  const edgeKeys = new Set();

  rows.forEach((row) => addRow({
    row, nodes, nodeNames, edges, edgeKeys, owners,
  }));
  tracePaths.forEach((path) => addTracePath({
    path, nodes, nodeNames, edges, edgeKeys, owners,
  }));

  const focus = nodes.filter((node) => ['center', 'focus', 'match'].includes(node.role)).slice(0, MAX_FOCUS);
  const nodeCount = nodeNames.size;
  const edgeCount = edgeKeys.size;
  return {
    object: 'WorldMap',
    contract: WORLD_CONTRACT,
    route: [...WORLD_ROUTE],
    layers: WORLD_LAYERS.map((layer) => ({ ...layer })),
    focus,
    nodes,
    edges,
    evidence: {
      canonical: 'files + file_blocks',
      projection: 'node_rows + edge_rows',
      query: 'sql',
      query_text: query,
      command,
      query_lane: lane,
      owners: [...owners],
      scope: {
        root,
        owners: [...owners],
      },
      lifecycle: {
        canonical: 'persistent',
        projection: 'indexed',
        snapshot: 'bound_read_snapshot',
      },
      cache: cacheEvidence(cache),
      node_count: nodeCount,
      edge_count: edgeCount,
      returned_node_count: nodes.length,
      returned_edge_count: edges.length,
      truncated: nodeCount > nodes.length || edgeCount > edges.length,
      matched: matched ?? nodeCount > 0,
      proof: proofEvidence({
        proof,
        matched: matched ?? nodeCount > 0,
        truncated: nodeCount > nodes.length || edgeCount > edges.length,
        next,
      }),
    },
    next: next.slice(0, MAX_NEXT),
  };
}

function addRow({
  row, nodes, nodeNames, edges, edgeKeys, owners,
}) {
  const role = row.section ?? 'related';
  if (row.name) {
    addNode({
      name: row.name, role, row, nodes, nodeNames, owners,
    });
  }
  const from = row.frompath ?? row.from_node_id;
  const to = row.topath ?? row.to_node_id;
  if (!from || !to) return;
  const fromName = row.fromnode ?? row.from_node_id;
  const toName = row.tonode ?? row.to_node_id;
  if (!fromName || !toName) return;
  addNode({
    name: fromName, role: 'relation', row, nodes, nodeNames, owners,
  });
  addNode({
    name: toName, role: 'relation', row, nodes, nodeNames, owners,
  });
  addEdge({
    from: fromName, to: toName, fromPath: from, toPath: to, relation: row.relation_kind ?? row.kind, edges, edgeKeys,
  });
}

function addTracePath({
  path, nodes, nodeNames, edges, edgeKeys, owners,
}) {
  if (!path?.start) return;
  addNode({
    name: path.start, role: 'focus', nodes, nodeNames, owners,
  });
  let previous = path.start;
  for (const hop of path.hops ?? []) {
    const name = hop.node?.name;
    if (!name) continue;
    addNode({
      name, role: 'related', row: hop.node, nodes, nodeNames, owners,
    });
    const from = hop.fromnode ?? previous;
    const to = hop.tonode ?? name;
    addEdge({
      from, to, fromPath: hop.frompath, toPath: hop.topath, relation: hop.relation_kind, edges, edgeKeys,
    });
    previous = name;
  }
}

function addNode({
  name, role, row = {}, nodes, nodeNames, owners,
}) {
  if (!name) return;
  if (nodeNames.has(name)) return;
  const structure = row.structure ?? {};
  const node = {
    object: 'ContextNode',
    id: name,
    name,
    type: structure.kind ?? row.kind ?? 'projection',
    lane: 'world-map',
    interactionLayer: 'product-view',
    owner: owners.length === 1 ? owners[0] : 'runtime',
    role,
    title: structure.displayName ?? name,
  };
  if (structure.path) node.path = structure.path;
  nodeNames.add(name);
  if (nodes.length < MAX_NODES) nodes.push(node);
}

function addEdge({
  from, to, fromPath, toPath, relation = 'related', edges, edgeKeys,
}) {
  if (!from || !to) return;
  const key = `${from}|${to}|${relation ?? 'related'}|${fromPath ?? ''}|${toPath ?? ''}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  if (edges.length >= MAX_EDGES) return;
  edges.push({
    object: 'ContextEdge',
    from,
    to,
    rel: relation ?? 'related',
    evidence: { frompath: fromPath ?? null, topath: toPath ?? null },
    confidence: 1,
  });
}

function cacheEvidence(cache) {
  return {
    owners: (cache?.owners ?? []).map((owner) => ({ owner: owner.owner, state: owner.state })),
    elapsed_ms: cache?.elapsedMs ?? null,
  };
}

function proofEvidence({
  proof, matched, truncated, next,
}) {
  return {
    status: truncated ? 'truncated' : (matched ? 'matched' : 'no_match'),
    missing_context: proof?.missing_context ?? [],
    next_count: next.length,
  };
}
