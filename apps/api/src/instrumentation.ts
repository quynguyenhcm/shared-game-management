// OpenTelemetry bootstrap, loaded before the entrypoint: `node --import ./dist/instrumentation.js`
// (compose) or `tsx watch --import ./src/instrumentation.ts` (pnpm run dev). See lib/telemetry.
// Invalid configuration starts nothing here: the entrypoint's loadConfigOrExit reports it and exits.
import { basename } from 'node:path';
import { loadConfig } from './lib/config/config.ts';
import { startTelemetry, telemetryOptionsFromConfig } from './lib/telemetry/telemetry.ts';

const entry = basename(process.argv[1] ?? '');
const defaultServiceName = entry.startsWith('worker') ? 'sgm-worker' : 'sgm-api';

let config: ReturnType<typeof loadConfig> | undefined;
try {
  config = loadConfig();
} catch {
  config = undefined;
}

export const telemetry = config
  ? startTelemetry(telemetryOptionsFromConfig(config, defaultServiceName))
  : undefined;
