import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * Server Actions compare the request `Origin` with the `Host` (or `X-Forwarded-Host`). Behind the
 * platform proxy those can differ, so the public host of `WEB_BASE_URL` is allowed explicitly. This is
 * evaluated at build time (the standalone server bakes the config in): pass `WEB_BASE_URL` to the build.
 * Confirmed against Next 16.3.6: the key is `experimental.serverActions.allowedOrigins`.
 */
function publicHost(): string | undefined {
  const raw = process.env.WEB_BASE_URL;
  return raw && URL.canParse(raw) ? new URL(raw).host : undefined;
}
const allowedOrigins = [publicHost() ?? 'localhost:3000'];

const nextConfig: NextConfig = {
  output: 'standalone',
  // Monorepo: trace workspace packages from the repository root so the standalone output includes them.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  transpilePackages: ['@sgm/shared'],
  experimental: { serverActions: { allowedOrigins } },
};

export default nextConfig;
