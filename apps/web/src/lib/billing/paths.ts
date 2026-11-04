/** The billing pages' paths, in one place: the actions revalidate them, the components link to them. Ids are UUIDs the caller validated. */

export const walletPath = (teamId: string): string => `/teams/${teamId}/wallet`;

export const paymentPath = (paymentId: string): string => `/payments/${paymentId}`;

/** The cross-team unpaid list (the registration debt-block link target, CR-16). */
export const UNPAID_PAYMENTS_PATH = '/payments';

export const adminPaymentsPath = (teamId: string): string => `/teams/${teamId}/manage/payments`;

export const bankingPagePath = (teamId: string): string => `/teams/${teamId}/manage/banking`;
