import { copyFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  // The password blocklist is read at runtime from beside the bundle (modules/auth/password-policy.ts).
  onSuccess: async () => {
    await copyFile('src/modules/auth/common-passwords.txt', 'dist/common-passwords.txt');
  },
  entry: {
    main: 'src/main.ts',
    worker: 'src/worker.ts',
    cli: 'src/cli.ts',
    instrumentation: 'src/instrumentation.ts',
  },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source, so they are bundled; third-party deps stay external.
  noExternal: ['@sgm/shared'],
});
