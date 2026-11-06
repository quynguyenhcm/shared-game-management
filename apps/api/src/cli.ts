// Console output is allowed here (see eslint.config.mjs): the CLI talks to a terminal, not the logger.
import {
  parseBillSessionTrigger,
  parseBillingReconcileArgs,
  parseBlockPayoutArgs,
  parseMemberBannedTrigger,
  parseRecurrenceRuleTrigger,
  parseSessionAutoEnrolTrigger,
  parseSetRoleArgs,
  resetRefusal,
  rollbackRefusal,
} from './cli-guards.ts';
import { loadConfigOrExit, type Config } from './lib/config/config.ts';
import { QUEUE_NAMES } from './jobs/registry.ts';
import { SCHEDULES } from './jobs/schedules.ts';
import { createKysely } from './lib/db/kysely.ts';
import { migrateToLatest, resetDatabase, rollbackMigrations } from './lib/db/migrate.ts';
import { createPool } from './lib/db/pool.ts';
import { findGlobalAdminIdByEmail, setUserRole } from './modules/auth/repo.ts';
import { createJobRunner } from './lib/jobs/jobs.ts';
import { systemClock } from './lib/clock.ts';
import { createCrypto } from './lib/crypto/crypto.ts';
import { keyProviderFromConfig } from './lib/crypto/keyring.ts';
import {
  formatReconcileReport,
  reconcileExitCode,
  runBillingReconcile,
} from './modules/billing/reconcile-cli.ts';
import { blockPayout } from './modules/billing/payout-block.ts';
import { randomUUID } from 'node:crypto';
import { createLogger, loggerOptionsFromConfig } from './lib/logger/logger.ts';

const COMMANDS: Record<string, { subcommands: readonly string[] }> = {
  db: { subcommands: ['migrate', 'rollback', 'reset'] },
  jobs: { subcommands: ['trigger', 'schedules'] },
  users: { subcommands: ['set-role'] },
  billing: { subcommands: ['reconcile', 'block-payout'] },
};

function usage(): string {
  return [
    ...Object.entries(COMMANDS).map(
      ([name, { subcommands }]) => `  ${name} ${subcommands.join('|')}`,
    ),
    '  db rollback [--count N | --all]   (default: one step; refused in production)',
    '  db reset [--force]                (refused in production or on a non-local host)',
    '  jobs trigger <slot|heartbeat> [json]   (manually enqueue a slot, e.g. skill-progression, or the heartbeat job)',
    "  jobs trigger member-banned '<json>'    (re-run a ban's side effect; payload as in ADR 0015)",
    "  jobs trigger recurrence-rule '<json>'   (re-run one series' materialisation: ruleId, teamId, trigger)",
    "  jobs trigger session-auto-enrol '<json>' (re-offer one session's auto-enrol: sessionId, teamId, trigger)",
    "  jobs trigger bill-session '<json>'      (re-run one session's billing: sessionId, trigger)",
    '  jobs schedules                         (list registered cron schedules)',
    '  billing reconcile                      (read-only ledger/payments check; exit 1 on any discrepancy, ids only)',
    '  billing block-payout <teamId> <reason> [akahuPaymentId] --as <email>   (mark a team payout as failing, CR-14; --as names the GLOBAL_ADMIN actor)',
    '  users set-role <email> <GLOBAL_ADMIN|PLAYER>   (grant or revoke the global admin role)',
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

async function runDb(subcommand: string, flags: readonly string[], config: Config): Promise<void> {
  const log = (message: string): void => {
    console.log(message);
  };
  const options = { databaseUrl: config.databaseUrl, log };
  if (subcommand === 'migrate') {
    const applied = await migrateToLatest(options);
    console.log(`db migrate: ${applied.length} migration(s) applied; pg-boss schema up to date`);
  } else if (subcommand === 'rollback') {
    const refusal = rollbackRefusal(config);
    if (refusal) fail(refusal, 1);
    const reverted = await rollbackMigrations({ ...options, count: rollbackCount(flags) });
    console.log(`db rollback: ${reverted.length} migration(s) reverted`);
  } else {
    const refusal = resetRefusal(config, flags);
    if (refusal) fail(refusal, 1);
    const applied = await resetDatabase(options);
    console.log(`db reset: schemas dropped; ${applied.length} migration(s) applied`);
  }
}

const TRIGGERABLE: readonly string[] = [
  QUEUE_NAMES.heartbeat,
  QUEUE_NAMES.memberBanned,
  QUEUE_NAMES.recurrenceRule,
  QUEUE_NAMES.sessionAutoEnrol,
  QUEUE_NAMES.billSession,
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
    if (name === QUEUE_NAMES.memberBanned) {
      // Validated with the handler's own strict schema and keyed like the job a ban enqueues.
      const trigger = parseMemberBannedTrigger(rawPayload);
      if ('error' in trigger) fail(trigger.error);
      const jobId = await runner.enqueue(name, trigger.payload, {
        singletonKey: trigger.singletonKey,
      });
      console.log(
        jobId === null
          ? `${name}: a job is already queued or active for this membership; nothing enqueued`
          : `enqueued ${name} job ${jobId}`,
      );
      return;
    }
    if (
      name === QUEUE_NAMES.recurrenceRule ||
      name === QUEUE_NAMES.sessionAutoEnrol ||
      name === QUEUE_NAMES.billSession
    ) {
      // Validated with the handler's own strict schema and keyed like the job the feature itself enqueues.
      const trigger =
        name === QUEUE_NAMES.recurrenceRule
          ? parseRecurrenceRuleTrigger(rawPayload)
          : name === QUEUE_NAMES.billSession
            ? parseBillSessionTrigger(rawPayload)
            : parseSessionAutoEnrolTrigger(rawPayload);
      if ('error' in trigger) fail(trigger.error);
      const jobId = await runner.enqueue(name, trigger.payload, {
        singletonKey: trigger.singletonKey,
      });
      console.log(
        jobId === null
          ? `${name}: a job is already queued for this target; nothing enqueued`
          : `enqueued ${name} job ${jobId}`,
      );
      return;
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

/** `users set-role <email> <GLOBAL_ADMIN|PLAYER>`: the operator's way to create the first GLOBAL_ADMIN. */
async function runUsers(args: readonly string[], config: Config): Promise<void> {
  const parsed = parseSetRoleArgs(args);
  if ('error' in parsed) fail(parsed.error);
  const pool = createPool({ connectionString: config.databaseUrl, max: 1 });
  const db = createKysely(pool);
  try {
    const updated = await setUserRole(db, parsed.email, parsed.role);
    if (updated === null) fail(`users set-role: no user with that email; nothing changed`, 1);
    // Id and role only: no email echo of other data, no secrets.
    console.log(`user ${updated.id} role is now ${updated.role}`);
  } finally {
    await db.destroy();
  }
}

/** `billing reconcile` (read-only; exit 1 on any discrepancy) and `billing block-payout` (CR-14 convenience, no user session; `--as` names the GLOBAL_ADMIN actor). */
async function runBilling(
  subcommand: string,
  args: readonly string[],
  config: Config,
): Promise<void> {
  if (subcommand === 'reconcile') {
    const bad = parseBillingReconcileArgs(args);
    if (bad) fail(bad.error);
    const pool = createPool({ connectionString: config.databaseUrl, max: 1 });
    try {
      const report = await runBillingReconcile(pool);
      for (const line of formatReconcileReport(report)) console.log(line);
      process.exitCode = reconcileExitCode(report);
    } finally {
      await pool.end();
    }
    return;
  }
  const parsed = parseBlockPayoutArgs(args);
  if ('error' in parsed) fail(parsed.error);
  const logger = createLogger({ ...loggerOptionsFromConfig(config, 'worker'), level: 'silent' });
  const runner = createJobRunner({
    databaseUrl: config.databaseUrl,
    logger,
    role: 'producer',
    poolMax: 2,
  });
  const pool = createPool({ connectionString: config.databaseUrl, max: 2 });
  const db = createKysely(pool);
  const actorUserId = await findGlobalAdminIdByEmail(db, parsed.actorEmail);
  if (actorUserId === undefined) {
    await pool.end();
    fail('billing block-payout: --as must name a GLOBAL_ADMIN; nothing changed', 1);
  }
  await runner.start();
  try {
    const result = await blockPayout(
      {
        db,
        jobs: runner,
        clock: systemClock,
        crypto: createCrypto(keyProviderFromConfig(config)),
        webBaseUrl: config.auth.webBaseUrl,
      },
      {
        teamId: parsed.teamId,
        actorUserId,
        reason: parsed.reason,
        akahuPaymentId: parsed.akahuPaymentId,
        changeKey: randomUUID(),
      },
      logger,
    );
    console.log(
      `team ${parsed.teamId} payout ${result.alreadyBlocked ? 'was already blocked' : 'is now blocked'} (event ${result.eventId})`,
    );
  } finally {
    await runner.stop();
    await pool.end();
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
  } else if (group === 'users') {
    await runUsers(flags, config);
  } else if (group === 'billing') {
    await runBilling(subcommand, flags, config);
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
