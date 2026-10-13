import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface SpawnedNode {
  readonly child: ChildProcess;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Runs a TypeScript entrypoint in a fresh Node process (`node --import tsx`, so the process that
 * receives SIGKILL is the worker itself, not a wrapper). `script` is relative to `apps/api`.
 */
export function spawnNode(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
): SpawnedNode {
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: API_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('exit', (code, signal) => {
      done({ code, signal });
    });
  });
  return { child, output: () => buffer, exited };
}

/** An unused TCP port (for the worker's health server). */
export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        resolvePort(port);
      });
    });
  });
}
