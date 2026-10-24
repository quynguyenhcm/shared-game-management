/**
 * AC-VERIFY-9 (T-13): the allocator seam cannot be half-wired. `createSessionAllocator` is the ONE function
 * registration-and-waitlist edits; both entrypoints must obtain the port from it, and neither may hand the no-op
 * to `buildApp` or `registerJobs` directly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createManualClock } from './lib/clock.ts';
import type { Database } from './lib/db/kysely.ts';
import { noopSessionAllocator } from './modules/sessions/allocator-port.ts';
import { createSessionAllocator } from './session-allocator.ts';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

/** Source without comments, so prose that mentions a name does not count as wiring. */
const code = (name: string): string =>
  read(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('createSessionAllocator', () => {
  it('returns the no-op port until registration-and-waitlist wires its adapter', () => {
    const allocator = createSessionAllocator({
      db: {} as Database,
      jobs: { enqueue: () => Promise.resolve(null) },
      clock: createManualClock(),
      webBaseUrl: 'https://games.example.nz',
    });
    expect(allocator).toBe(noopSessionAllocator);
    expect(allocator.enrols).toBe(false);
  });
});

describe('entrypoint wiring (AC-VERIFY-9)', () => {
  it.each(['./main.ts', './worker.ts'])(
    '%s imports and calls createSessionAllocator and never passes the no-op directly',
    (entrypoint) => {
      const source = code(entrypoint);
      expect(source).toMatch(
        /import\s*\{[^}]*\bcreateSessionAllocator\b[^}]*\}\s*from\s*'\.\/session-allocator\.ts'/,
      );
      expect(source).toMatch(/\bcreateSessionAllocator\(/);
      expect(source).not.toMatch(/\bnoopSessionAllocator\b/);
      expect(source).toMatch(/\bsessionAllocator\b/);
    },
  );

  it('buildApp and registerJobs require the port (a forgotten entrypoint does not compile)', () => {
    expect(code('./app.ts')).toMatch(/readonly sessionAllocator: SessionAllocatorPort;/);
    expect(code('./jobs/bootstrap.ts')).toMatch(/readonly sessionAllocator: SessionAllocatorPort;/);
  });
});
