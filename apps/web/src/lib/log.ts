/**
 * Minimal structured logger for the web server (one JSON object per line). No OpenTelemetry SDK is
 * registered in web, so there is no span context to attach; callers pass only non-sensitive fields
 * (never tokens, passwords, emails or addresses).
 */
type Level = 'info' | 'warn' | 'error';

function write(
  level: Level,
  event: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    service: process.env.OTEL_SERVICE_NAME ?? 'sgm-web',
    event,
    ...fields,
  });
  (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
}

export const log = {
  info: (event: string, fields: Record<string, string | number | boolean | null> = {}) =>
    write('info', event, fields),
  warn: (event: string, fields: Record<string, string | number | boolean | null> = {}) =>
    write('warn', event, fields),
  error: (event: string, fields: Record<string, string | number | boolean | null> = {}) =>
    write('error', event, fields),
};
