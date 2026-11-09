/**
 * Wallet policy constants (B1, B5). They are policy, not configuration: the $100.00 cap is also a database CHECK
 * (`player_credits_balance_range`, `wallet_top_ups_amount_range`), so none of these is an environment variable.
 */
import { parseMoney, type Money } from '../money/money.ts';

/** The wallet balance never exceeds this (a cap on the balance, not on one top-up). */
export const WALLET_CAP: Money = parseMoney('100.00');
/** The smallest top-up (B1). */
export const TOP_UP_MINIMUM: Money = parseMoney('1.00');
/** A deduction that leaves the balance below this sends the low-credit reminder (B5). */
export const LOW_CREDIT_THRESHOLD: Money = parseMoney('20.00');
