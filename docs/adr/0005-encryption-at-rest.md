# ADR 0005: Encryption at rest and key management

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [architecture Q5](../../memory-bank/creative/platform-foundation-architecture.md)

## Context

Bank details and Akahu credentials must be encrypted at rest with a rotatable key, and plaintext must never leak through errors or logs.

## Decision

Application-level AES-256-GCM through `node:crypto`, an env-supplied keyring (`ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KEY_ID`) and a key-ID-prefixed envelope `v1.<keyId>.<iv>.<ciphertext>.<tag>` stored as TEXT. The AAD binds table, column and row. A CHECK on each column rejects plaintext writes (`23514`). Encrypted: `bank_account_number`, `akahu_app_token`, `bank_account_name`, `ird_number`; `bank_account_last4` is a display projection. A `KeyProvider` interface allows a KMS later.

## Consequences

- No KMS in v1: the key lives in the process environment (production: the platform secret store). Random-IV ciphertext cannot be searched.
- `DecryptionError` carries only a reason code, never payload or key material.
- Rotation is add key, flip active id, re-encrypt, remove old key.
