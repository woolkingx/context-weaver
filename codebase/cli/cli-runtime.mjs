import { spawn } from 'node:child_process';

import { AuditLogger, defaultAuditLogPath, errorFields } from '../../common/audit-logger.mjs';
import { ConfigOwner } from '../../common/config/config-loader.mjs';
import { getUsage } from './cli-argv.mjs';
import { MarkdownRenderer } from '../projection/markdown-renderer.mjs';
import { isProjectContainer, normalizeRoot as sharedNormalizeRoot } from '../../common/lib/normalize-root.mjs';

import { cleanContentMarkdown, compactHumanOutput } from './cli-output-format.mjs';
import { CommandTimer } from './command-timer.mjs';
import { CTX_FEEDBACK } from './ctx-feedback.mjs';
import { formatCliError } from './cli-errors.mjs';
import { UnifiedDataService } from '../data-service/unified-data-service.mjs';
import { OutputClass } from './output-class.mjs';

export class CliRuntime {
  constructor({
    command,
    outputFmt,
    quiet = false,
    help,
    stdout,
    stderr,
    exit,
    cwd,
    env,
    executablePath,
    nodePath,
    spawnChild = spawn,
    onExit,
    home,
    configOwner = new ConfigOwner(),
    toolsApi = null,
    projectionSession = null,
  }) {
    this.command = command;
    this.outputFmt = outputFmt;
    this.quiet = Boolean(quiet);
    this.help = help;
    this.stdout = stdout;
    this.stderr = stderr;
    this.ports = Object.freeze({
      stdout, stderr, exit, cwd, env, spawn: spawnChild, executablePath, nodePath, onExit,
    });
    this.exit = exit;
    this.cwd = cwd;
    this.env = env;
    this.executablePath = executablePath;
    this.nodePath = nodePath;
    if (!stdout || !stderr || typeof exit !== 'function' || typeof cwd !== 'function' || !env || !executablePath || !nodePath || typeof onExit !== 'function') {
      throw new TypeError('CliRuntime requires injected runtime ports.');
    }
    this.spawnChild = spawnChild;
    this.onExit = onExit;
    this.home = home;
    this.configOwner = configOwner;
    this.toolsApi = toolsApi ?? new UnifiedDataService({ runtime: this });
    this.output = new OutputClass({
      format: outputFmt,
      stdout,
      feedback: CTX_FEEDBACK,
      humanSerializer: (data) => MarkdownRenderer.renderDocument(cleanContentMarkdown(compactHumanOutput(data))),
    });

    this.projectionSession = projectionSession;
    this.activeAuditContext = { command, cwd: this.cwd() };
    this.commandStartedAt = null;
    this.commandFinished = false;
    this.errorFields = errorFields;
    this.progressEvents = [];
    this.timer = new CommandTimer({
      progress: (step, fields) => this.progress(step, fields),
      failCommand: (fields) => this.failCommand(fields),
    });
  }

  installExitHandler() {
    this.onExit((code) => {
      if (this.commandStartedAt === null || this.commandFinished) return;
      this.auditEvent(code === 0 ? 'ctx.command.end' : 'ctx.command.error', {
        level: code === 0 ? 'info' : 'error',
        duration_ms: Math.round(performance.now() - this.commandStartedAt),
        exit_code: code,
      });
    });
  }

  emit(data, fmt = this.outputFmt, maxChars) {
    return this.output.emit(data, { format: fmt, maxChars });
  }

  setAuditContext(fields) {
    this.activeAuditContext = { ...this.activeAuditContext, ...fields };
  }

  auditEvent(event, fields = {}) {
    this.auditLogger?.event(event, { ...this.activeAuditContext, ...fields });
  }

  progress(step, fields = {}) {
    this.auditEvent('ctx.progress', { step, ...fields });
    const safeFields = Object.fromEntries(Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && typeof value !== 'object'));
    this.progressEvents.push({
      step,
      ...safeFields,
      elapsed_ms: this.commandStartedAt === null ? 0 : Math.round(performance.now() - this.commandStartedAt),
    });
    if (this.quiet || this.env.CTX_PROGRESS === '0') return;
    const details = Object.entries(safeFields)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    this.stderr.write(`[ctx] ${step}${details ? ` ${details}` : ''}\n`);
  }

  startCommand(fields = {}) {
    this.setAuditContext(fields);
    if (this.commandStartedAt !== null) return;
    this.commandStartedAt = performance.now();
    this.progressEvents = [];
    this.timer.commandTimedOut = false;
    this.auditEvent('ctx.command.start');
  }

  finishCommand(fields = {}) {
    if (this.commandFinished) return;
    if (this.commandStartedAt === null) this.startCommand();
    this.commandFinished = true;
    this.timer.stopHeartbeat();
    this.auditEvent('ctx.command.end', {
      duration_ms: Math.round(performance.now() - this.commandStartedAt),
      exit_code: 0,
      ...fields,
    });
  }

  failCommand(fields = {}) {
    if (this.commandFinished) return;
    if (this.commandStartedAt === null) this.startCommand();
    this.commandFinished = true;
    this.timer.stopHeartbeat();
    this.auditEvent('ctx.command.error', {
      level: 'error',
      duration_ms: Math.round(performance.now() - this.commandStartedAt),
      ...fields,
    });
  }

  fail(message, { code = 'CLI_COMMAND_ERROR', exitCode = 2, usage = getUsage(this.command, null) } = {}) {
    const error = { name: 'CtxFail', code, message: String(message).trim() };
    this.auditEvent('ctx.exit.error', {
      level: 'error',
      exit_code: exitCode,
      error,
    });
    this.failCommand({ exit_code: exitCode, error });
    this.stderr.write(formatCliError({
      command: this.command, code, exitCode, message, usage,
    }, this.outputFmt));
    this.exit(exitCode);
  }

  writeStdout(output) {
    if (this.timer.commandTimedOut) return Promise.resolve();
    return this.output.write(output);
  }

  withTimeout(operation, options) {
    this.timer.sync({
      commandStartedAt: this.commandStartedAt, progressEvents: this.progressEvents, quiet: this.quiet, env: this.env,
    });
    return this.timer.withTimeout(operation, options);
  }

  get commandTimedOut() {
    return this.timer.commandTimedOut;
  }

  get commandTimeoutMs() {
    return this.timer.commandTimeoutMs;
  }

  observation(options) {
    this.timer.sync({
      commandStartedAt: this.commandStartedAt, progressEvents: this.progressEvents, quiet: this.quiet, env: this.env,
    });
    return this.timer.observation(options);
  }

  async openProjectionSession(root, { owners, filePathsQuery = null } = {}) {
    if (this.projectionSession) {
      if (this.projectionSession.root !== root || owners.some((owner) => !this.projectionSession.owners.includes(owner))) {
        throw new Error('The active ToolsApi projection session does not admit this root or owner set.');
      }
      this.progress('session.reuse', { owners: owners.join(',') });
      return this.projectionSession;
    }
    return this.toolsApi.openProjectionSession({
      root,
      owners,
      config: this.getConfig(root),
      auditLogger: this.auditLogger,
      progress: (step, fields) => this.progress(step, fields),
      filePathsQuery,
    });
  }

  async withProjectionSession(root, owners, callback) {
    const session = await this.openProjectionSession(root, { owners });
    const ownsSession = session !== this.projectionSession;
    try {
      return await callback(session);
    } finally {
      if (ownsSession) session.close();
    }
  }

  resolveRoot(rawArgs, { activate = true } = {}) {
    const i = rawArgs.indexOf('--root');
    const root = normalizeRoot(i !== -1 && rawArgs[i + 1] ? rawArgs[i + 1] : this.cwd());
    if (activate) {
      try {
        this.activateConfig(root);
      } catch (error) {
        this.fail(`Configuration is invalid for ${root}: ${error.message}\n`);
      }
    }
    return root;
  }

  // `modules.<name>` in the configuration is the switch of a semantic module.
  isModuleEnabled({ module, root = this.activeAuditContext.root ?? this.cwd() }) {
    return this.getConfig(root).values.modules?.[module] !== false;
  }

  assertValidProjectRoot(root) {
    if (isProjectContainer(root)) {
      this.fail(
        `ctx: "${root}" looks like a project container (multiple repos inside, no project sentinel at root).\n`
        + 'Run ctx from inside a specific project, e.g.:\n'
        + `  ctx sql "..." --root "${root}/<project-name>"\n`,
      );
    }
  }

  getConfig(root = this.activeAuditContext.root ?? this.cwd()) {
    const normalizedRoot = normalizeRoot(root);
    if (this.config?.root === normalizedRoot) return this.config;
    return this.activateConfig(normalizedRoot);
  }

  activateConfig(root) {
    const config = this.configOwner.resolve({
      root,
      env: this.env,
      ...(this.home ? { home: this.home } : {}),
    });
    this.config = config;
    this.auditLogger = new AuditLogger({
      logPath: defaultAuditLogPath(new Date(), config.paths),
      base: { command: this.command, cwd: this.cwd() },
    });
    this.activeAuditContext = { ...this.activeAuditContext, root };
    return config;
  }
}

const normalizeRoot = sharedNormalizeRoot;
