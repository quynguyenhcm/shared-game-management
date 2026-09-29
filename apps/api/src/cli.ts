// Console output is allowed here (see eslint.config.mjs): the CLI talks to a terminal, not the logger.
import { loadConfigOrExit, type Config } from './lib/config/config.ts';
import { migrateToLatest, resetDatabase, rollbackMigrations } from './lib/db/migrate.ts';

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

// `pnpm run db:rollback -- --all` may forward a literal `--`.
const [group, subcommand, ...flags] = process.argv.slice(2).filter((arg) => arg !== '--');
const entry = group === undefined ? undefined : COMMANDS[group];

if (!entry || subcommand === undefined || !entry.subcommands.includes(subcommand)) {
  fail(`Usage: cli <command>\n${usage()}`);
}

const config = loadConfigOrExit();
if (group === 'jobs') {
  fail(`cli jobs ${subcommand}: not implemented until Phase 5`, 1);
}
try {
  await runDb(subcommand, flags, config);
} catch (error) {
  // pg / node-pg-migrate messages name the failing object, never the connection credentials.
  fail(`cli db ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`, 1);
}
