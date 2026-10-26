import { ErrorObject } from '../../common/lib/error-object.mjs';

export function formatCliError({
  command = null, message, code = 'CLI_ERROR', exitCode = 2, usage = null, context = null,
}, format = 'md') {
  const error = new ErrorObject({
    code,
    message: cleanMessage(message),
    context: {
      command,
      usage: usage ?? undefined,
      ...visibleContext(context),
    },
  });

  const errorJson = error.toJSON();
  const diagnostic = {
    object: 'CliError',
    command,
    status: 'error',
    exitCode,
    ...errorJson,
    context: visibleContext(errorJson.context),
    ...(usage ? { usage } : {}),
  };
  if (format === 'json') return `${JSON.stringify(diagnostic)}\n`;
  return `${diagnostic.message}${usage ? `\nUsage: ${usage}` : ''}\n`;
}

function cleanMessage(message) {
  return String(message ?? 'CLI command failed').trim();
}

function visibleContext(context) {
  if (!context || typeof context !== 'object') return {};
  return Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'stack' && key !== 'cause'));
}
