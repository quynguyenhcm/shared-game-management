// Console output is allowed here (see eslint.config.mjs): the CLI talks to a terminal, not the logger.
import { loadConfigOrExit } from './lib/config/config.ts';

const COMMANDS: Record<string, { subcommands: readonly string[]; phase: number }> = {
  db: { subcommands: ['migrate', 'rollback', 'reset'], phase: 3 },
  jobs: { subcommands: ['trigger', 'schedules'], phase: 5 },
};

function usage(): string {
  return Object.entries(COMMANDS)
    .map(([name, { subcommands }]) => `  ${name} ${subcommands.join('|')}`)
    .join('\n');
}

const [group, subcommand] = process.argv.slice(2);
const entry = group === undefined ? undefined : COMMANDS[group];

if (!entry || subcommand === undefined || !entry.subcommands.includes(subcommand)) {
  console.error(`Usage: cli <command>\n${usage()}`);
  process.exit(2);
}

loadConfigOrExit();
console.error(`cli ${group} ${subcommand}: not implemented until Phase ${entry.phase}`);
process.exit(1);
