// OpenTelemetry bootstrap, loaded first via `node --import ./dist/instrumentation.js`.
// TODO(Phase 2/5): start the NodeSDK (fastify, pg, http/undici instrumentations) here.
// Foundation placeholder: with OTEL_SDK_DISABLED=true or OTEL_TRACES_EXPORTER=none (the default) it does nothing.
export {};
