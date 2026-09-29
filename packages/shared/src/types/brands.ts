/**
 * Branded string types for DB values that must not be confused with plain strings (algorithm Q6/Q7).
 * kysely-codegen maps `numeric` → MoneyString, `date` → LocalDate and `time` → LocalTime, so a JS
 * `number` or an unchecked string cannot be written to those columns without the helper that
 * produces the brand. The money and time modules (Phase 4) own construction and re-export these.
 */
declare const moneyStringBrand: unique symbol;
declare const localDateBrand: unique symbol;
declare const localTimeBrand: unique symbol;

/** Canonical DB/wire money form, 2 dp: /^-?(0|[1-9]\d{0,7})\.\d{2}$/ e.g. '17.50'. */
export type MoneyString = string & { readonly [moneyStringBrand]: 'NZD_2DP' };
/** Calendar date 'YYYY-MM-DD' (Pacific/Auckland wall-clock date). */
export type LocalDate = string & { readonly [localDateBrand]: true };
/** Wall-clock time 'HH:MM[:SS]'; '24:00' only as an end-of-day marker. */
export type LocalTime = string & { readonly [localTimeBrand]: true };
