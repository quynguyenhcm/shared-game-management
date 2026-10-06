import type { FieldErrors } from './validation.ts';

/**
 * What every auth Server Action returns for an in-place result (navigations are `redirect()`s).
 * Password fields are never echoed: `values` carries only non-secret inputs.
 */
export interface FormState {
  fieldErrors?: FieldErrors;
  /** A page-level error: an API `ErrorCode`, `offline`, or any other code (shown as the generic banner). */
  error?: { code: string; retryAfterSeconds?: number };
  values?: Record<string, string>;
  /** Forgot-password "sent" state: the address as typed. */
  sent?: { email: string };
}

export type FormAction = (previous: FormState, formData: FormData) => Promise<FormState>;

/**
 * Wraps a Server Action call so a rejected request (the browser is offline) becomes the E-SYS-1 state
 * instead of an unhandled error. Redirects are handled by Next's router and never reach this catch.
 */
export function withOfflineFallback(action: FormAction): FormAction {
  return async (previous, formData) => {
    try {
      return await action(previous, formData);
    } catch (error) {
      if (error instanceof TypeError || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        return { error: { code: 'offline' }, values: previous.values };
      }
      throw error;
    }
  };
}
