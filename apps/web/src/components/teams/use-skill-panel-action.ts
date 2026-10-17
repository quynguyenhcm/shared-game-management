'use client';

import { useActionState } from 'react';
import { UNCONFIRMED_MESSAGE } from '../../lib/teams/labels.ts';
import { sectionHeadingId } from '../../lib/teams/manage-view.ts';
import type {
  SkillPanelAction,
  SkillPanelResult,
  SkillResultKind,
} from '../../lib/teams/skill-levels-view.ts';
import { useManage } from './manage-context.tsx';

/**
 * Runs a skill-panel Server Action as a form action and hands the result back to its form (the form shows
 * the status line, banner and field errors itself). Unlike `useModerationAction` a success is NOT reported to
 * the Members status region and does not move focus: the panel stays open and the pressed Save keeps focus.
 * Only a result that makes the row unreachable (`close`: stale, gone or no access) is reported to the
 * Members region, which closes the panel and sends focus to the section heading, because the trigger it
 * would return to may no longer exist.
 */
export function useSkillPanelAction(
  kind: SkillResultKind,
  action: SkillPanelAction,
): {
  state: SkillPanelResult | null;
  formAction: (formData: FormData) => void;
  pending: boolean;
} {
  const { dispatch } = useManage();
  const [state, formAction, pending] = useActionState<SkillPanelResult | null, FormData>(
    async (previous, formData) => {
      let result: SkillPanelResult;
      try {
        result = await action(previous, formData);
      } catch (error) {
        // A rejected fetch (the browser is offline): the request may or may not have arrived. Redirects are
        // not caught here.
        if (!(error instanceof TypeError)) throw error;
        result = {
          ok: false,
          kind,
          code: 'offline',
          message: UNCONFIRMED_MESSAGE,
          refresh: false,
        };
      }
      if (result.close === true) {
        dispatch({
          type: 'result',
          section: 'members',
          message: result.message,
          ok: false,
          close: true,
          focus: `#${sectionHeadingId('members')}`,
        });
      }
      return result;
    },
    null,
  );
  return { state, formAction, pending };
}
