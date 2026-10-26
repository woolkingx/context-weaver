const MIN_BUDGET = 1;
const DEFAULT_BUDGET = 2000;

const DEFAULT_TEXT_BUDGET = Object.freeze({
  sensorExcerpt: 320,
  coordinateRuleText: 420,
  planSummary: 220,
  planTitle: 180,
  skillSummary: 240,
  pathSummary: 220,
  fiveWField: 120,
  nextField: 220,
});

export class TokenBudgetTrimmer {
  static MIN_BUDGET = MIN_BUDGET;

  static DEFAULT_BUDGET = DEFAULT_BUDGET;

  static DEFAULT_TEXT_BUDGET = DEFAULT_TEXT_BUDGET;

  static normalizeBudget(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_BUDGET) return DEFAULT_BUDGET;
    return parsed;
  }

  static trimText(value, budget, suffix = '…') {
    if (value == null) return '';
    const source = String(value);
    const maxChars = Math.max(MIN_BUDGET, Number.parseInt(budget, 10) || MIN_BUDGET);
    if (source.length <= maxChars) return source;
    if (maxChars === 1) return suffix.slice(0, 1);
    return `${source.slice(0, Math.max(0, maxChars - 1))}${suffix}`;
  }

  static stableOrder(items = [], compare = () => 0) {
    return TokenBudgetTrimmer.#normalizeArray(items)
      .map((item, index) => ({ item, index }))
      .sort((left, right) => compare(left.item, right.item) || left.index - right.index)
      .map(({ item }) => item);
  }

  static trimPayload(payload, budget) {
    const normalizedBudget = TokenBudgetTrimmer.normalizeBudget(budget);
    switch (payload?.object) {
      case 'SensorReport':
        return TokenBudgetTrimmer.#trimSensorReport(payload, normalizedBudget);
      case 'WhereReport':
        return TokenBudgetTrimmer.#trimWhereReport(payload, normalizedBudget);
      case 'ExplainReport':
        return TokenBudgetTrimmer.#trimExplainReport(payload, normalizedBudget);
      case 'RelationProjection':
        return TokenBudgetTrimmer.#trimRelationProjection(payload, normalizedBudget);
      case 'HandbookResult':
      case 'HandbookExport':
        return TokenBudgetTrimmer.#trimHandbookBlocks(payload, normalizedBudget);
      case 'HandbookTree':
        return TokenBudgetTrimmer.#trimHandbookTree(payload, normalizedBudget);
      case 'HandbookStats':
        return TokenBudgetTrimmer.#trimHandbookStats(payload, normalizedBudget);
      case 'EvalReport':
        return TokenBudgetTrimmer.#trimEvalReport(payload, normalizedBudget);
      default:
        return payload;
    }
  }

  static #trimEvalReport(report, budget) {
    return {
      ...report,
      output: TokenBudgetTrimmer.trimPayload(report.output, Math.max(600, Math.floor(budget * 0.72))),
      note: report.note ? TokenBudgetTrimmer.trimText(report.note, Math.min(600, budget)) : report.note,
    };
  }

  static #trimCoordinate(coordinate, budget) {
    if (!coordinate || typeof coordinate !== 'object') return coordinate;
    const activeRules = TokenBudgetTrimmer.#normalizeArray(coordinate.activeRules)
      .slice(0, 6)
      .map((rule) => ({
        ...rule,
        content: TokenBudgetTrimmer.trimText(rule.content, Math.min(DEFAULT_TEXT_BUDGET.coordinateRuleText, budget)),
      }));

    return {
      ...coordinate,
      activeRules,
      ruleRefs: TokenBudgetTrimmer.#normalizeArray(coordinate.ruleRefs),
      tokenRoute: coordinate.tokenRoute ? TokenBudgetTrimmer.#trimTokenRoute(coordinate.tokenRoute) : coordinate.tokenRoute,
      plans: coordinate.plans ? TokenBudgetTrimmer.#trimPlanCoordinate(coordinate.plans, budget) : coordinate.plans,
    };
  }

  static #trimPlanCoordinate(planCoordinate, budget) {
    if (!planCoordinate || typeof planCoordinate !== 'object') return planCoordinate;
    const plansSource = Array.isArray(planCoordinate)
      ? planCoordinate
      : TokenBudgetTrimmer.#normalizeArray(planCoordinate.plans).length > 0
        ? planCoordinate.plans
        : TokenBudgetTrimmer.#normalizeArray(planCoordinate.plans?.plans);
    const plans = TokenBudgetTrimmer.#normalizeArray(plansSource)
      .slice(0, 12)
      .map((plan) => ({
        ...plan,
        title: TokenBudgetTrimmer.trimText(plan.title, Math.min(DEFAULT_TEXT_BUDGET.planTitle, budget)),
        summary: TokenBudgetTrimmer.trimText(plan.summary, Math.min(DEFAULT_TEXT_BUDGET.planSummary, budget)),
      }));
    return {
      ...planCoordinate,
      plans,
    };
  }

  static #trimSensorResult(result, budget) {
    if (!result || typeof result !== 'object') return result;
    const fiveWOneH = result.metadata?.fiveWOneH;
    return {
      ...result,
      excerpt: TokenBudgetTrimmer.trimText(result.excerpt, Math.min(DEFAULT_TEXT_BUDGET.sensorExcerpt, budget)),
      metadata: {
        ...result.metadata,
        ruleRefs: TokenBudgetTrimmer.#normalizeArray(result.metadata?.ruleRefs),
        fiveWOneH: fiveWOneH
          ? {
            who: TokenBudgetTrimmer.trimText(fiveWOneH.who, DEFAULT_TEXT_BUDGET.fiveWField),
            what: TokenBudgetTrimmer.trimText(fiveWOneH.what, DEFAULT_TEXT_BUDGET.fiveWField),
            where: TokenBudgetTrimmer.trimText(fiveWOneH.where, DEFAULT_TEXT_BUDGET.pathSummary),
            when: fiveWOneH.when,
            why: TokenBudgetTrimmer.trimText(fiveWOneH.why, DEFAULT_TEXT_BUDGET.fiveWField),
            how: TokenBudgetTrimmer.trimText(fiveWOneH.how, DEFAULT_TEXT_BUDGET.fiveWField),
          }
          : fiveWOneH,
      },
      related: TokenBudgetTrimmer.#trimRelated(result.related),
    };
  }

  static #trimRelated(related) {
    if (!related || typeof related !== 'object') return related;
    return {
      ...related,
      calls: TokenBudgetTrimmer.#normalizeArray(related.calls).slice(0, 5),
      edges: TokenBudgetTrimmer.#normalizeArray(related.edges).slice(0, 5),
      symbols: TokenBudgetTrimmer.#normalizeArray(related.symbols).slice(0, 5),
      callsEdges: TokenBudgetTrimmer.#normalizeArray(related.callsEdges).slice(0, 5),
    };
  }

  static #trimSensorArray(results = [], budget, perItemBudget = DEFAULT_TEXT_BUDGET.sensorExcerpt) {
    const itemBudget = Math.max(64, perItemBudget * 2);
    const maxItems = Math.max(1, Math.floor(budget / itemBudget));
    return TokenBudgetTrimmer.#normalizeArray(results)
      .slice(0, Math.min(40, maxItems))
      .map((result) => TokenBudgetTrimmer.#trimSensorResult(result, budget));
  }

  static #trimNextItems(items = [], budget, limit = 12) {
    const maxItems = Math.max(1, Math.min(limit, Math.floor(budget / 160) || 1));
    return TokenBudgetTrimmer.#normalizeArray(items)
      .slice(0, maxItems)
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return TokenBudgetTrimmer.trimText(String(item), DEFAULT_TEXT_BUDGET.nextField);
        }
        return {
          ...item,
          reason: TokenBudgetTrimmer.trimText(item.reason, DEFAULT_TEXT_BUDGET.nextField),
          query: item.query ? TokenBudgetTrimmer.trimText(item.query, DEFAULT_TEXT_BUDGET.fiveWField) : item.query,
          route: TokenBudgetTrimmer.trimText(item.route, DEFAULT_TEXT_BUDGET.fiveWField),
          path: item.path ? TokenBudgetTrimmer.trimText(item.path, DEFAULT_TEXT_BUDGET.pathSummary) : item.path,
        };
      });
  }

  static #trimSensorReport(report, budget) {
    return {
      ...report,
      query: TokenBudgetTrimmer.#trimQuery(report.query),
      coordinate: {
        ...TokenBudgetTrimmer.#trimCoordinate(report.coordinate, budget),
        ...(report.coordinate && report.coordinate.plans
          ? { plans: TokenBudgetTrimmer.#trimPlanCoordinate(report.coordinate.plans, budget).plans }
          : {}),
        ...(report.coordinate && TokenBudgetTrimmer.#normalizeArray(report.coordinate.skills).length
          ? {
            skills: TokenBudgetTrimmer.#normalizeArray(report.coordinate.skills)
              .slice(0, 12)
              .map((skill) => ({
                ...skill,
                description: TokenBudgetTrimmer.trimText(skill.description, DEFAULT_TEXT_BUDGET.skillSummary),
                summary: TokenBudgetTrimmer.trimText(skill.summary, DEFAULT_TEXT_BUDGET.skillSummary),
              })),
          }
          : {}),
      },
      results: TokenBudgetTrimmer.#trimSensorArray(report.results, budget),
      next: {
        ...report.next,
        expansions: TokenBudgetTrimmer.#trimNextItems(report.next?.expansions, budget),
        missingContext: TokenBudgetTrimmer.#normalizeArray(report.next?.missingContext)
          .slice(0, 12)
          .map((item) => TokenBudgetTrimmer.trimText(item, DEFAULT_TEXT_BUDGET.nextField)),
      },
    };
  }

  static #trimWhereReport(report, budget) {
    return {
      ...report,
      query: TokenBudgetTrimmer.#trimQuery(report.query),
      coordinate: TokenBudgetTrimmer.#trimCoordinate(report.coordinate, budget),
      fileDir: report.fileDir
        ? {
          ...report.fileDir,
          topLevel: TokenBudgetTrimmer.#normalizeArray(report.fileDir.topLevel).slice(0, 24),
        }
        : report.fileDir,
      skills: report.skills
        ? {
          ...report.skills,
          skills: TokenBudgetTrimmer.#normalizeArray(report.skills.skills).slice(0, 12).map(TokenBudgetTrimmer.#trimSkillSummary),
        }
        : report.skills,
      next: {
        ...report.next,
        expansions: TokenBudgetTrimmer.#trimNextItems(report.next?.expansions, budget),
        missingContext: TokenBudgetTrimmer.#normalizeArray(report.next?.missingContext)
          .slice(0, 12)
          .map((item) => TokenBudgetTrimmer.trimText(item, DEFAULT_TEXT_BUDGET.nextField)),
      },
      plans: report.plans ? TokenBudgetTrimmer.#trimPlanCoordinate(report.plans, budget) : report.plans,
    };
  }

  static #trimExplainReport(report, budget) {
    return {
      ...report,
      query: TokenBudgetTrimmer.#trimQuery(report.query),
      coordinate: TokenBudgetTrimmer.#trimCoordinate(report.coordinate, budget),
      boundary: report.boundary
        ? {
          ...report.boundary,
          skills: report.boundary.skills
            ? {
              ...report.boundary.skills,
              skills: TokenBudgetTrimmer.#normalizeArray(report.boundary.skills.skills).slice(0, 8).map(TokenBudgetTrimmer.#trimSkillSummary),
            }
            : report.boundary.skills,
        }
        : report.boundary,
      evidence: {
        source: TokenBudgetTrimmer.#trimSensorArray(report.evidence?.source, budget, 180).slice(0, 4),
        ...report.evidence,
      },
      related: {
        ...report.related,
        tests: TokenBudgetTrimmer.#trimSensorArray(report.related?.tests, budget).slice(0, 4),
      },
      next: {
        ...report.next,
        expansions: TokenBudgetTrimmer.#trimNextItems(report.next?.expansions, budget),
        missingContext: TokenBudgetTrimmer.#normalizeArray(report.next?.missingContext)
          .slice(0, 12)
          .map((item) => TokenBudgetTrimmer.trimText(item, DEFAULT_TEXT_BUDGET.nextField)),
        verification: TokenBudgetTrimmer.#normalizeArray(report.next?.verification).slice(0, 12).map((item) => ({
          ...item,
          path: item.path ? TokenBudgetTrimmer.trimText(item.path, DEFAULT_TEXT_BUDGET.pathSummary) : item.path,
          reason: TokenBudgetTrimmer.trimText(item.reason, DEFAULT_TEXT_BUDGET.nextField),
        })),
      },
    };
  }

  static #trimSkillSummary(skill) {
    if (!skill || typeof skill !== 'object') return skill;
    return {
      name: skill.name,
      path: skill.path,
      scope: skill.scope,
      description: TokenBudgetTrimmer.trimText(skill.description, DEFAULT_TEXT_BUDGET.skillSummary),
      summary: TokenBudgetTrimmer.trimText(skill.summary, DEFAULT_TEXT_BUDGET.skillSummary),
      score: skill.score,
    };
  }

  static #trimHandbookBlocks(report, budget) {
    const maxItems = Math.max(1, Math.min(80, Math.floor(budget / 500) || 1));
    const contentBudget = Math.max(64, Math.min(480, Math.floor(budget / 3)));
    const allBlocks = TokenBudgetTrimmer.#normalizeArray(report.blocks);
    const allRelations = TokenBudgetTrimmer.#normalizeArray(report.relations);
    const maxRelations = Math.max(1, Math.floor(budget / 120));
    const blocks = allBlocks.slice(0, maxItems).map((block) => ({
      ...block,
      content: block.content == null ? block.content : TokenBudgetTrimmer.trimText(block.content, contentBudget),
    }));
    const refs = Object.fromEntries(Object.entries(report.contentRefs ?? {}).slice(0, maxItems)
      .map(([id, content]) => [id, TokenBudgetTrimmer.trimText(content, contentBudget)]));
    const relations = allRelations.slice(0, maxRelations);
    const omittedBlockIds = allBlocks.slice(blocks.length).map((block) => block.id);
    const omittedBlocks = omittedBlockIds.length;
    const omittedRelations = Math.max(0, allRelations.length - relations.length);
    const truncated = omittedBlocks > 0 || omittedRelations > 0;
    const continuation = omittedBlocks > 0
      ? `ctx handbook --ids ${omittedBlockIds.slice(0, 8).join(',')
      }${omittedBlockIds.length > 8 ? ',...' : ''
      } --max-chars <n>`
      : undefined;
    return {
      ...report,
      ...(truncated
        ? {
          truncated: true,
          omittedBlocks,
          omittedRelations,
          omittedBlockIds,
          continuation,
        }
        : {}),
      ...(Array.isArray(report.blocks) ? { blocks } : {}),
      ...(report.contentRefs ? { contentRefs: refs } : {}),
      ...(Array.isArray(report.relations) ? { relations } : {}),
    };
  }

  static #trimHandbookTree(report, budget) {
    const maxNodes = Math.max(1, Math.min(40, Math.floor(budget / 450) || 1));
    return {
      ...report,
      nodes: TokenBudgetTrimmer.#normalizeArray(report.nodes).slice(0, maxNodes).map((entry) => ({
        ...entry,
        block: entry.block
          ? { ...entry.block, content: TokenBudgetTrimmer.trimText(entry.block.content, Math.max(64, Math.min(480, Math.floor(budget / 3)))) }
          : entry.block,
      })),
    };
  }

  static #trimHandbookStats(report, budget) {
    return {
      ...report,
      chapters: TokenBudgetTrimmer.#normalizeArray(report.chapters).slice(0, Math.max(1, Math.floor(budget / 180))),
      topTags: TokenBudgetTrimmer.#normalizeArray(report.topTags).slice(0, 15),
      duplicateGroups: TokenBudgetTrimmer.#normalizeArray(report.duplicateGroups).slice(0, Math.max(1, Math.floor(budget / 180))),
      unresolved: TokenBudgetTrimmer.#normalizeArray(report.unresolved).slice(0, Math.max(1, Math.floor(budget / 180))),
    };
  }

  static #trimTokenRoute(route) {
    if (!route || typeof route !== 'object') return route;
    return {
      object: route.object,
      tokens: TokenBudgetTrimmer.#normalizeArray(route.tokens).slice(0, 12),
      slots: route.slots,
      signals: TokenBudgetTrimmer.#normalizeArray(route.signals).slice(0, 8),
      owners: TokenBudgetTrimmer.#normalizeArray(route.owners).slice(0, 8),
      lanes: TokenBudgetTrimmer.#normalizeArray(route.lanes).slice(0, 8),
      missingCapabilities: TokenBudgetTrimmer.#normalizeArray(route.missingCapabilities).slice(0, 5),
      reasons: TokenBudgetTrimmer.#normalizeArray(route.reasons)
        .slice(0, 5)
        .map((item) => TokenBudgetTrimmer.trimText(item, DEFAULT_TEXT_BUDGET.nextField)),
    };
  }

  static #trimRelationProjection(graph, budget) {
    const maxNodeBudget = Math.max(1, Math.floor(budget / 80));
    const maxEdgeBudget = Math.max(1, Math.floor(budget / 60));
    const nodeBudget = Math.min(80, maxNodeBudget);
    const edgeBudget = Math.min(180, maxEdgeBudget);
    const edges = TokenBudgetTrimmer.#selectGraphEdges(graph.edges, edgeBudget).map(TokenBudgetTrimmer.#trimGraphEdge);
    const nodes = TokenBudgetTrimmer.#selectGraphNodes(graph.nodes, edges, nodeBudget).map((node) => ({
      ...node,
      label: TokenBudgetTrimmer.trimText(node.label, 72),
      lineRef: TokenBudgetTrimmer.trimText(node.lineRef ?? '', 48),
    }));
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
      ...graph,
      nodes,
      edges: edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)),
      highlights: TokenBudgetTrimmer.#normalizeArray(graph.highlights)
        .slice(0, 10)
        .map((item) => TokenBudgetTrimmer.trimText(item, 160)),
      focus: graph.focus
        ? {
          queryNode: TokenBudgetTrimmer.trimText(graph.focus.queryNode, 80),
          ownerNodes: TokenBudgetTrimmer.#normalizeArray(graph.focus.ownerNodes).slice(0, 12),
          planNode: TokenBudgetTrimmer.trimText(graph.focus.planNode, 80),
          completion: TokenBudgetTrimmer.trimText(graph.focus.completion, 32),
        }
        : graph.focus,
    };
  }

  static #selectGraphNodes(nodes = [], edges = [], nodeBudget) {
    const normalized = TokenBudgetTrimmer.#normalizeArray(nodes);
    const byId = new Map(normalized.map((node) => [node.id, node]));
    const selected = [];
    const seen = new Set();
    const add = (id) => {
      if (!id || seen.has(id) || selected.length >= nodeBudget) return;
      const node = byId.get(id);
      if (!node) return;
      selected.push(node);
      seen.add(id);
    };

    add('query:main');
    for (const edge of edges) {
      add(edge.from);
      add(edge.to);
    }
    for (const id of ['coord:repo', 'plan']) add(id);
    for (const node of normalized) add(node.id);
    return selected;
  }

  static #trimGraphEdge(edge) {
    if (!edge || typeof edge !== 'object') return edge;
    return {
      ...edge,
      evidence: edge.evidence ? TokenBudgetTrimmer.trimText(edge.evidence, 120) : edge.evidence,
    };
  }

  static #selectGraphEdges(edges = [], edgeBudget) {
    const normalized = TokenBudgetTrimmer.#normalizeArray(edges);
    const selected = [];
    const seen = new Set();
    const connects = normalized
      .filter((item) => item.rel === 'connects')
      .sort((left, right) => (
        (right.sharedOccurrenceCount ?? 0) - (left.sharedOccurrenceCount ?? 0)
        || (right.confidence ?? 0) - (left.confidence ?? 0)
      ));
    const add = (edge) => {
      const key = `${edge?.from}->${edge?.to}|${edge?.rel}`;
      if (!edge || seen.has(key) || selected.length >= edgeBudget) return;
      selected.push(edge);
      seen.add(key);
    };
    const addSome = (items, limit) => {
      let count = 0;
      for (const edge of items) {
        if (count >= limit || selected.length >= edgeBudget) return;
        const before = selected.length;
        add(edge);
        if (selected.length > before) count += 1;
      }
    };

    addSome(normalized.filter((item) => item.rel === 'orchestrates'), Math.max(1, Math.floor(edgeBudget * 0.25)));
    addSome(connects, Math.max(1, Math.floor(edgeBudget * 0.35)));
    addSome(normalized.filter((item) => item.rel === 'evidence-primary'), Math.max(1, Math.floor(edgeBudget * 0.2)));
    addSome(normalized.filter((item) => item.rel === 'integrates-with'), Math.max(1, Math.floor(edgeBudget * 0.1)));
    for (const edge of normalized) add(edge);

    return selected;
  }

  static #trimQuery(query) {
    if (!query || typeof query !== 'object') return query;
    return {
      ...query,
      query: TokenBudgetTrimmer.trimText(query.query, 80),
      intent: TokenBudgetTrimmer.trimText(query.intent, 32),
      question: query.question
        ? {
          who: TokenBudgetTrimmer.trimText(query.question.who, 80),
          what: TokenBudgetTrimmer.trimText(query.question.what, 120),
          where: TokenBudgetTrimmer.trimText(query.question.where, 80),
          when: TokenBudgetTrimmer.trimText(query.question.when, 80),
          why: TokenBudgetTrimmer.trimText(query.question.why, 120),
          how: TokenBudgetTrimmer.trimText(query.question.how, 120),
        }
        : query.question,
      budget: query.budget,
    };
  }

  static #normalizeArray(value) {
    return Array.isArray(value) ? value : [];
  }
}
