// Console output is allowed here (see eslint.config.mjs): this script writes the spec to stdout.
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { createLogger } from './lib/logger/logger.ts';

/** Builds the app with inert dependencies and returns its OpenAPI document as YAML. */
export async function generateOpenApiYaml(): Promise<string> {
  const logger = createLogger({
    service: 'openapi',
    version: 'openapi',
    environment: 'test',
    level: 'silent',
    format: 'json',
    output: 'stdout',
    redactPatterns: [],
  });
  const app = await buildApp({ logger, version: 'openapi', checkDb: () => Promise.resolve(true) });
  try {
    return app.swagger({ yaml: true });
  } finally {
    await app.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(await generateOpenApiYaml());
}
