'use client';

import { useActionState, useMemo } from 'react';
import { useFormStatus } from 'react-dom';
import { startOAuthAction } from '../../lib/auth/actions.ts';
import { withOfflineFallback, type FormState } from '../../lib/auth/form-state.ts';
import {
  IN_APP_BROWSER_HINT,
  PROVIDERS_UNAVAILABLE_MESSAGE,
  errorMessage,
  parseProvider,
  type EnabledProviders,
} from '../../lib/auth/messages.ts';
import { FormBanner } from './form-banner.tsx';
import { SECONDARY_BUTTON_CLASS } from './styles.ts';

type Provider = 'google' | 'facebook';

function useOAuthStart(): [FormState, (formData: FormData) => void] {
  const guarded = useMemo(() => withOfflineFallback(startOAuthAction), []);
  const [state, dispatch] = useActionState(guarded, {});
  return [state, dispatch];
}

/** A failed start (provider disabled, outage, offline) stays on the page, worded from the copy deck. */
function StartError({ state, providers }: { state: FormState; providers?: EnabledProviders }) {
  if (state.error === undefined) return null;
  const lines = errorMessage(state.error.code, {
    provider: state.values?.provider,
    retryAfterSeconds: state.error.retryAfterSeconds,
    providers,
  });
  return lines === null ? null : <FormBanner kind="error" lines={lines} focusToken={state} />;
}

/** Submits `provider=<value>`; the pending label shows only on the button that was pressed. */
function ProviderSubmit({ provider, label }: { provider: Provider; label: string }) {
  const { pending, data } = useFormStatus();
  const mine = pending && data?.get('provider') === provider;
  const name = parseProvider(provider) ?? provider;
  return (
    <button
      type="submit"
      name="provider"
      value={provider}
      aria-disabled={pending}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      className={SECONDARY_BUTTON_CLASS}
    >
      {mine ? `Redirecting to ${name}…` : label}
    </button>
  );
}

/**
 * "Continue with Google / Facebook" for /login and /register, rendered above the email form. Only enabled
 * providers appear. When the providers call failed, a hint replaces the buttons. Inside the Facebook or
 * Instagram app, the Google hint sits directly above the Google button (Google refuses embedded webviews).
 */
export function OAuthButtons({
  providers,
  unavailable,
  returnTo,
  inAppBrowser = false,
}: {
  providers: EnabledProviders;
  unavailable: boolean;
  returnTo?: string | undefined;
  inAppBrowser?: boolean;
}) {
  const [state, dispatch] = useOAuthStart();
  if (unavailable) return <FormBanner kind="notice" lines={[PROVIDERS_UNAVAILABLE_MESSAGE]} />;
  if (!providers.google && !providers.facebook) return null;
  return (
    <form action={dispatch} className="flex flex-col gap-3">
      <StartError state={state} providers={providers} />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      {providers.google && inAppBrowser ? <p className="text-base">{IN_APP_BROWSER_HINT}</p> : null}
      {providers.google ? <ProviderSubmit provider="google" label="Continue with Google" /> : null}
      {providers.facebook ? (
        <ProviderSubmit provider="facebook" label="Continue with Facebook" />
      ) : null}
      <p className="text-center text-base">or</p>
    </form>
  );
}

/** Under the missing-email banner: restarts authorize with `rerequest` so Facebook asks for the email again. */
export function TryFacebookAgain({ returnTo }: { returnTo?: string | undefined }) {
  const [state, dispatch] = useOAuthStart();
  return (
    <form action={dispatch} className="flex flex-col gap-3">
      <StartError state={state} />
      <input type="hidden" name="provider" value="facebook" />
      <input type="hidden" name="rerequest" value="true" />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <RetrySubmit />
    </form>
  );
}

function RetrySubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-disabled={pending}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      className={SECONDARY_BUTTON_CLASS}
    >
      {pending ? 'Redirecting to Facebook…' : 'Try Facebook again'}
    </button>
  );
}
