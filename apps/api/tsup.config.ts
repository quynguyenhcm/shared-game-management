import { defineConfig } from 'tsup';

export default defineConfig({
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
