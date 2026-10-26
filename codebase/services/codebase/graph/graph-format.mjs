export class GraphFlowFormatter {
  static format(result) {
    if (!result || result.object !== 'GraphFlow') return null;
    const {
      flow, focus, messages, error,
    } = result;
    if (error) return `${flow}: ${focus}\n  ⚠ ${error}\n`;
    if (!messages?.length) return `${flow}: ${focus}\n  (empty)\n`;

    const formatters = {
      contain: this.#contain,
      call: this.#call,
      dep: this.#dep,
      data: this.#data,
      seq: this.#seq,
    };
    const fn = formatters[flow];
    return fn ? fn.call(this, focus, messages) : this.#fallback(flow, focus, messages);
  }

  static #contain(focus, messages) {
    const lines = [`${focus}`];
    const self = messages[0];
    if (self) lines[0] = `${self.symbol} [${self.kind}:${self.line ?? '?'}]`;

    const children = messages.filter((m) => m.depth >= 1);
    const lastSibling = new Array(children.length);
    for (let i = 0; i < children.length; i += 1) {
      lastSibling[i] = this.#isLast(children, i, children[i].depth);
    }

    const parentIsLast = [false, false, false, false, false];

    for (let i = 0; i < children.length; i += 1) {
      const m = children[i];
      const last = lastSibling[i];
      if (m.depth <= 1) parentIsLast[1] = last;

      const prefix = this.#buildPrefix(m.depth, last, parentIsLast);
      const label = this.#formatLabel(m);
      lines.push(`${prefix}${label}`);
    }
    return `${lines.join('\n')}\n`;
  }

  static #buildPrefix(depth, last, parentIsLast) {
    let p = '';
    for (let d = 1; d < depth; d += 1) {
      p += parentIsLast[d] ? '    ' : '│   ';
    }
    return p + (last ? '└── ' : '├── ');
  }

  static #formatLabel(m) {
    if (m.direction === 'import') return `⬇ ${m.symbol} {${(m.bindings ?? []).join(', ')}}`;
    if (m.direction === 'export') return `⬆ ${m.symbol}`;
    if (m.direction === 'calls') return `→ ${m.symbol} [:${m.line}]`;
    if (m.direction === 'input') return `◁ ${m.symbol}`;
    if (m.direction === 'child') return `${m.symbol} [${m.kind}:${m.line ?? '?'}]`;
    return m.symbol;
  }

  static #call(focus, messages) {
    const lines = [`${focus}`];
    const callees = messages.filter((m) => m.direction === 'callee');
    const callers = messages.filter((m) => m.direction === 'caller');

    if (callees.length) {
      lines.push('  out:');
      for (const c of callees) lines.push(`    → ${c.symbol} [:${c.line}]`);
    }
    if (callers.length) {
      lines.push('  in:');
      for (const c of callers) lines.push(`    ← ${c.symbol} [${c.file}:${c.line}]`);
    }
    return `${lines.join('\n')}\n`;
  }

  static #dep(focus, messages) {
    const lines = [`${focus}`];
    const out = messages.filter((m) => m.direction === 'depends_on');
    const inbound = messages.filter((m) => m.direction === 'depended_by');

    if (out.length) {
      lines.push('  imports:');
      for (const d of out) {
        const bindings = d.bindings?.length ? ` {${d.bindings.join(', ')}}` : '';
        lines.push(`    → ${d.symbol}${bindings} [:${d.line}]`);
      }
    }
    if (inbound.length) {
      lines.push('  imported by:');
      for (const d of inbound) lines.push(`    ← ${d.symbol}`);
    }
    return `${lines.join('\n')}\n`;
  }

  static #data(focus, messages) {
    const sources = messages.filter((m) => m.direction === 'source');
    const transforms = messages.filter((m) => m.direction === 'transform');
    const sinks = messages.filter((m) => m.direction === 'sink');

    const lines = [`${focus}`];
    if (sources.length) {
      lines.push(`  ◁ ${sources.map((s) => s.symbol).join(', ')}`);
    }
    for (const t of transforms) {
      const args = t.args?.length ? `(${t.args.map(this.#shortArg).join(', ')})` : '';
      lines.push(`  → ${t.symbol}${args} [:${t.line}]`);
    }
    for (const s of sinks) {
      lines.push(`  ▷ ${s.symbol} [:${s.line}]`);
    }
    return `${lines.join('\n')}\n`;
  }

  static #seq(focus, messages) {
    const lines = [`${focus}`];
    for (const m of messages) {
      if (m.direction === 'start') lines.push(`  ● ${m.symbol} [:${m.line}]`);
      else if (m.direction === 'step') lines.push(`  ${'  '.repeat(m.depth - 1)}→ ${m.symbol} [:${m.line}]`);
      else if (m.direction === 'end') lines.push(`  ${'  '.repeat(m.depth - 1)}◉ ${m.symbol} [:${m.line}]`);
      else if (m.direction === 'unresolved') lines.push(`  ⚠ unresolved → ${m.symbol}`);
    }
    return `${lines.join('\n')}\n`;
  }

  static #fallback(flow, focus, messages) {
    const lines = [`${flow}: ${focus}`];
    for (const m of messages) {
      lines.push(`${'  '.repeat(m.depth + 1)}${m.direction} ${m.symbol} [${m.kind}:${m.line ?? '?'}]`);
    }
    return `${lines.join('\n')}\n`;
  }

  static #isLast(msgs, index, depth) {
    for (let i = index + 1; i < msgs.length; i += 1) {
      if (msgs[i].depth < depth) return true;
      if (msgs[i].depth === depth) return false;
    }
    return true;
  }

  static #shortArg(arg) {
    return arg.length > 30 ? `${arg.slice(0, 27)}...` : arg;
  }
}

export function formatGraphFlow(result) {
  return GraphFlowFormatter.format(result);
}
