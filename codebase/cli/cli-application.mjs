import { CliRuntime } from './cli-runtime.mjs';
import { formatCliError } from './cli-errors.mjs';
import {
  CLI_MODULE_SET, TOOLS_SCHEMA, getMethodSpec, getServiceModule, payloads,
} from '../../common/tools/tools.schema.mjs';
import { GLOBAL_FLAGS, argvOf, getUsage } from './cli-argv.mjs';

export class CliApplication {
  constructor({
    stdout,
    stderr,
    runtimeFactory,
    runtimePorts,
    installExitHandler,
  } = {}) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.runtimeFactory = runtimeFactory;
    this.runtimePorts = runtimePorts;
    this.installExitHandler = installExitHandler;
    if (!stdout || !stderr) throw new TypeError('CliApplication requires injected output ports.');
  }

  async run({ args = [] } = {}) {
    const routeArgs = normalizeHelpArgs(args);
    const action = resolveAction(routeArgs);
    if (!action) {
      await this.writeStderr(formatCliError({
        command: routeArgs[0] ?? 'ctx',
        code: 'CLI_UNKNOWN_COMMAND',
        message: `Unknown command: ${routeArgs[0] ?? 'ctx'}.`,
        usage: 'ctx help',
      }));
      return 2;
    }

    const spec = getMethodSpec(action.target, action.method);
    if (!spec) return this.#error(routeArgs, 'CLI_COMMAND_UNAVAILABLE', `Unknown method: ${action.target}.${action.method}.`, action.target, action.method);

    const runtime = this.runtimeFactory
      ? this.runtimeFactory({
        ...this.runtimePorts, command: action.target, outputFmt: routeArgs.includes('--json') ? 'json' : 'md', quiet: routeArgs.includes('--quiet') || routeArgs.includes('-q'), stdout: this.stdout, stderr: this.stderr,
      })
      : new CliRuntime({
        ...this.runtimePorts,
        command: action.target,
        outputFmt: routeArgs.includes('--json') ? 'json' : 'md',
        quiet: routeArgs.includes('--quiet') || routeArgs.includes('-q'),
        stdout: this.stdout,
        stderr: this.stderr,
        help: null,
      });
    (this.installExitHandler ?? ((value) => value.installExitHandler()))(runtime);

    try {
      const payload = parsePayload(spec, action, runtime);
      if (CLI_MODULE_SET.has(action.target) && !runtime.isModuleEnabled({ module: action.target, root: payload.root })) {
        throw Object.assign(new Error(
          `The ${action.target} module is disabled for ${payload.root}. Enable modules.${action.target} in project or user configuration, then retry.`,
        ), { code: 'MODULE_DISABLED' });
      }
      const modulePath = getServiceModule(action.target);
      const module = await import(`../../${modulePath}`);
      const ownerName = `${capitalize(action.target)}Service`;
      const Owner = module[ownerName];
      if (typeof Owner !== 'function') throw new Error(`Owner ${ownerName} is unavailable for ${action.target}.`);
      const owner = new Owner({ runtime, dataService: runtime.toolsApi });
      const result = await owner[action.method](payload);
      if (typeof result === 'string') await runtime.writeStdout(result);
      else if (result !== undefined) await runtime.writeStdout(runtime.emit(result));
      runtime.finishCommand();
      return result?.exitCode ?? 0;
    } catch (error) {
      if (runtime.commandFinished) return error?.exitCode ?? 1;
      return this.#error(routeArgs, error.code ?? 'CLI_COMMAND_FAILED', error.message ?? String(error), action.target, action.method);
    }
  }

  async #error(args, code, message, command = args[0] ?? 'ctx', methodName = null) {
    await this.writeStderr(formatCliError({
      command, code, message, usage: getUsage(command, methodName),
    }));
    return code === 'CLI_ARGUMENT' ? 2 : 1;
  }

  async writeStdout(text) {
    await new Promise((resolve) => {
      this.stdout.write(text, resolve);
    });
  }

  async writeStderr(text) {
    await new Promise((resolve) => {
      this.stderr.write(text, resolve);
    });
  }
}

function normalizeHelpArgs(args) {
  if (args.length === 0) return ['help'];
  if (args[0] === 'help') return args;
  if (args.includes('--help') || args.includes('-h')) return ['help', ...(args.includes('--full') ? ['--full'] : [])];
  return args;
}

function resolveAction(args) {
  const target = args[0];
  if (!Object.hasOwn(TOOLS_SCHEMA, target)) return null;
  const rest = args.slice(1);
  const methods = Object.keys(TOOLS_SCHEMA[target]);
  const explicitMethod = methods.includes(rest[0]) ? rest[0] : null;
  if (explicitMethod) return { target, method: explicitMethod, rawArgs: rest.slice(1) };
  const commonFlags = new Set([GLOBAL_FLAGS.quiet.flag, ...GLOBAL_FLAGS.quiet.aliases, GLOBAL_FLAGS.json.flag, GLOBAL_FLAGS.root.flag]);
  if (methods.length > 1) {
    const flagMethod = methods.find((method) => {
      const flags = Object.values(argvOf(TOOLS_SCHEMA[target][method]))
        .map((def) => def.flag)
        .filter((flag) => flag && !commonFlags.has(flag));
      return rest.some((value) => flags.includes(value.split('=', 1)[0]));
    });
    if (flagMethod) return { target, method: flagMethod, rawArgs: rest };
  }
  if (methods.length === 1 || rest.every((value) => commonFlags.has(value) || !value.startsWith('-'))) {
    return { target, method: methods[0], rawArgs: rest };
  }
  return null;
}

function parsePayload(spec, action, runtime) {
  const argvMap = argvOf(spec);
  const { rawArgs } = action;
  const payload = {};
  const positional = [];
  const consumedPositionals = new Set();

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg.startsWith('-')) {
      const [flag, inline] = arg.split('=', 2);
      if (flag === GLOBAL_FLAGS.root.flag) {
        index += 1; continue;
      }
      if (flag === GLOBAL_FLAGS.json.flag || flag === GLOBAL_FLAGS.quiet.flag || GLOBAL_FLAGS.quiet.aliases.includes(flag)) continue;
      const name = Object.keys(argvMap).find((key) => argvMap[key].flag === flag);
      if (!name) throw argumentError(`Unknown option: ${flag}.`);
      const def = argvMap[name];
      if (def.type === 'boolean') payload[name] = true;
      else {
        const value = inline ?? rawArgs[++index];
        if (!value || value.startsWith('--')) throw argumentError(`${flag} requires a value.`);
        payload[name] = convertValue(value, def);
      }
    } else positional.push(arg);
  }

  for (const [name, def] of Object.entries(argvMap)) {
    if (!Number.isInteger(def.position) && !def.rest) continue;
    const start = def.position ?? 0;
    const values = def.rest ? positional.slice(start) : [positional[start]];
    if (values.length === 0 || values[0] === undefined) continue;
    if (def.rest) {
      for (let index = start; index < positional.length; index += 1) consumedPositionals.add(index);
    } else {
      consumedPositionals.add(start);
    }
    if (def.rest && def.type === 'string') payload[name] = values.join(' ');
    else payload[name] = def.type === 'array' || def.rest ? values.map((value) => convertValue(value, { ...def, type: 'string' })) : convertValue(values[0], def);
  }

  const unexpected = positional.find((value, index) => !consumedPositionals.has(index));
  if (unexpected !== undefined) throw argumentError(`Unexpected argument: ${unexpected}.`);

  if (payload.root === undefined) payload.root = runtime.resolveRoot(rawArgs, { activate: false });
  if (payload.owners && typeof payload.owners === 'string') payload.owners = payload.owners.split(',').map((value) => value.trim()).filter(Boolean);
  return admitPayload(`${action.target}.${action.method}`, payload);
}

// The payload is admitted by tools.schema.json: required, minimum, enum and the
// schema defaults are applied here, so a service receives a complete payload.
function admitPayload(key, payload) {
  try {
    return payloads[key](payload).$withDefaults().$toDict();
  } catch (error) {
    throw argumentError((error.errors ?? [error]).map((entry) => entry.message).join('; '));
  }
}

function convertValue(value, def) {
  if (def.type === 'integer') {
    const result = Number(value);
    if (!Number.isInteger(result)) throw argumentError(`${value} must be an integer.`);
    return result;
  }
  if (def.type === 'array') return String(value).split(',').map((item) => item.trim()).filter(Boolean);
  return value;
}

function argumentError(message) {
  const error = new Error(message);
  error.code = 'CLI_ARGUMENT';
  return error;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default CliApplication;
