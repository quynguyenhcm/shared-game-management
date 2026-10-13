// Next.js instrumentation hook. No OpenTelemetry SDK is registered in web: trace context for API
// calls is created or continued by `lib/api-client.ts` (`traceparent` on every server-side fetch).
// Registering an SDK here later (e.g. `registerOTel`) makes api-client inject the active span instead.
export function register(): void {}
