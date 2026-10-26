export class CommandTimer {
  constructor({ progress, failCommand }) {
    this.progress = progress;
    this.failCommand = failCommand;
    this.commandTimeoutMs = null;
    this.commandTimedOut = false;
    this.timeoutActive = false;
    this.heartbeatTimer = null;
    this.progressEvents = [];
    this.commandStartedAt = null;
  }

  sync({
    commandStartedAt, progressEvents, quiet, env,
  }) {
    this.commandStartedAt = commandStartedAt;
    this.progressEvents = progressEvents;
    this.quiet = quiet;
    this.env = env;
  }

  async withTimeout(operation, { timeoutMs = null, label = 'ctx.command' } = {}) {
    if (this.timeoutActive) return operation();
    const budget = Number(timeoutMs);
    if (!Number.isFinite(budget) || budget <= 0) return operation();
    this.timeoutActive = true;
    this.commandTimeoutMs = Math.floor(budget);
    this.progress(`${label}.start`, { timeout_ms: this.commandTimeoutMs });
    this.#startHeartbeat();
    let timer;
    let settled = false;
    const controller = new AbortController();
    try {
      return await new Promise((resolve, reject) => {
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback(value);
        };
        timer = setTimeout(() => {
          const lastStep = this.progressEvents.at(-1)?.step ?? null;
          this.commandTimedOut = true;
          controller.abort();
          this.progress(`${label}.timeout`, { timeout_ms: this.commandTimeoutMs, last_step: lastStep ?? 'none' });
          const error = new Error(`${label} timed out after ${this.commandTimeoutMs} ms; last_step=${lastStep ?? 'none'}`);
          error.name = 'CliTimeoutError';
          error.code = 'CLI_TIMEOUT';
          error.exitCode = 124;
          error.lastStep = lastStep;
          this.failCommand({ exit_code: error.exitCode, error: { code: error.code, message: error.message, last_step: lastStep } });
          finish(reject, error);
        }, this.commandTimeoutMs);
        timer.unref?.();
        Promise.resolve()
          .then(() => operation(controller.signal))
          .then((value) => finish(resolve, value), (error) => finish(reject, error));
      });
    } finally {
      clearTimeout(timer);
      this.#stopHeartbeat();
      this.timeoutActive = false;
    }
  }

  observation({ status = this.commandTimedOut ? 'timeout' : 'ok', timeoutMs = this.commandTimeoutMs } = {}) {
    return {
      object: 'CommandObservation',
      status,
      elapsed_ms: this.commandStartedAt === null ? 0 : Math.max(0, Math.round(performance.now() - this.commandStartedAt)),
      timeout_ms: timeoutMs ?? null,
      last_step: this.progressEvents.at(-1)?.step ?? null,
      steps: this.progressEvents,
    };
  }

  stopHeartbeat() {
    this.#stopHeartbeat();
  }

  #startHeartbeat() {
    if (this.heartbeatTimer || this.quiet || this.env?.CTX_PROGRESS === '0') return;
    this.heartbeatTimer = setInterval(() => {
      this.progress('heartbeat', { last_step: this.progressEvents.at(-1)?.step ?? 'none' });
    }, 5000);
    this.heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
