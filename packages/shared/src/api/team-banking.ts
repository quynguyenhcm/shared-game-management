/**
 * Request and response contracts for `/teams/:teamId/banking` and `/teams/:teamId/gst`, shared by the Fastify
 * routes and the web api-client. Bodies are strict, so a client can never set what the server owns (the payout
 * flag, the block, the audit columns). Validation messages are the copy deck of the UI/UX document and never
 * echo input.
 *
 * Decisions this file encodes: memory-bank/creative/team-banking-and-gst-banking-architecture.md (as amended by
 * the task file's Creative Reconciliation R1 payout is the bank account only, no Akahu fields; R2 one GST number,
 * no IRD fields; R3 `payoutBlocked`; R6 blank account number keeps the saved value; R7 `unreadable`; R8 audit
 * columns and the per-render `changeKey`).
 */
import { z } from 'zod';
import { parseNzBankAccount, type NzBankAccountFailure } from '../nz/bank-account.ts';
import { parseIrdNumber, type IrdNumberFailure } from '../nz/ird-number.ts';

export const ACCOUNT_NAME_MAX_LENGTH = 100;
/** Cap applied before parsing, so a huge value never reaches the validators. */
export const ACCOUNT_NUMBER_INPUT_MAX_LENGTH = 40;
export const GST_NUMBER_INPUT_MAX_LENGTH = 20;

export const BANKING_FIELD_MESSAGES = {
  accountNameRequired: 'Enter the name on the bank account.',
  accountNameTooLong: 'Use 100 characters or fewer.',
  accountNumberRequired: 'Enter the account number.',
  accountNumberFormat: 'Enter an NZ account number in the format 00-0000-0000000-00.',
  accountNumberUnknownBank:
    'That bank or branch number is not recognised. Check the number and try again.',
  accountNumberCheckDigit:
    'That account number does not look right. Check the digits and try again.',
  gstNumberRequired: 'Enter your GST number to register for GST.',
  gstNumberFormat: 'Enter an 8 or 9 digit GST number.',
  gstNumberCheckDigit: 'That GST number does not look right. Check the digits and try again.',
  changeKeyInvalid: 'Reload the page and try again.',
} as const;

const ACCOUNT_NUMBER_MESSAGES: Readonly<Record<NzBankAccountFailure, string>> = {
  required: BANKING_FIELD_MESSAGES.accountNumberRequired,
  format: BANKING_FIELD_MESSAGES.accountNumberFormat,
  unknown_bank: BANKING_FIELD_MESSAGES.accountNumberUnknownBank,
  check_digit: BANKING_FIELD_MESSAGES.accountNumberCheckDigit,
};

const GST_NUMBER_MESSAGES: Readonly<Record<IrdNumberFailure, string>> = {
  required: BANKING_FIELD_MESSAGES.gstNumberRequired,
  format: BANKING_FIELD_MESSAGES.gstNumberFormat,
  // Out of the 10,000,000 to 200,000,000 range is reported like a failed check: the copy deck has no range text.
  range: BANKING_FIELD_MESSAGES.gstNumberCheckDigit,
  check_digit: BANKING_FIELD_MESSAGES.gstNumberCheckDigit,
};

/**
 * Optional account number: omitted or blank means "keep the saved value" (`undefined`); otherwise the
 * canonical `BB-bbbb-AAAAAAA-SSS` form, or an issue carrying the copy-deck message for the failure reason.
 */
const AccountNumberInput = z
  .string({ error: BANKING_FIELD_MESSAGES.accountNumberFormat })
  .transform((raw, ctx) => {
    const text = raw.trim();
    if (text === '') return undefined;
    if (text.length > ACCOUNT_NUMBER_INPUT_MAX_LENGTH) {
      ctx.addIssue({ code: 'custom', message: BANKING_FIELD_MESSAGES.accountNumberFormat });
      return z.NEVER;
    }
    const parsed = parseNzBankAccount(text);
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: ACCOUNT_NUMBER_MESSAGES[parsed.reason] });
      return z.NEVER;
    }
    return parsed.value.canonical;
  })
  .optional();

/** Optional GST number: blank or omitted keeps the saved value; otherwise canonical digits, no leading zero. */
const GstNumberInput = z
  .string({ error: BANKING_FIELD_MESSAGES.gstNumberFormat })
  .transform((raw, ctx) => {
    const text = raw.trim();
    if (text === '') return undefined;
    if (text.length > GST_NUMBER_INPUT_MAX_LENGTH) {
      ctx.addIssue({ code: 'custom', message: BANKING_FIELD_MESSAGES.gstNumberFormat });
      return z.NEVER;
    }
    const parsed = parseIrdNumber(text);
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: GST_NUMBER_MESSAGES[parsed.reason] });
      return z.NEVER;
    }
    return parsed.value;
  })
  .optional();

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * `PUT /teams/:teamId/banking`. `changeKey` is a UUID v4 the form generates once per render (R8): a replay
 * of the same key enqueues no second notification. A blank or omitted `accountNumber` keeps the saved number
 * (the service requires one on first setup).
 */
export const PutBankingRequest = z.strictObject({
  accountName: z
    .string({ error: BANKING_FIELD_MESSAGES.accountNameRequired })
    .trim()
    .min(1, BANKING_FIELD_MESSAGES.accountNameRequired)
    .max(ACCOUNT_NAME_MAX_LENGTH, BANKING_FIELD_MESSAGES.accountNameTooLong)
    .refine((name) => !/\p{Cc}/u.test(name), BANKING_FIELD_MESSAGES.accountNameRequired),
  accountNumber: AccountNumberInput,
  changeKey: z.uuidv4({ error: BANKING_FIELD_MESSAGES.changeKeyInvalid }),
});
export type PutBankingRequest = z.infer<typeof PutBankingRequest>;

/**
 * `PUT /teams/:teamId/gst`. Turning GST off sends only `gstRegistered: false`; the saved number is kept.
 * Whether a number must accompany `gstRegistered: true` depends on what is saved, so the service decides
 * (message `gstNumberRequired`).
 */
export const PutGstRequest = z.strictObject({
  gstRegistered: z.boolean(),
  gstNumber: GstNumberInput,
});
export type PutGstRequest = z.infer<typeof PutGstRequest>;

// ---------------------------------------------------------------------------------------------
// Responses (never carry the full account number)
// ---------------------------------------------------------------------------------------------

/**
 * `GET`, `PUT` and `DELETE /teams/:teamId/banking`. `unreadable` (R7): saved details could not be decrypted,
 * `accountName` is then null. `payoutBlocked` (R3): a failed payout destination blocks publishing until saved
 * again. `lastChanged` (R8) comes from the audit columns; `by` is null after the actor's account is deleted.
 */
export const BankingResponse = z.object({
  banking: z.object({
    isPayoutConfigured: z.boolean(),
    payoutBlocked: z.boolean(),
    accountName: z.string().nullable(),
    unreadable: z.boolean(),
    accountNumberLast4: z
      .string()
      .regex(/^[0-9]{4}$/)
      .nullable(),
    lastChanged: z
      .object({
        at: z.iso.datetime(),
        by: z.object({ fullName: z.string() }).nullable(),
      })
      .nullable(),
  }),
});
export type BankingResponse = z.infer<typeof BankingResponse>;

/** `GET` and `PUT /teams/:teamId/gst`. The GST number is public (printed on invoices): canonical digits. */
export const GstResponse = z.object({
  gst: z.object({
    gstRegistered: z.boolean(),
    gstNumber: z
      .string()
      .regex(/^[1-9][0-9]{7,8}$/)
      .nullable(),
  }),
});
export type GstResponse = z.infer<typeof GstResponse>;
