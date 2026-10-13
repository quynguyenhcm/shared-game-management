import type { IdentitiesResponse } from '@sgm/shared';
import { connectProviderAction, disconnectProviderAction } from '../../lib/auth/actions.ts';
import { forgotPasswordUrl } from '../../lib/auth/landing.ts';
import type { EnabledProviders } from '../../lib/auth/messages.ts';
import { ActionButton } from './action-button.tsx';
import { LINK_CLASS, SECONDARY_BUTTON_CLASS } from './styles.ts';

type MethodKey = 'PASSWORD' | 'GOOGLE' | 'FACEBOOK';

interface Method {
  key: MethodKey;
  name: string;
  /** The lower-case path spelling; `null` for Email and password, which the API cannot disconnect. */
  path: 'google' | 'facebook' | null;
  enabled: boolean;
}

const LAST_METHOD_NOTE = 'You need at least one way to sign in.';

function LastMethodButton({ method }: { method: Method }) {
  const noteId = `last-method-note-${method.key.toLowerCase()}`;
  return (
    <>
      <button
        type="button"
        aria-disabled="true"
        aria-label={`Disconnect ${method.name}`}
        aria-describedby={noteId}
        className={SECONDARY_BUTTON_CLASS}
      >
        Disconnect
      </button>
      <p id={noteId} className="text-sm text-slate-700">
        {LAST_METHOD_NOTE}
      </p>
    </>
  );
}

function RowAction({
  method,
  connected,
  last,
}: {
  method: Method;
  connected: boolean;
  last: boolean;
}) {
  if (connected && last) return <LastMethodButton method={method} />;
  if (method.path === null) return null;
  return (
    <form action={connected ? disconnectProviderAction : connectProviderAction}>
      <input type="hidden" name="provider" value={method.path} />
      {connected ? (
        <ActionButton
          label="Disconnect"
          pendingLabel="Disconnecting…"
          ariaLabel={`Disconnect ${method.name}`}
        />
      ) : (
        <ActionButton label={`Connect ${method.name}`} pendingLabel="Connecting…" />
      )}
    </form>
  );
}

/**
 * The "Sign-in methods" section of /account: Email and password, then Google and Facebook. A provider row
 * appears when it is enabled or already connected. Disconnect is `aria-disabled` on the only method left
 * (the API refuses it too, with a deferred trigger behind it). "Set a password" appears when there is no
 * password, with the R1 warning that a reset disconnects the connected providers.
 */
export function SignInMethods({
  identities,
  enabledProviders,
}: {
  identities: IdentitiesResponse['identities'];
  enabledProviders: EnabledProviders;
}) {
  const connected = new Set<string>(identities.map((identity) => identity.provider));
  const methods: Method[] = [
    { key: 'PASSWORD', name: 'Email and password', path: null, enabled: true },
    { key: 'GOOGLE', name: 'Google', path: 'google', enabled: enabledProviders.google },
    { key: 'FACEBOOK', name: 'Facebook', path: 'facebook', enabled: enabledProviders.facebook },
  ];
  const visible = methods.filter((method) => connected.has(method.key) || method.enabled);
  const last = connected.size === 1;
  const providerNames = ['Facebook', 'Google'].filter((name) => connected.has(name.toUpperCase()));

  return (
    <>
      <ul className="flex flex-col gap-3">
        {visible.map((method) => {
          const isConnected = connected.has(method.key);
          return (
            <li
              key={method.key}
              className="flex flex-col gap-2 rounded-md border border-slate-400 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-base font-medium">{method.name}</span>
                <span className="text-base">{isConnected ? 'Connected' : 'Not connected'}</span>
              </div>
              <RowAction method={method} connected={isConnected} last={last} />
            </li>
          );
        })}
      </ul>
      {connected.has('PASSWORD') ? null : (
        <div className="flex flex-col">
          <a href={forgotPasswordUrl({ returnTo: '/account' })} className={LINK_CLASS}>
            Set a password
          </a>
          <p className="text-sm text-slate-700">We&apos;ll email you a link to set one.</p>
          {providerNames.length > 0 ? (
            <p className="text-sm text-slate-700">
              For your security, setting a password this way also disconnects{' '}
              {providerNames.join(' and ')}. You can reconnect it straight after.
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}
