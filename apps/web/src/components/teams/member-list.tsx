import { BAN_REASON_MAX_LENGTH, type TeamMemberRow } from '@sgm/shared';
import {
  banMemberAction,
  demoteMemberAction,
  demoteSelfAction,
  promoteMemberAction,
} from '../../lib/teams/actions.ts';
import {
  BAN_REASON_LABEL,
  SELF_DEMOTE_PROMPT,
  banPrompt,
  emptyMembersLine,
  SKILL_OPTIONS,
} from '../../lib/teams/labels.ts';
import { memberRowControls } from '../../lib/teams/manage-view.ts';
import { LINK_CLASS, SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { InlineConfirm } from './inline-confirm.tsx';
import { ModerationButton } from './moderation-button.tsx';
import { Tag } from './team-shell.tsx';

/**
 * Approved rows: admins first, then by name (the API orders them). The row's action area is a list of
 * controls chosen by `memberRowControls`, so a later feature (skill override) adds one more control here
 * without touching the row layout.
 */
export function MemberList({
  teamId,
  members,
  selfUserId,
  adminCount,
}: {
  teamId: string;
  members: readonly TeamMemberRow[];
  selfUserId: string;
  adminCount: number;
}) {
  const onlyYou = members.length === 1 && members[0]?.userId === selfUserId;
  return (
    <>
      {onlyYou ? (
        <p className="text-base">
          {emptyMembersLine()}{' '}
          <a href="#invite" className={LINK_CLASS}>
            Go to Invite link
          </a>
        </p>
      ) : null}
      <ul aria-labelledby="members-heading" className="flex flex-col gap-3">
        {members.map((person) => {
          const controls = memberRowControls({ member: person, selfUserId, adminCount });
          const fields = { teamId, userId: person.userId, fullName: person.fullName };
          const slot = `role-${person.userId}`;
          const hintId = `ban-hint-${person.userId}`;
          const skill = SKILL_OPTIONS.find((option) => option.value === person.skillLevel)?.label;
          return (
            <li
              key={person.userId}
              className="flex flex-col gap-3 rounded-md border border-slate-300 p-4 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
                  <span className="break-words font-medium">{person.fullName}</span>
                  {controls.isSelf ? <span>(you)</span> : null}
                  <Tag>{controls.roleLabel}</Tag>
                </p>
                <p className="text-base">{skill ?? person.skillLevel}</p>
              </div>
              <div className="flex flex-wrap items-start gap-2 sm:justify-end">
                <div data-slot={slot} className="flex flex-col gap-1">
                  {controls.roleControl.kind === 'promote' ? (
                    <ModerationButton
                      kind="promote"
                      action={promoteMemberAction}
                      fields={fields}
                      label="Make admin"
                      ariaLabel={`Make admin, ${person.fullName}`}
                      pendingLabel="Making admin…"
                      focus={`[data-slot="${slot}"] button`}
                    />
                  ) : null}
                  {controls.roleControl.kind === 'demote' ? (
                    <ModerationButton
                      kind="demote"
                      action={demoteMemberAction}
                      fields={fields}
                      label="Remove admin"
                      ariaLabel={`Remove admin, ${person.fullName}`}
                      pendingLabel="Removing…"
                      focus={`[data-slot="${slot}"] button`}
                    />
                  ) : null}
                  {controls.roleControl.kind === 'demote_self' ? (
                    <InlineConfirm
                      id="self-demote"
                      kind="demote"
                      action={demoteSelfAction}
                      fields={fields}
                      triggerLabel="Remove admin"
                      triggerAriaLabel={`Remove admin, ${person.fullName}`}
                      prompt={SELF_DEMOTE_PROMPT}
                      confirmLabel="Remove admin"
                      pendingLabel="Removing…"
                      destructive
                    />
                  ) : null}
                  {controls.roleControl.kind === 'demote_blocked' ? (
                    <p className="max-w-64 text-base">{controls.roleControl.hint}</p>
                  ) : null}
                </div>
                {controls.banControl.kind === 'ban' ? (
                  <InlineConfirm
                    id={`ban-${person.userId}`}
                    kind="ban"
                    action={banMemberAction}
                    fields={fields}
                    triggerLabel="Ban"
                    triggerAriaLabel={`Ban ${person.fullName}`}
                    prompt={banPrompt(person.fullName)}
                    confirmLabel="Ban member"
                    pendingLabel="Banning…"
                    destructive
                    reasonField={{
                      name: 'reason',
                      label: BAN_REASON_LABEL,
                      maxLength: BAN_REASON_MAX_LENGTH,
                    }}
                  />
                ) : null}
                {controls.banControl.kind === 'blocked' ? (
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      aria-disabled="true"
                      aria-label={`Ban ${person.fullName}`}
                      aria-describedby={hintId}
                      className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}
                    >
                      Ban
                    </button>
                    <p id={hintId} className="max-w-64 text-base">
                      {controls.banControl.hint}
                    </p>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
