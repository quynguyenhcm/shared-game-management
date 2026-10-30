/**
 * AC-ASYNC-2: the worker installs the real ban handler. `registerJobs` keeps the no-op only as its default for tests, so an
 * entrypoint that forgets the option would silently leave bans unprocessed. This reads the source, as
 * `session-allocator.test.ts` does for the allocator seam.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const code = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('worker entrypoint wiring (AC-ASYNC-2)', () => {
  const worker = code('./worker.ts');

  it('passes the registrations ban handler to registerJobs and never the no-op', () => {
    expect(worker).toMatch(
      /import\s*\{[^}]*\bcreateRegistrationsBanHandler\b[^}]*\}\s*from\s*'\.\/modules\/registrations\/ban-handler\.ts'/,
    );
    expect(worker).toMatch(/memberBannedHandler:\s*createRegistrationsBanHandler\(/);
    expect(worker).not.toMatch(/noopMemberBannedHandler/);
  });

  it('builds the handler over the worker runner, the worker database and the web origin, so promotion emails commit with the withdrawal', () => {
    expect(worker).toMatch(
      /createRegistrationsBanHandler\(\{[^}]*\bdb\b[^}]*jobs:\s*runner[^}]*\bclock\b[^}]*webBaseUrl:\s*config\.auth\.webBaseUrl/s,
    );
  });

  it('sizes the worker pool for a handler that holds a connection through a lock wait (Q4 guideline 9)', () => {
    expect(worker).toMatch(/createPool\(\{[^}]*max:\s*5\b/s);
  });
});
