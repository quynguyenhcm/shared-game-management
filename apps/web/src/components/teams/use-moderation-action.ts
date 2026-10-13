'use client';

import { useActionState } from 'react';
import {
  sectionFor,
  type ModerationAction,
  type ModerationKind,
  type ModerationResult,
} from '../../lib/teams/moderation.ts';
import { OUTAGE_MESSAGE } from '../../lib/teams/labels.ts';
import { sectionHeadingId } from '../../lib/teams/manage-view.ts';
import { useManage } from './manage-context.tsx';

/**
 * Runs a manage Server Action as a form action and reports its result to the section's status region.
 * Reporting happens inside the action (not in an effect) because an approved or banned row unmounts when
 * the page revalidates, which would drop an effect-based message. `focus` is the CSS selector to focus
 * after a success; by default the section heading (where focus goes when a row leaves its list).
 */
export function useModerationAction(
  kind: ModerationKind,
  action: ModerationAction,
  focus?: string,
): { state: ModerationResult | null; formAction: (formData: FormData) => void; pending: boolean } {
  const { dispatch } = useManage();
  const section = sectionFor(kind);
  const [state, formAction, pending] = useActionState<ModerationResult | null, FormData>(
    async (previous, formData) => {
      let result: ModerationResult;
      try {
        result = await action(previous, formData);
      } catch (error) {
        // A rejected fetch (the browser is offline) is an outage, not a crash. Redirects are not caught here.
        if (!(error instanceof TypeError)) throw error;
        result = { ok: false, code: 'offline', message: OUTAGE_MESSAGE, refresh: false };
      }
      dispatch({
        type: 'result',
        section,
        message: result.message,
        ok: result.ok,
        ...(result.ok ? { focus: focus ?? `#${sectionHeadingId(section)}` } : {}),
      });
      return result;
    },
    null,
  );
  return { state, formAction, pending };
}
