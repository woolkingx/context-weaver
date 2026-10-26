export function createSensorResult({
  route, lane = 'files_direct', interactionLayer = 'evidence', owner = null, capability = null, tool, command, indexVersion = 'none', freshness = 'fresh', path, startLine = 1, endLine = 1, excerpt = '', score = 0, metadata = {}, location = null,
}) {
  const source = {
    tool,
    command,
    indexVersion,
    freshness,
    owner: owner ?? ownerForLane(lane),
    capability: capability ?? 'ok',
  };
  return {
    object: 'SensorResult', route, lane, interactionLayer, source, location: location ?? { path, startLine, endLine }, excerpt, score, metadata,
  };
}

function ownerForLane(lane) {
  return {
    claude_agents: 'claude_agents',
    files_direct: 'files',
    handbook: 'handbook',
    plan: 'plan',
    skills: 'skills',
    code: 'code',
  }[lane] ?? null;
}

export function createContextQuery({
  intent = 'locate', query = '', question = {}, root = process.cwd(), budget = {}, ...rest
} = {}) {
  return {
    object: 'ContextQuery', intent, query, question, root, budget: { maxHits: budget.maxHits ?? 20, maxChars: budget.maxChars ?? 12000 }, ...rest,
  };
}

export function createRelateReport(value = {}) {
  return { object: 'RelateReport', ...value };
}

export function createTokenReport(value = {}) {
  return { object: 'TokenReport', ...value };
}

export function createSensorReport({
  query,
  coordinate = {},
  results = [],
  expansions = [],
  missingContext = [],
  next = {},
} = {}) {
  return {
    object: 'SensorReport',
    query,
    coordinate,
    results,
    next: {
      ...next,
      expansions: next.expansions ?? expansions,
      missingContext: next.missingContext ?? missingContext,
    },
  };
}
