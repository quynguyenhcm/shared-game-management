'use client';

import type { TeamMemberRow } from '@sgm/shared';
import { startTransition, useEffect, useRef, useState, type FormEvent } from 'react';
import { setAutoEnrollAction, setSkillLevelAction } from '../../lib/teams/actions.ts';
import { SKILL_OVERRIDE_OPTIONS } from '../../lib/teams/labels.ts';
import {
  autoEnrollState,
  firstName,
  formatCalendarDate,
  skillRuleLine,
  validateUntil,
  type AutoEnrollState,
  type SkillPanelResult,
} from '../../lib/teams/skill-levels-view.ts';
import { FormBanner } from '../auth/form-banner.tsx';
import { FieldError } from '../auth/field-message.tsx';
import { FOCUS_RING, INPUT_CLASS, SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { useManage } from './manage-context.tsx';
import { OptionFieldset } from './option-fieldset.tsx';
import { useSkillPanelAction } from './use-skill-panel-action.ts';

type PanelMember = Pick<
  TeamMemberRow,
  'userId' | 'fullName' | 'skillLevel' | 'skillChangedAt' | 'autoEnroll' | 'skillProgress'
>;

const SAVE_BUTTON_CLASS = `inline-flex min-h-11 w-full items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-base font-medium text-white aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:w-auto ${FOCUS_RING}`;

const SKILL_HINT =
  'Used for pricing by skill level. Saving a different level restarts the count toward the next one.';
const FEE_LINE = (name: string): string =>
  `Sessions ${name} has already registered for keep their fee.`;

/** Open-state id of one member's panel in the Members section (one panel or confirm open per section). */
const panelKey = (userId: string): string => `skill-${userId}`;

/** The row button that opens the panel: a disclosure, never a dialog. */
export function SkillEnrollTrigger({
  userId,
  fullName,
  defaultOpen = false,
}: {
  userId: string;
  fullName: string;
  defaultOpen?: boolean;
}) {
  const { state, dispatch } = useManage();
  const key = panelKey(userId);
  const open = defaultOpen || state.open.members === key;
  return (
    <button
      type="button"
      id={`${key}-trigger`}
      aria-expanded={open}
      aria-controls={`${key}-panel`}
      aria-label={`Skill and Auto Enroll, ${fullName}`}
      onClick={() => {
        dispatch(
          open
            ? { type: 'close', section: 'members', id: key }
            : { type: 'open', section: 'members', id: key },
        );
      }}
      className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}
    >
      Skill and Auto Enroll
    </button>
  );
}

/**
 * The non-modal panel under a member's row, with two independent forms (level, Auto Enroll). It is mounted
 * only while open, so the name-derived ids of `OptionFieldset` never repeat. It stays open after a
 * successful save; each form reports in its own status line.
 */
export function SkillEnrollPanel({
  teamId,
  member,
  todayNz,
  defaultOpen = false,
}: {
  teamId: string;
  member: PanelMember;
  todayNz: string;
  /** Render open on first render (tests). */
  defaultOpen?: boolean;
}) {
  const { state } = useManage();
  const open = defaultOpen || state.open.members === panelKey(member.userId);
  return open ? <OpenPanel teamId={teamId} member={member} todayNz={todayNz} /> : null;
}

type FormKind = 'skill' | 'autoEnroll';

function OpenPanel({
  teamId,
  member,
  todayNz,
}: {
  teamId: string;
  member: PanelMember;
  todayNz: string;
}) {
  const { dispatch } = useManage();
  const key = panelKey(member.userId);
  const headingId = `${key}-heading`;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const skill = useSkillPanelAction('skill', setSkillLevelAction);
  const enroll = useSkillPanelAction('autoEnroll', setAutoEnrollAction);
  // Only the form last submitted shows a message; saving the other one clears it.
  const [last, setLast] = useState<FormKind | null>(null);
  const busy = skill.pending || enroll.pending;

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const close = (): void => {
    dispatch({ type: 'close', section: 'members', id: key });
    document.getElementById(`${key}-trigger`)?.focus();
  };

  const fields = { teamId, userId: member.userId, fullName: member.fullName };

  return (
    <div
      id={`${key}-panel`}
      role="group"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
      className="flex w-full flex-col gap-4 rounded-md border-2 border-slate-900 bg-slate-50 p-4"
    >
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className={`min-w-0 break-words text-base font-semibold ${FOCUS_RING}`}
      >
        {`Skill and Auto Enroll for ${member.fullName}`}
      </h3>
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2">
        <SkillLevelForm
          fields={fields}
          member={member}
          busy={busy}
          pending={skill.pending}
          formAction={skill.formAction}
          result={last === 'skill' && !skill.pending ? skill.state : null}
          onSubmit={() => {
            setLast('skill');
          }}
        />
        <AutoEnrollForm
          fields={fields}
          member={member}
          todayNz={todayNz}
          busy={busy}
          pending={enroll.pending}
          formAction={enroll.formAction}
          result={last === 'autoEnroll' && !enroll.pending ? enroll.state : null}
          onSubmit={() => {
            setLast('autoEnroll');
          }}
        />
      </div>
      <div>
        <button type="button" onClick={close} className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}>
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * Sends the form to its Server Action by hand. A `<form action>` is reset by React when the action finishes,
 * which would wipe the typed level and date on a failure ("values are kept") and flash the old ones on a
 * success; dispatching the action ourselves leaves the fields as the admin left them.
 */
function send(form: HTMLFormElement, formAction: (formData: FormData) => void): void {
  const data = new FormData(form);
  startTransition(() => {
    formAction(data);
  });
}

function HiddenFields({ fields }: { fields: Record<string, string> }) {
  return (
    <>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/** The persistent status line under a Save: present and empty from first render so the first message is read. */
function StatusLine({ id, result }: { id: string; result: SkillPanelResult | null }) {
  return (
    <div role="status" id={id} className="text-base">
      {result?.ok === true ? <p className="font-medium">{result.message}</p> : null}
    </div>
  );
}

function SaveButton({ label, pending, busy }: { label: string; pending: boolean; busy: boolean }) {
  return (
    <button
      type="submit"
      aria-disabled={busy ? 'true' : undefined}
      onClick={(event) => {
        if (busy) event.preventDefault();
      }}
      className={SAVE_BUTTON_CLASS}
    >
      {pending ? 'Saving…' : label}
    </button>
  );
}

function SkillLevelForm({
  fields,
  member,
  busy,
  pending,
  formAction,
  result,
  onSubmit,
}: {
  fields: Record<string, string>;
  member: PanelMember;
  busy: boolean;
  pending: boolean;
  formAction: (formData: FormData) => void;
  result: SkillPanelResult | null;
  onSubmit: () => void;
}) {
  const levelError = result?.fieldErrors?.skillLevel?.[0];
  const banner = result !== null && !result.ok && levelError === undefined ? result : null;

  useEffect(() => {
    if (levelError !== undefined) document.getElementById('field-skillLevel')?.focus();
  }, [result, levelError]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        onSubmit();
        send(event.currentTarget, formAction);
      }}
      className="flex flex-col gap-3"
    >
      <HiddenFields
        fields={{
          ...fields,
          expectedSkillLevel: member.skillLevel,
          expectedChangedAt: member.skillChangedAt ?? '',
        }}
      />
      {banner === null ? null : (
        <FormBanner kind="error" lines={[banner.message]} focusToken={banner} />
      )}
      {/* Re-keyed by the saved level so a revalidate refreshes the preselection; never the form or button. */}
      <div key={`${member.skillLevel}-${member.skillChangedAt ?? ''}`}>
        <OptionFieldset
          name="skillLevel"
          legend="Skill level"
          hint={SKILL_HINT}
          error={levelError}
          options={SKILL_OVERRIDE_OPTIONS}
          defaultValue={member.skillLevel}
        />
      </div>
      <p className="text-sm text-slate-700">
        {skillRuleLine(member.fullName, member.skillLevel, member.skillProgress)}
      </p>
      <p className="text-sm text-slate-700">{FEE_LINE(firstName(member.fullName))}</p>
      <SaveButton label="Save skill level" pending={pending} busy={busy} />
      <StatusLine id={`${panelKey(member.userId)}-skill-status`} result={result} />
    </form>
  );
}

function autoEnrollHint(name: string): string {
  return `Adds ${name} to new sessions automatically, in the order Auto Enroll was switched on. Sessions still follow the usual capacity and payment rules, so ${name} is charged like any other player. Only turn this on for players who have agreed to it.`;
}

function AutoEnrollForm({
  fields,
  member,
  todayNz,
  busy,
  pending,
  formAction,
  result,
  onSubmit,
}: {
  fields: Record<string, string>;
  member: PanelMember;
  todayNz: string;
  busy: boolean;
  pending: boolean;
  formAction: (formData: FormData) => void;
  result: SkillPanelResult | null;
  onSubmit: () => void;
}) {
  const saved = autoEnrollState(member.autoEnroll, todayNz);
  const [clientError, setClientError] = useState<string | null>(null);
  const shown = clientError === null ? result : null;
  const untilError = clientError ?? shown?.fieldErrors?.until?.[0];
  const banner = shown !== null && !shown.ok && untilError === undefined ? shown : null;
  const dateId = `${panelKey(member.userId)}-until`;

  useEffect(() => {
    if (untilError !== undefined) document.getElementById(dateId)?.focus();
  }, [result, untilError, dateId]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    const elements = event.currentTarget.elements;
    const box = elements.namedItem('enabled');
    const date = elements.namedItem('until');
    if (box instanceof HTMLInputElement && box.checked && date instanceof HTMLInputElement) {
      const message = validateUntil(date.value, date.validity.badInput, todayNz);
      if (message !== null) {
        setClientError(message);
        return;
      }
    }
    setClientError(null);
    onSubmit();
    send(event.currentTarget, formAction);
  };

  // noValidate: `min` would otherwise make the browser block the submit with its own bubble before
  // `validateUntil` can show the field error in the page's own copy.
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      {/* The stored state the panel is showing (an ended assignment still reads enabled), for the stale check. */}
      <HiddenFields
        fields={{
          ...fields,
          expectedEnabled: String(member.autoEnroll.enabled),
          expectedUntil: member.autoEnroll.until ?? '',
          expectedAssignedAt: member.autoEnroll.assignedAt ?? '',
        }}
      />
      {banner === null ? null : (
        <FormBanner kind="error" lines={[banner.message]} focusToken={banner} />
      )}
      {/* Re-keyed by the saved state so a revalidate refreshes the box and date; never the form or button. */}
      <AutoEnrollFields
        key={`${member.autoEnroll.enabled}-${member.autoEnroll.until ?? ''}-${member.autoEnroll.assignedAt ?? ''}`}
        fullName={member.fullName}
        saved={saved}
        todayNz={todayNz}
        dateId={dateId}
        untilError={untilError}
        onEdit={() => {
          setClientError(null);
        }}
      />
      <SaveButton label="Save Auto Enroll" pending={pending} busy={busy} />
      <StatusLine id={`${panelKey(member.userId)}-enroll-status`} result={shown} />
    </form>
  );
}

function AutoEnrollFields({
  fullName,
  saved,
  todayNz,
  dateId,
  untilError,
  onEdit,
}: {
  fullName: string;
  saved: AutoEnrollState;
  todayNz: string;
  dateId: string;
  untilError: string | undefined;
  onEdit: () => void;
}) {
  const [enabled, setEnabled] = useState(saved.kind === 'active');
  const initialUntil = saved.kind === 'active' ? (saved.until ?? '') : '';
  const [hasValue, setHasValue] = useState(initialUntil !== '');
  const dateRef = useRef<HTMLInputElement>(null);
  const hintId = `${dateId}-hint`;
  const boxHintId = `${dateId}-box-hint`;
  const offHintId = `${dateId}-off-hint`;
  const errorId = `${dateId}-error`;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-base font-medium">Auto Enroll</legend>
      <label className="flex min-h-11 items-center gap-3 text-base">
        <input
          type="checkbox"
          name="enabled"
          value="true"
          checked={enabled}
          aria-describedby={boxHintId}
          onChange={(event) => {
            setEnabled(event.target.checked);
            onEdit();
          }}
          className={`size-5 ${FOCUS_RING}`}
        />
        Auto Enroll
      </label>
      <p id={boxHintId} className="text-sm text-slate-700">
        {autoEnrollHint(firstName(fullName))}
      </p>
      {saved.kind === 'active' ? (
        <p id={offHintId} hidden={enabled} className="text-sm text-slate-700">
          {`Turning this off removes ${fullName}'s place in the Auto Enroll order. Turning it on again puts them at the end.`}
        </p>
      ) : null}
      {saved.kind === 'ended' ? (
        <p className="text-sm text-slate-700">
          {`Auto Enroll ended ${formatCalendarDate(saved.until)}. Choose a new end date, clear the date, or turn Auto Enroll off.`}
        </p>
      ) : null}
      {/* Hidden and disabled while unticked, so the date is neither shown nor submitted (off + date is refused),
          and re-ticking restores what was typed. */}
      <div hidden={!enabled} className="flex flex-col gap-1">
        <label htmlFor={dateId} className="text-base font-medium">
          Until (optional)
        </label>
        <input
          ref={dateRef}
          id={dateId}
          type="date"
          name="until"
          min={todayNz}
          defaultValue={initialUntil}
          disabled={!enabled}
          aria-invalid={untilError === undefined ? undefined : 'true'}
          aria-describedby={untilError === undefined ? hintId : `${hintId} ${errorId}`}
          onChange={(event) => {
            setHasValue(event.target.value !== '');
            onEdit();
          }}
          className={INPUT_CLASS}
        />
        <p id={hintId} className="text-sm text-slate-700">
          The last day Auto Enroll applies, in NZ time. Leave empty for no end date.
        </p>
        {untilError === undefined ? null : <FieldError id={errorId} message={untilError} />}
        {hasValue ? (
          <button
            type="button"
            onClick={() => {
              if (dateRef.current !== null) {
                dateRef.current.value = '';
                dateRef.current.focus();
              }
              setHasValue(false);
              onEdit();
            }}
            className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}
          >
            Clear date
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}
