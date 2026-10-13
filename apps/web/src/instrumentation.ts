// Next.js instrumentation hook. No OpenTelemetry SDK is registered in web: trace context for API
// calls is created or continued by `lib/api-client.ts` (`traceparent` on every server-side fetch).
// Registering an SDK here later (e.g. `registerOTel`) makes api-client inject the active span instead.
//
// Boot validation (AC-VERIFY-7): the server exits 1 with `Invalid configuration: <VAR> — ...` before it
// takes traffic when the auth environment is wrong. It is skipped for the Edge runtime (no `process.exit`)
// and for `next build`, which runs without the production runtime environment.
export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME !== 'nodejs' ||
    process.env.NEXT_PHASE === 'phase-production-build'
  ) {
    return;
  }
  const { loadWebConfigOrExit } = await import('@/lib/config');
  // `SGM_BAKED_WEB_HOST` is inlined by `next build` (next.config.ts `env`): the host the Server Action
  // origin allowlist was built for. In production it must equal the runtime WEB_BASE_URL host.
  loadWebConfigOrExit(process.env, { bakedHost: process.env.SGM_BAKED_WEB_HOST });
}
