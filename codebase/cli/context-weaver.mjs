#!/usr/bin/env node

import './runtime-warning-policy.mjs';

const { spawn } = await import('node:child_process');
const { CliApplication } = await import('./cli-application.mjs');

const app = new CliApplication({
  stdout: process.stdout,
  stderr: process.stderr,
  runtimePorts: {
    exit: (code) => process.exit(code),
    cwd: () => process.cwd(),
    env: process.env,
    executablePath: process.argv[1],
    nodePath: process.execPath,
    spawnChild: spawn,
    onExit: (listener) => process.once('exit', listener),
    home: process.env.HOME,
  },
});
process.exitCode = await app.run({ args: process.argv.slice(2) });
