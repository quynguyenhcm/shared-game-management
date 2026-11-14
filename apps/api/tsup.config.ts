import { copyFile, cp } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  // Two data files are read at runtime from beside the bundle: the password blocklist (modules/auth/password-policy.ts) and the
  // invoice fonts, Noto Sans with its OFL licence text (modules/invoices/render-pdf.ts resolves `./fonts/` from the bundle).
  onSuccess: async () => {
    await copyFile('src/modules/auth/common-passwords.txt', 'dist/common-passwords.txt');
    await cp('src/modules/invoices/fonts', 'dist/fonts', { recursive: true });
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
