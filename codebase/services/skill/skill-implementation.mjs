import { SkillLoader } from '../../extractors/skill-loader.mjs';
import { cacheKeyFor } from '../../db/cache-key.mjs';

export class SkillImplementation {
  constructor({ projectionSession = null } = {}) {
    this.projectionSession = projectionSession;
  }

  #sourceOwner(root) {
    if (typeof this.projectionSession?.sourceOwnerFor !== 'function') {
      const error = new Error('Skill service requires a Unified Data Service source capability.');
      error.code = 'UNIFIED_DATA_SERVICE_REQUIRED';
      throw error;
    }
    return this.projectionSession.sourceOwnerFor(root);
  }

  #runData(root, callback) {
    if (!this.projectionSession || this.projectionSession.root !== root) {
      const error = new Error('Skill service requires a Unified Data Service projection session.');
      error.code = 'UNIFIED_DATA_SERVICE_REQUIRED';
      throw error;
    }
    return callback(this.projectionSession.store, this.projectionSession.cacheSession);
  }

  async query({ root, query = '', limit } = {}) {
    const loader = this.#loader(root);
    const coordinate = await this.#runData(root, async (fileBlockStore) => (
      cachedSkillCoordinate(readSkillBlocks(fileBlockStore, root), query)
    ));
    const ranked = query ? coordinate.skills.filter((skill) => skill.score > 0) : coordinate.skills;
    const selected = ranked.slice(0, limit);
    const skills = [];
    for (const skill of selected) {
      const projected = projectSkill(skill);
      projected.tree = await loader.dir({ name: skill.name, projectRoot: root });
      skills.push(projected);
    }
    return {
      object: 'SkillReport',
      query,
      root: coordinate.root,
      count: selected.length,
      total: coordinate.count,
      skills,
      capability: {
        project: coordinate.skills.some((skill) => skill.scope === 'project') ? 'available' : 'missing',
        global: coordinate.skills.some((skill) => skill.scope === 'global') ? 'available' : 'missing',
        root,
      },
    };
  }

  async load({ root, name, into = [] } = {}) {
    return this.#loader(root).load({ name, projectRoot: root, into });
  }

  async list({ root } = {}) {
    return this.#loader(root).list({ projectRoot: root });
  }

  #loader(root) {
    return new SkillLoader({
      projectRoot: root,
      fileOwnerForRoot: (sourceRoot) => this.#sourceOwner(sourceRoot),
    });
  }
}

// The skills FileBlocks of this root, read from the store by SQL so they are
// available whether or not this run rebuilt them.
function readSkillBlocks(fileBlockStore, root) {
  const rows = fileBlockStore.query({
    sql: "SELECT json(value) AS value FROM file_blocks WHERE owner = 'skills' AND cache_key = ? ORDER BY file_path",
    params: [cacheKeyFor('skills', root)],
  });
  return { blocks: rows.map((row) => ({ value: JSON.parse(row.value) })) };
}

function cachedSkillCoordinate(result, queryText) {
  const byName = new Map();
  for (const block of result?.blocks ?? []) {
    const value = block.value ?? {};
    if (!value.name || byName.has(value.name)) continue;
    const sections = Object.values(value.sections ?? {});
    const summary = String(value.content ?? '').split(/\r?\n/).find((line) => line.startsWith('# '))?.replace(/^#\s+/, '') ?? '';
    const procedureHeadings = sections.map((section) => section.heading).filter(Boolean);
    const skill = {
      name: value.name,
      path: value.path,
      scope: value.scope ?? 'project',
      title: summary || value.name,
      description: sections[0]?.content ?? '',
      summary,
      procedureHeadings,
    };
    const tokens = String(queryText ?? '').toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
    const haystack = [skill.name, skill.title, skill.description, skill.summary, skill.procedureHeadings.join(' ')].join(' ').toLowerCase();
    const matches = tokens.filter((token) => haystack.includes(token)).length;
    byName.set(skill.name, { ...skill, score: tokens.length === 0 ? 1 : (matches ? matches / tokens.length : 0) });
  }
  const skills = [...byName.values()].sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  return {
    root: skills.length > 0 ? 'skills+global' : null,
    count: skills.length,
    skills,
    edges: skills.map((skill) => ({
      from: `skill:${skill.name}`, to: 'owner:skills', rel: 'governs', evidence: skill.path, confidence: 1,
    })),
  };
}

function projectSkill(skill) {
  return {
    name: skill.name,
    path: skill.path,
    scope: skill.scope,
    score: Number(skill.score.toFixed(3)),
    title: skill.title,
    description: skill.description,
  };
}
