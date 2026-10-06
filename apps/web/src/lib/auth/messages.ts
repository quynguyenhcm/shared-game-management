/**
 * The copy deck of the user-journey document: notice and error codes in, fixed text out. Notices and
 * errors travel only as codes in the query string, so arbitrary text is never reflected. Field messages
 * live in the shared zod schemas (`FIELD_MESSAGES`). Unknown codes return `null` and render nothing.
 */

export type ProviderName = 'Google' | 'Facebook';
export type AuthIntent = 'signin' | 'link';

export interface EnabledProviders {
  readonly google: boolean;
  readonly facebook: boolean;
}

/** The lowercase query spelling to the display name; anything else is not a provider. */
export function parseProvider(raw: string | null | undefined): ProviderName | null {
  if (raw === 'google') return 'Google';
  if (raw === 'facebook') return 'Facebook';
  return null;
}

/** `removed=FACEBOOK,GOOGLE` (enum-checked) to display names in the deck's order (Facebook, Google). */
export function parseRemoved(raw: string | null | undefined): ProviderName[] {
  const parts = (raw ?? '').split(',');
  const names: ProviderName[] = [];
  if (parts.includes('FACEBOOK')) names.push('Facebook');
  if (parts.includes('GOOGLE')) names.push('Google');
  return names;
}

/** `{n}` is `max(1, ceil(Retry-After / 60))`, singular when 1 (X4). */
export function minutesLabel(retryAfterSeconds: number | undefined): string {
  const minutes = Math.max(1, Math.ceil((retryAfterSeconds ?? 0) / 60));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export interface NoticeContext {
  readonly provider?: string | null;
  readonly removed?: string | null;
}

export function noticeMessage(
  code: string | null | undefined,
  context: NoticeContext,
): string | null {
  const provider = parseProvider(context.provider);
  switch (code) {
    case 'session_expired':
      return 'Your session has expired. Sign in again.';
    case 'signed_out':
      return "You've signed out.";
    case 'password_updated': {
      const removed = parseRemoved(context.removed);
      if (removed.length === 0) return 'Password updated. Sign in with your new password.';
      return `Password updated. For your security we disconnected ${removed.join(' and ')} from this account. Sign in and reconnect it from your Account page.`;
    }
    case 'welcome':
      return 'Welcome! Your account is ready.';
    case 'linked':
      return provider === null ? null : `${provider} connected. You can now sign in with it.`;
    case 'already_linked':
      return provider === null ? null : `${provider} is already connected.`;
    case 'unlinked':
      return provider === null
        ? null
        : `${provider} disconnected. You can connect it again at any time.`;
    default:
      return null;
  }
}

export interface ErrorContext {
  readonly provider?: string | null;
  readonly retryAfterSeconds?: number;
  /** The conflicting email from the `sgm_flash` cookie, for `oauth_account_exists` only. */
  readonly email?: string | null;
  /** Where the error landed: sign-in pages (default) or `/account` (link flows). */
  readonly intent?: AuthIntent;
  /** Which providers are enabled; decides whether the provider hints are shown. */
  readonly providers?: EnabledProviders;
}

const GENERIC =
  'Something went wrong on our side. Your details are still here. Try again in a minute.';

function providerHint(providers: EnabledProviders | undefined): string {
  const names: string[] = [];
  if (providers?.google) names.push('Google');
  if (providers?.facebook) names.push('Facebook');
  return names.length === 0 ? '' : `, or continue with ${names.join(' or ')}`;
}

/** Message lines (first line is the headline) for an error code, or `null` when it renders nothing. */
export function errorMessage(
  code: string | null | undefined,
  context: ErrorContext,
): string[] | null {
  const provider = parseProvider(context.provider);
  const link = context.intent === 'link';
  const needsProvider = (build: (name: ProviderName) => string[]): string[] | null =>
    provider === null ? null : build(provider);

  switch (code) {
    case 'email_taken':
      return [
        'An account with this email already exists. If you signed up with Google or Facebook, use that button to sign in.',
      ];
    case 'invalid_credentials': {
      const anyProvider =
        context.providers?.google === true || context.providers?.facebook === true;
      return anyProvider
        ? [
            'Incorrect email or password.',
            'If you signed up with Google or Facebook, use those buttons instead.',
          ]
        : ['Incorrect email or password.'];
    }
    case 'too_many_attempts':
      return [
        `Too many sign-in attempts. Try again in ${minutesLabel(context.retryAfterSeconds)}.`,
        `You can reset your password now${providerHint(context.providers)}.`,
      ];
    case 'too_many_requests':
      return [`Too many requests. Try again in ${minutesLabel(context.retryAfterSeconds)}.`];
    case 'invalid_or_expired_token':
      return [
        'This reset link is invalid or has expired. If you just set a new password, try signing in with it.',
      ];
    case 'oauth_cancelled':
      return needsProvider((name) => [
        link ? `Connecting ${name} was cancelled.` : `${name} sign-in was cancelled.`,
      ]);
    case 'oauth_state_invalid':
      return needsProvider((name) =>
        link
          ? [`We couldn't verify that attempt to connect ${name}. Please try again.`]
          : [
              "We couldn't verify that sign-in attempt. Please try again.",
              "If it keeps happening, open this page in your device's main browser rather than inside another app.",
            ],
      );
    case 'provider_unavailable':
      return needsProvider((name) => [
        link
          ? `${name} is unavailable right now. Try connecting again later.`
          : `${name} is unavailable right now. Try again, or sign in with email and password.`,
      ]);
    case 'provider_not_enabled':
      return needsProvider((name) => [
        `${name} sign-in isn't available. Use another sign-in method.`,
      ]);
    case 'oauth_email_missing':
      return needsProvider((name) =>
        name === 'Facebook'
          ? [
              "Facebook didn't share an email address, which we need to create your account. Try again and allow access to your email, or use Google or email and password instead.",
            ]
          : ["Google didn't share an email address we can use. Use another sign-in method."],
      );
    case 'oauth_email_unverified':
      return [
        "Google says this email address isn't verified. Verify it with Google or use another method.",
      ];
    case 'oauth_account_exists':
      return needsProvider((name) => {
        const subject = context.email ? context.email : `the email address on your ${name} account`;
        return [
          `An account already exists for ${subject}. Sign in with your existing method, then connect ${name} from your Account page.`,
        ];
      });
    case 'signup_expired':
      return ['Your sign-up session expired. Please start again.'];
    case 'link_session_mismatch':
      return needsProvider((name) => [`Sign in again to connect ${name}.`]);
    case 'identity_in_use':
      return needsProvider((name) => [
        `That ${name} account is already connected to a different account.`,
      ]);
    case 'provider_already_connected':
      return needsProvider((name) => [
        `Your account already has a ${name} sign-in. Disconnect it first to connect a different one.`,
      ]);
    case 'last_sign_in_method':
      return ["You can't disconnect your only sign-in method. Connect another one first."];
    case 'forbidden':
      return ["You don't have permission to do that."];
    case 'offline':
      return ['You seem to be offline. Check your connection and try again.'];
    case 'cross_origin_request':
      return [
        "This request was blocked because it didn't come from this site. Reload the page and try again.",
      ];
    case 'internal_error':
    case 'service_unavailable':
      return [GENERIC];
    default:
      // Unknown codes from a form action are reported as the generic banner; query-string callers
      // filter with `isKnownErrorCode` first so unknown codes in a URL render nothing.
      return typeof code === 'string' && code !== '' ? [GENERIC] : null;
  }
}

const URL_ERROR_CODES: ReadonlySet<string> = new Set([
  'oauth_cancelled',
  'oauth_state_invalid',
  'provider_unavailable',
  'provider_not_enabled',
  'oauth_email_missing',
  'oauth_email_unverified',
  'oauth_account_exists',
  'signup_expired',
  'link_session_mismatch',
  'identity_in_use',
  'provider_already_connected',
  'last_sign_in_method',
]);

/** Error codes that may arrive in a `?error=` query string; anything else is ignored. */
export function urlErrorMessage(
  code: string | null | undefined,
  context: ErrorContext,
): string[] | null {
  return typeof code === 'string' && URL_ERROR_CODES.has(code) ? errorMessage(code, context) : null;
}

export const PAGE_ERROR_MESSAGE = 'Something went wrong on our side. Try again in a minute.';
