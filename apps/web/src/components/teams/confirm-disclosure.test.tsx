import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  RedirectType: { replace: 'replace' },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));

const { ConfirmDisclosure, ConfirmPanel } = await import('./confirm-disclosure.tsx');
const inline = await import('./inline-confirm.tsx');

const base = {
  id: 'withdraw',
  triggerLabel: 'Withdraw',
  triggerAriaLabel: 'Withdraw from this session',
  prompt: "Withdraw from this session? You won't be charged.",
  confirmLabel: 'Withdraw',
  pendingLabel: 'Withdrawing...',
  dismissLabel: 'Cancel',
  onOpenChange: () => undefined,
  destructive: true,
};

describe('ConfirmDisclosure: the presentational core extracted from InlineConfirm (R11)', () => {
  it('closed: a trigger with aria-expanded=false and aria-controls, and no panel', () => {
    const html = renderToStaticMarkup(<ConfirmDisclosure {...base} open={false} />);
    const trigger = /<button[^>]*>/.exec(html)?.[0] ?? '';
    expect(trigger).toContain('aria-expanded="false"');
    expect(trigger).toContain('aria-controls="withdraw-panel"');
    expect(trigger).toContain('aria-label="Withdraw from this session"');
    expect(html).not.toContain('role="group"');
  });

  it('open: a non-modal group labelled by its prompt, with a destructive confirm and a Cancel; no dialog', () => {
    const html = renderToStaticMarkup(<ConfirmDisclosure {...base} open />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/role="group"[^>]*aria-labelledby="withdraw-prompt"/);
    expect(html).toContain('Withdraw from this session? You won&#x27;t be charged.');
    expect(html).toContain('bg-red-800');
    expect(html).toContain('>Cancel<');
    expect(html).not.toMatch(/<dialog|aria-modal|window\.confirm/);
  });

  it('takes a form action and hidden children inside the panel form', () => {
    const html = renderToStaticMarkup(
      <ConfirmDisclosure {...base} open formAction={() => undefined}>
        <input type="hidden" name="expectLate" value="true" />
      </ConfirmDisclosure>,
    );
    expect(html).toContain('<form');
    expect(html).toContain('name="expectLate"');
  });

  it('a pending confirm says so and is aria-disabled, never natively disabled', () => {
    const html = renderToStaticMarkup(<ConfirmDisclosure {...base} open pending />);
    expect(html).toContain('Withdrawing...');
    expect(html).toContain('aria-disabled="true"');
  });

  it('InlineConfirm still exports the same ConfirmPanel (Sessions forms keep importing it from there)', () => {
    expect(inline.ConfirmPanel).toBe(ConfirmPanel);
  });
});
