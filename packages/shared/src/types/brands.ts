/**
 * Branded string types for DB values that must not be confused with plain strings (algorithm Q6/Q7,
 * architecture Q5). kysely-codegen maps `numeric` → MoneyString, `date` → LocalDate and `time` → LocalTime,
 * and overrides the encrypted teams columns to Ciphertext, so a JS `number` or an unchecked string cannot be
 * written to those columns without the helper that produces the brand.
 *
 * MoneyString is owned by the money module and LocalDate/LocalTime by the time module (one definition
 * each); they are re-exported here so the codegen `customImports` (`@sgm/shared#MoneyString`) keep working.
 */
export type { MoneyString } from '../money/money.ts';
export type { LocalDate, LocalTime } from '../time/time.ts';

declare const ciphertextBrand: unique symbol;

/** AES-256-GCM envelope `v1.<keyId>.<iv>.<ct>.<tag>` produced by the api crypto module. */
export type Ciphertext = string & { readonly [ciphertextBrand]: 'ENVELOPE_V1' };
