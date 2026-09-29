// Console output is allowed here (see eslint.config.mjs): the CLI talks to a terminal, not the logger.
import { loadConfigOrExit, type Config } from './lib/config/config.ts';
import { QUEUE_NAMES } from './jobs/registry.ts';
import { SCHEDULES } from './jobs/schedules.ts';
import { migrateToLatest, resetDatabase, rollbackMigrations } from './lib/db/migrate.ts';
import { createJobRunner } from './lib/jobs/jobs.ts';
import { createLogger, loggerOptionsFromConfig } from './lib/logger/logger.ts';

const COMMANDS: Record<string, { subcommands: readonly string[] }> = {
  db: { subcommands: ['migrate', 'rollback', 'reset'] },
  jobs: { subcommands: ['trigger', 'schedules'] },
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

function usage(): string {
  return [
    ...Object.entries(COMMANDS).map(
      ([name, { subcommands }]) => `  ${name} ${subcommands.join('|')}`,
    ),
    '  db rollback [--count N | --all]   (default: one step)',
    '  db reset [--force]                (refused in production or on a non-local host)',
    '  jobs trigger <slot|heartbeat> [json]   (manually enqueue a slot or the heartbeat job)',
    '  jobs schedules                         (list registered cron schedules)',
  ].join('\n');
}

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

/** `--count N` / `--count=N` / `--all`; one step by default. */
function rollbackCount(flags: readonly string[]): number {
  if (flags.includes('--all')) return Infinity;
  const inline = flags.find((flag) => flag.startsWith('--count='));
  const index = flags.indexOf('--count');
  const raw = inline ? inline.slice('--count='.length) : index >= 0 ? flags[index + 1] : undefined;
  if (raw === undefined) return 1;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) fail('--count must be a positive integer');
  return count;
}

function assertResettable(config: Config, flags: readonly string[]): void {
  if (config.nodeEnv === 'production') fail('db reset is refused when NODE_ENV=production', 1);
  const host = new URL(config.databaseUrl).hostname;
  if (!LOCAL_HOSTS.has(host) && !flags.includes('--force')) {
    fail(`db reset is refused for non-local host "${host}" without --force`, 1);
  }
}

async function runDb(subcommand: string, flags: readonly string[], config: Config): Promise<void> {
  const log = (message: string): void => {
    console.log(message);
  };
  const options = { databaseUrl: config.databaseUrl, log };
  if (subcommand === 'migrate') {
    const applied = await migrateToLatest(options);
    console.log(`db migrate: ${applied.length} migration(s) applied; pg-boss schema up to date`);
  } else if (subcommand === 'rollback') {
    const reverted = await rollbackMigrations({ ...options, count: rollbackCount(flags) });
    console.log(`db rollback: ${reverted.length} migration(s) reverted`);
  } else {
    assertResettable(config, flags);
    const applied = await resetDatabase(options);
    console.log(`db reset: schemas dropped; ${applied.length} migration(s) applied`);
  }
}

const TRIGGERABLE: readonly string[] = [
  QUEUE_NAMES.heartbeat,
  ...SCHEDULES.map((slot) => slot.name),
];

/** A producer-role runner: enqueues and reads schedules, never supervises or works. */
async function runJobs(subcommand: string, args: readonly string[], config: Config): Promise<void> {
  // The CLI prints results itself; the runner's own lifecycle logs stay off the terminal.
  const logger = createLogger({ ...loggerOptionsFromConfig(config, 'worker'), level: 'silent' });
  const runner = createJobRunner({
    databaseUrl: config.databaseUrl,
    logger,
    role: 'producer',
    poolMax: 2,
  });
  await runner.start();
  try {
    if (subcommand === 'schedules') {
      const schedules = await runner.listSchedules();
      if (schedules.length === 0) console.log('no schedules registered (has the worker started?)');
      for (const schedule of schedules) {
        const [next] = runner.previewSchedule(schedule.cron, { tz: schedule.tz, count: 1 });
        console.log(
          `${schedule.name}  ${schedule.cron}  ${schedule.tz}  next: ${next?.toISOString() ?? 'n/a'}`,
        );
      }
      return;
    }
    const [name, rawPayload] = args;
    if (name === undefined || !TRIGGERABLE.includes(name)) {
      fail(`jobs trigger: expected one of ${TRIGGERABLE.join(', ')}`);
    }
    let payload: object = { source: 'cli' };
    if (rawPayload !== undefined) {
      const parsed: unknown = JSON.parse(rawPayload);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fail('jobs trigger: payload must be a JSON object');
      }
      payload = parsed;
    }
    const id = await runner.trigger(name, payload);
    console.log(
      id === null
        ? `${name}: a job is already queued or active; nothing enqueued`
        : `enqueued ${name} job ${id}`,
    );
  } finally {
    await runner.stop();
  }
}

// `pnpm run db:rollback -- --all` may forward a literal `--`.
const [group, subcommand, ...flags] = process.argv.slice(2).filter((arg) => arg !== '--');
const entry = group === undefined ? undefined : COMMANDS[group];

if (!entry || subcommand === undefined || !entry.subcommands.includes(subcommand)) {
  fail(`Usage: cli <command>\n${usage()}`);
}

const config = loadConfigOrExit();
try {
  if (group === 'jobs') {
    await runJobs(subcommand, flags, config);
  } else {
    await runDb(subcommand, flags, config);
  }
} catch (error) {
  // pg / node-pg-migrate / pg-boss messages name the failing object, never the connection credentials.
  fail(
    `cli ${group} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
    1,
  );
}
