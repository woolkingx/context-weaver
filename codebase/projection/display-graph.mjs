const MAX_NODES = 80;
const MAX_EDGES = 120;

export class LayeredGraphLayout {
  static order({ refs, edges }) {
    const indexByRef = new Map(refs.map((ref, index) => [ref, index]));
    const reversed = LayeredGraphLayout.#breakCycles({ refs, edges, indexByRef });
    const layoutEdges = edges.map((edge) => (reversed.has(LayeredGraphLayout.#edgeKey(edge))
      ? { ...edge, layoutFrom: edge.toRef, layoutTo: edge.fromRef }
      : { ...edge, layoutFrom: edge.fromRef, layoutTo: edge.toRef }));
    const outgoing = new Map(refs.map((ref) => [ref, []]));
    const indegree = new Map(refs.map((ref) => [ref, 0]));
    for (const edge of layoutEdges) {
      outgoing.get(edge.layoutFrom).push(edge.layoutTo);
      indegree.set(edge.layoutTo, indegree.get(edge.layoutTo) + 1);
    }
    const queue = refs.filter((ref) => indegree.get(ref) === 0);
    const processed = [];
    const layerByRef = new Map(refs.map((ref) => [ref, 0]));
    while (queue.length > 0) {
      queue.sort((left, right) => indexByRef.get(left) - indexByRef.get(right));
      const ref = queue.shift();
      processed.push(ref);
      for (const target of outgoing.get(ref)) {
        layerByRef.set(target, Math.max(layerByRef.get(target), layerByRef.get(ref) + 1));
        indegree.set(target, indegree.get(target) - 1);
        if (indegree.get(target) === 0) queue.push(target);
      }
    }
    for (const ref of refs) if (!processed.includes(ref)) processed.push(ref);
    const positions = new Map(processed.map((ref, index) => [ref, index]));
    for (let pass = 0; pass < 4; pass += 1) {
      const layers = LayeredGraphLayout.#groupByLayer(processed, layerByRef);
      const orderedLayers = [...layers.keys()].sort((left, right) => (pass % 2 === 0 ? left - right : right - left));
      for (const layerNumber of orderedLayers) {
        const layer = layers.get(layerNumber);
        layer.sort((left, right) => LayeredGraphLayout.#neighborBarycenter(left, LayeredGraphLayout.#layerEdges(layoutEdges, pass), positions)
          - LayeredGraphLayout.#neighborBarycenter(right, LayeredGraphLayout.#layerEdges(layoutEdges, pass), positions)
          || indexByRef.get(left) - indexByRef.get(right));
        layer.forEach((ref, index) => positions.set(ref, index));
      }
    }
    const ordered = [...processed].sort((left, right) => layerByRef.get(left) - layerByRef.get(right)
      || positions.get(left) - positions.get(right) || indexByRef.get(left) - indexByRef.get(right));
    return { refs: ordered, layerByRef, reversedEdges: reversed.size };
  }

  static #breakCycles({ refs, edges, indexByRef }) {
    const outgoing = new Map(refs.map((ref) => [ref, []]));
    for (const edge of edges) outgoing.get(edge.fromRef).push(edge);
    const state = new Map(refs.map((ref) => [ref, 0]));
    const reversed = new Set();
    const visit = (ref) => {
      state.set(ref, 1);
      const nextEdges = [...outgoing.get(ref)].sort((left, right) => indexByRef.get(left.toRef) - indexByRef.get(right.toRef));
      for (const edge of nextEdges) {
        if (state.get(edge.toRef) === 1) reversed.add(LayeredGraphLayout.#edgeKey(edge));
        else if (state.get(edge.toRef) === 0) visit(edge.toRef);
      }
      state.set(ref, 2);
    };
    refs.forEach((ref) => {
      if (state.get(ref) === 0) visit(ref);
    });
    return reversed;
  }

  static #groupByLayer(refs, layerByRef) {
    const layers = new Map();
    for (const ref of refs) {
      const layer = layerByRef.get(ref);
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer).push(ref);
    }
    return layers;
  }

  static #layerEdges(edges, pass) {
    return edges.filter((edge) => (pass % 2 === 0 ? edge.layoutTo : edge.layoutFrom));
  }

  static #neighborBarycenter(ref, edges, positions) {
    const neighbors = edges
      .filter((edge) => edge.layoutFrom === ref || edge.layoutTo === ref)
      .map((edge) => positions.get(edge.layoutFrom === ref ? edge.layoutTo : edge.layoutFrom))
      .filter((position) => position !== undefined);
    return neighbors.length === 0 ? Number.MAX_SAFE_INTEGER : neighbors.reduce((sum, position) => sum + position, 0) / neighbors.length;
  }

  static #edgeKey(edge) {
    return `${edge.fromRef}\u0000${edge.toRef}\u0000${edge.kind}`;
  }
}

export class DisplayGraph {
  static fromRankingResult({
    rankingResult = [], view = 'dataflow', maxNodes = MAX_NODES, maxEdges = MAX_EDGES,
  } = {}) {
    const nodeRows = new Map();
    const edgeRows = new Map();
    const rows = Array.isArray(rankingResult) ? rankingResult : [];

    for (const row of rows) {
      DisplayGraph.#addNodeRow({ name: row.name, row, nodeRows });
      DisplayGraph.#addNodeRow({
        name: row.fromnode ?? row.from_node_id,
        row,
        label: row.from_label,
        kind: row.from_kind,
        nodeRows,
      });
      DisplayGraph.#addNodeRow({
        name: row.tonode ?? row.to_node_id,
        row,
        label: row.to_label,
        kind: row.to_kind,
        nodeRows,
      });
      DisplayGraph.#addEdgeRow({ row, edgeRows });
    }

    const selectedRefs = [...nodeRows].slice(0, maxNodes).map(([ref]) => ref);
    const selectedRefSet = new Set(selectedRefs);
    const eligibleEdges = [...edgeRows.values()]
      .filter((edge) => selectedRefSet.has(edge.fromRef) && selectedRefSet.has(edge.toRef));
    const layout = LayeredGraphLayout.order({ refs: selectedRefs, edges: eligibleEdges });
    const orderedRows = layout.refs.map((ref) => [ref, nodeRows.get(ref)]);
    const nodes = DisplayGraph.#disambiguateLabels(orderedRows.map(([ref, descriptor], index) => DisplayGraph.#displayNode({
      id: `n${index + 1}`,
      ref,
      descriptor,
      layer: layout.layerByRef.get(ref) ?? 0,
      order: index,
    })));
    const idByRef = new Map(nodes.map((node) => [node.ref, node.id]));
    const edges = eligibleEdges.slice(0, maxEdges).map((edge) => ({
      id: `e${DisplayGraph.#edgesId(edge)}`,
      from: idByRef.get(edge.fromRef),
      to: idByRef.get(edge.toRef),
      fromRef: edge.fromRef,
      toRef: edge.toRef,
      fromLabel: DisplayGraph.#labelFor(nodes, idByRef.get(edge.fromRef)),
      toLabel: DisplayGraph.#labelFor(nodes, idByRef.get(edge.toRef)),
      kind: edge.kind,
      status: edge.status,
      source: edge.source,
    }));
    return {
      object: 'DisplayGraph',
      view,
      nodes,
      edges,
      groups: [],
      layout: {
        algorithm: 'sugiyama-layered-ordering',
        direction: 'TD',
        cyclePolicy: 'stable-kahn-fallback',
        crossingPasses: 4,
        reversedEdges: layout.reversedEdges,
      },
      truncated: nodeRows.size > nodes.length || eligibleEdges.length > edges.length,
      omittedCount: Math.max(0, nodeRows.size - nodes.length)
        + Math.max(0, eligibleEdges.length - edges.length),
    };
  }

  static #addNodeRow({
    name, row, label = null, kind = null, nodeRows,
  }) {
    if (!name) return;
    const existing = nodeRows.get(name);
    if (!existing) {
      nodeRows.set(name, { row, label, kind });
      return;
    }
    if (name === row.name) {
      nodeRows.set(name, {
        row,
        label: label ?? existing.label,
        kind: kind ?? existing.kind,
      });
    }
  }

  static #addEdgeRow({ row, edgeRows }) {
    const fromRef = row.fromnode ?? row.from_node_id;
    const toRef = row.tonode ?? row.to_node_id;
    if (!fromRef || !toRef) return;
    const kind = row.relation_kind ?? row.kind ?? 'related';
    const key = `${fromRef}\u0000${toRef}\u0000${kind}`;
    if (!edgeRows.has(key)) {
      edgeRows.set(key, {
        fromRef,
        toRef,
        kind,
        status: row.status ?? 'observed',
        source: {
          fromPath: row.frompath ?? row.source_path ?? null,
          toPath: row.topath ?? null,
        },
      });
    }
  }

  static #displayNode({
    id, ref, descriptor, layer, order,
  }) {
    const structure = DisplayGraph.#parseJson(descriptor.row.structure);
    return {
      id,
      ref,
      label: descriptor.label ?? structure.displayName ?? structure.path ?? ref,
      kind: descriptor.kind ?? structure.kind ?? descriptor.row.kind ?? 'projection',
      layer,
      order,
      source: DisplayGraph.#sourceLocation(descriptor.row, structure),
    };
  }

  static #disambiguateLabels(nodes) {
    const counts = new Map();
    for (const node of nodes) counts.set(node.label, (counts.get(node.label) ?? 0) + 1);
    const seen = new Map();
    return nodes.map((node) => {
      if (counts.get(node.label) === 1) return node;
      const suffix = node.source?.path ? node.source.path.split('/').at(-1) : node.kind;
      const base = `${node.label} · ${suffix}`;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      return { ...node, label: `${base} #${occurrence}` };
    });
  }

  static #labelFor(nodes, id) {
    return nodes.find((node) => node.id === id)?.label ?? id;
  }

  static #edgesId(edge) {
    return `${DisplayGraph.#stableHash(`${edge.fromRef}\u0000${edge.toRef}\u0000${edge.kind}`)}`;
  }

  static #stableHash(value) {
    let hash = 17;
    for (const character of value) hash = (hash * 31 + character.codePointAt(0)) % 2147483647;
    return hash.toString(36);
  }

  static #sourceLocation(row, structure) {
    const path = structure.path ?? row.file_path ?? row.source_path ?? null;
    return path ? { path } : null;
  }

  static #parseJson(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || value.length === 0) return {};
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
}
