import { TokenBudgetTrimmer } from '../../common/lib/token-budget.mjs';

export class JsonProjector {
  static project({ value, maxChars: requestedMaxChars } = {}) {
    const options = { maxChars: requestedMaxChars };
    const outputValue = value;
    const budget = Number(options.maxChars);
    if (!Number.isInteger(budget) || budget < 1) {
      return `${JSON.stringify(outputValue, null, 2)}\n`;
    }
    return projectWithinBudget(outputValue, budget);
  }
}

function projectWithinBudget(value, budget) {
  const maxChars = Math.max(1, budget);
  let currentBudget = maxChars;
  let payload = value;

  for (let pass = 0; pass < 10; pass += 1) {
    payload = TokenBudgetTrimmer.trimPayload(value, currentBudget);
    const output = `${JSON.stringify(payload, null, 2)}\n`;
    if (output.length <= maxChars) return output;
    const compactOutput = `${JSON.stringify(payload)}\n`;
    if (compactOutput.length <= maxChars) return compactOutput;
    currentBudget = Math.max(1, Math.floor(currentBudget * 0.65));
  }

  return stringifyHardCap(createBudgetSummary(value, maxChars), maxChars);
}

function stringifyHardCap(payload, maxChars) {
  const output = `${JSON.stringify(payload, null, 2)}\n`;
  if (output.length <= maxChars) return output;

  const compactOutput = `${JSON.stringify(payload)}\n`;
  if (compactOutput.length <= maxChars) return compactOutput;

  const minimal = JSON.stringify({
    object: payload.object ?? 'BudgetedOutput',
    truncated: true,
  });
  if (minimal.length <= maxChars) return minimal;

  if (maxChars >= 2) return '{}'.slice(0, maxChars);
  return '0';
}

function createBudgetSummary(value, maxChars = 2000) {
  if (!value || typeof value !== 'object') {
    return {
      object: 'BudgetedOutput',
      truncated: true,
    };
  }

  // EvalReport: 保留契約 + 截短 output (評分契約比 output body 重要)
  if (value.object === 'EvalReport') {
    return {
      object: 'EvalReport',
      truncated: true,
      targetCommand: value.targetCommand,
      output: TokenBudgetTrimmer.trimPayload(value.output, Math.max(600, Math.floor(maxChars * 0.72))),
      observability: value.observability,
      rubric: value.rubric,
      scores: value.scores,
      note: value.note,
    };
  }

  // RelateReport: 超預算保留 focus/count + 砍 related 到前幾筆
  if (value.object === 'RelateReport') {
    return {
      object: 'RelateReport',
      truncated: true,
      focus: value.focus,
      root: value.root,
      count: value.count,
      related: (value.related ?? []).slice(0, 5).map((entry) => ({
        token: entry.token,
        weight: entry.weight,
      })),
    };
  }

  // TokenReport: CRUD 回應小,保留全部關鍵欄位
  if (value.object === 'TokenReport') {
    return {
      object: 'TokenReport',
      truncated: true,
      op: value.op,
      a: value.a,
      b: value.b,
      semantic: value.semantic,
      related: (value.related ?? []).slice(0, 5),
    };
  }

  // SkillReport: 保留 query/count + skill 名單(砍 description)
  if (value.object === 'SkillReport') {
    return {
      object: 'SkillReport',
      truncated: true,
      query: value.query,
      mode: value.mode,
      count: value.count,
      total: value.total,
      skills: (value.skills ?? []).slice(0, 10).map((skill) => ({
        name: skill.name,
        path: skill.path,
        score: skill.score,
      })),
    };
  }

  // SkillLoad: 全文物件,超預算保留 found/refs 名單,截短 content
  if (value.object === 'SkillLoad') {
    return {
      object: 'SkillLoad',
      truncated: true,
      name: value.name,
      found: value.found,
      dir: value.dir,
      content: typeof value.content === 'string' ? value.content.slice(0, 800) : value.content,
      references: (value.references ?? []).map((r) => ({ kind: r.kind, name: r.name, header: r.header })),
    };
  }

  // SkillList: 目錄樹,超預算保留頂層 skill 名,砍深層 children
  if (value.object === 'SkillList') {
    return {
      object: 'SkillList',
      truncated: true,
      trees: (value.trees ?? []).map((t) => ({
        scope: t.scope,
        name: t.name,
        skills: (t.children ?? []).filter((c) => c.type === 'skill').map((c) => c.name),
      })),
    };
  }

  if (value.object === 'RelationProjection') {
    return {
      object: 'RelationProjection',
      truncated: true,
      query: value.query,
      highlights: value.highlights ?? [],
      counts: {
        nodes: Array.isArray(value.nodes) ? value.nodes.length : 0,
        edges: Array.isArray(value.edges) ? value.edges.length : 0,
      },
    };
  }

  if (value.object === 'WhereReport') {
    return {
      object: 'WhereReport',
      truncated: true,
      query: summarizeQuery(value.query),
      coordinate: {
        repo: value.coordinate?.repo,
        scope: value.coordinate?.scope,
        ruleRefs: value.coordinate?.ruleRefs ?? [],
        git: value.coordinate?.git
          ? {
            branch: value.coordinate.git.branch,
            isWorktree: value.coordinate.git.isWorktree,
            status: value.coordinate.git.status,
          }
          : undefined,
        tokenRoute: value.coordinate?.tokenRoute
          ? {
            object: value.coordinate.tokenRoute.object,
            tokens: value.coordinate.tokenRoute.tokens?.slice?.(0, 12) ?? [],
            owners: value.coordinate.tokenRoute.owners?.slice?.(0, 8) ?? [],
            signals: value.coordinate.tokenRoute.signals?.slice?.(0, 8) ?? [],
          }
          : undefined,
      },
      dimensions: summarizeDimensions(value.dimensions),
      graph: value.graph
        ? {
          root: value.graph.root,
          count: value.graph.count,
          present: value.graph.present,
        }
        : value.graph,
      skills: value.skills
        ? {
          count: value.skills.count,
          skills: value.skills.skills?.slice?.(0, 3)?.map((skill) => ({
            name: skill.name,
            path: skill.path,
          })) ?? [],
        }
        : value.skills,
      plans: value.plans
        ? {
          count: value.plans.count,
          root: value.plans.root,
          plans: value.plans.plans?.slice?.(0, 3)?.map((plan) => ({
            path: plan.path,
            title: plan.title,
          })) ?? [],
        }
        : value.plans,
      fileDir: value.fileDir
        ? {
          fileCount: value.fileDir.fileCount,
          topLevel: value.fileDir.topLevel?.slice?.(0, 6)?.map((entry) => ({
            path: entry.path,
            kind: entry.kind,
          })) ?? [],
        }
        : value.fileDir,
      next: summarizeNext(value.next),
    };
  }

  if (value.object === 'ExplainReport') {
    return {
      object: 'ExplainReport',
      truncated: true,
      query: summarizeQuery(value.query),
      coordinate: {
        repo: value.coordinate?.repo,
        ruleRefs: value.coordinate?.ruleRefs ?? [],
      },
      boundary: value.boundary
        ? {
          owner: value.boundary.owner,
          graph: value.boundary.graph?.root,
          skills: value.boundary.skills?.count,
        }
        : value.boundary,
      target: value.target,
      evidence: {
        source: summarizeExplainSource(value.evidence?.source, maxChars),
        counts: {
          source: value.evidence?.source?.length ?? 0,
        },
      },
      related: {
        tests: value.related?.tests?.slice?.(0, 2)?.map((item) => ({
          location: item.location,
          score: item.score,
        })) ?? [],
      },
      next: summarizeNext(value.next),
    };
  }

  if (value.object === 'SensorReport') {
    return {
      object: 'SensorReport',
      truncated: true,
      query: summarizeQuery(value.query),
      coordinate: {
        repo: value.coordinate?.repo,
        scope: value.coordinate?.scope,
        ruleRefs: value.coordinate?.ruleRefs ?? [],
        tokenRoute: value.coordinate?.tokenRoute
          ? {
            object: value.coordinate.tokenRoute.object,
            tokens: value.coordinate.tokenRoute.tokens?.slice?.(0, 12) ?? [],
            owners: value.coordinate.tokenRoute.owners?.slice?.(0, 8) ?? [],
            signals: value.coordinate.tokenRoute.signals?.slice?.(0, 8) ?? [],
          }
          : undefined,
      },
      results: value.results?.slice?.(0, 3)?.map((result) => ({
        route: result.route,
        lane: result.lane,
        source: result.source,
        location: result.location,
        score: result.score,
        excerpt: TokenBudgetTrimmer.trimText(result.excerpt, Math.min(220, Math.max(80, Math.floor(maxChars / 6)))),
        metadata: result.metadata
          ? {
            kind: result.metadata.kind,
            symbol: result.metadata.symbol,
            truncated: result.metadata.truncated,
            truncatedByBudget: result.metadata.truncatedByBudget,
            nextStartLine: result.metadata.nextStartLine,
            nextEndLine: result.metadata.nextEndLine,
            ruleRefs: normalizeRuleRefs(result.metadata.ruleRefs),
          }
          : undefined,
      })) ?? [],
      counts: {
        results: value.results?.length ?? 0,
      },
      next: summarizeNext(value.next),
    };
  }

  return {
    object: value.object ?? 'BudgetedOutput',
    truncated: true,
  };
}

function summarizeQuery(query) {
  if (!query || typeof query !== 'object') return query;
  return {
    intent: query.intent,
    text: query.query,
    mode: query.mode,
  };
}

function summarizeDimensions(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return dimensions;
  return Object.fromEntries(
    Object.entries(dimensions).map(([name, dimension]) => [
      name,
      {
        present: Boolean(dimension?.present),
        count: dimension?.count,
      },
    ]),
  );
}

function summarizeNext(next) {
  if (!next || typeof next !== 'object') return next;
  return {
    expansions: next.expansions?.slice?.(0, 3)?.map((item) => ({
      route: item.route,
      path: item.path,
      reason: item.reason,
    })) ?? [],
    missingContext: next.missingContext?.slice?.(0, 3) ?? [],
    verification: next.verification?.slice?.(0, 3) ?? [],
  };
}

function metadataRuleRefs(metadata) {
  return {
    ruleRefs: normalizeRuleRefs(metadata?.ruleRefs),
  };
}

function summarizeExplainSource(source, maxChars) {
  const hits = (source ?? []).slice(0, 2);
  const excerptBudget = hits.length <= 1
    ? Math.min(360, Math.max(1, Math.floor(maxChars / 4)))
    : Math.min(180, Math.max(1, Math.floor(maxChars / 8)));
  return hits.map((item) => ({
    route: item.route,
    location: item.location,
    score: item.score,
    excerpt: TokenBudgetTrimmer.trimText(item.excerpt, excerptBudget),
    metadata: metadataRuleRefs(item.metadata),
  }));
}

function normalizeRuleRefs(ruleRefs) {
  return Array.isArray(ruleRefs) ? ruleRefs.filter((ruleRef) => typeof ruleRef === 'string') : [];
}
