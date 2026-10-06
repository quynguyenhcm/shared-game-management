/**
 * The "Sign-in methods" section of /account. Phase 4 has no OAuth, so the only row is Email and
 * password, and it is the only method: Disconnect is `aria-disabled` with the last-method note. Phase 5
 * adds Google and Facebook rows (enabled or already connected) and the Connect actions.
 */
export function SignInMethods() {
  return (
    <ul className="flex flex-col gap-3">
      <li className="flex flex-col gap-2 rounded-md border border-slate-400 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-base font-medium">Email and password</span>
          <span className="text-base">Connected</span>
        </div>
        <button
          type="button"
          aria-disabled="true"
          aria-describedby="last-method-note"
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-slate-500 px-4 text-base aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        >
          Disconnect
        </button>
        <p id="last-method-note" className="text-sm text-slate-700">
          You need at least one way to sign in.
        </p>
      </li>
    </ul>
  );
}
