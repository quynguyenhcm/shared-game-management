import { createServer } from 'node:http';
import { loadConfigOrExit } from './lib/config/config.ts';
import { createLogger, loggerOptionsFromConfig } from './lib/logger/logger.ts';

// Boot order (AC-ERROR-1): config validation first; nothing binds a port or takes jobs before it passes.
const config = loadConfigOrExit();
const logger = createLogger(loggerOptionsFromConfig(config, 'worker'));

// TODO(Phase 5): start pg-boss and register queues/schedules; this skeleton only serves its health port.
const healthServer = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', version: config.serviceVersion }));
    return;
  }
  response.writeHead(404).end();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'worker shutting down');
    healthServer.close(() => process.exit(0));
  });
}

healthServer.listen(config.workerHealthPort, '0.0.0.0', () => {
  logger.info({ port: config.workerHealthPort }, 'worker health server listening');
});
