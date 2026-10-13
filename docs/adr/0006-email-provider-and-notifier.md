# ADR 0006: Email provider and notifier contract

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [architecture Q8](../../memory-bank/creative/platform-foundation-architecture.md)

## Context

The production email provider is undecided. Foundation only needs an abstraction that lets dev and tests run without one.

## Decision

A provider-neutral `Notifier` interface: one recipient per `send`, a required `idempotencyKey`, and typed errors (`TransientDeliveryError` retryable, `PermanentDeliveryError` and `NotifierConfigurationError` not). Adapters: `smtp` (nodemailer; Mailpit in dev and CI) and `memory` (tests). Selection is by `NOTIFIER_ADAPTER` only. Postmark is the likely provider and is not integrated.

## Consequences

- Adding a provider is one adapter file plus one `case` in `createNotifier`.
- N recipients means N calls, which keeps retries and idempotency per recipient.
- Providers without a native idempotency key rely on the job layer's `singletonKey` and a later delivery log.
