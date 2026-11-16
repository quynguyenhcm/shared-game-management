import type { OpenSessionsResponse } from '@sgm/shared';
import { debtMessage } from '../../lib/registrations/labels.ts';
import {
  FIND_A_TEAM,
  GO_TO_PAYMENTS,
  NO_OPEN_SESSIONS,
  NO_TEAM_OPEN,
  OPEN_LOAD_FAILED,
  TAB_LABELS,
} from '../../lib/dashboard/labels.ts';
import { tabPath } from '../../lib/dashboard/paths.ts';
import { openSessionCard, type OpenSessionCard } from '../../lib/dashboard/view.ts';
import { BUTTON_CLASS, LINK_CLASS, SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { Tag } from '../teams/team-shell.tsx';

export type OpenSessionsState =
  | { kind: 'failed' }
  /** `hasTeam` only matters for an empty list: it picks between "join a team" and "nothing open". */
  | { kind: 'ok'; data: OpenSessionsResponse; hasTeam: boolean };

function SessionCard({ card }: { card: OpenSessionCard }) {
  const { button } = card;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-slate-300 p-3">
      <a href={card.teamHref} className={`${LINK_CLASS} min-w-0 break-words self-start text-sm`}>
        {card.teamName}
      </a>
      <h3 className="min-w-0 break-words text-lg font-semibold">{card.heading}</h3>
      <p className="text-base">{card.when}</p>
      <p className="min-w-0 break-words text-base">{card.address}</p>
      <p className="text-base">{card.feeText}</p>
      <p className="text-base">{card.seatsText}</p>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={button.href}
          className={`${button.secondary ? SECONDARY_BUTTON_CLASS : BUTTON_CLASS} sm:w-auto`}
        >
          {button.text}
          <span className="sr-only">{button.srSuffix}</span>
        </a>
        {button.tag === null ? null : <Tag>{button.tag}</Tag>}
      </div>
    </li>
  );
}

/**
 * Currently Opening: the upcoming published sessions of the caller's approved teams, in the order the API returned them. A
 * button per card links to the existing session page (the only place a registration is made). The list is capped by the API
 * and has no cursor, so there is no "Show more" here. A debt banner leads when payments are overdue.
 */
export function OpenSessionsTab({ state }: { state: OpenSessionsState }) {
  if (state.kind === 'failed') {
    return (
      <p role="status" className="text-base">
        {OPEN_LOAD_FAILED}
      </p>
    );
  }
  const { sessions, overdueCount } = state.data;
  return (
    <section aria-labelledby="opening-heading" className="flex flex-col gap-4">
      <h2 id="opening-heading" className="sr-only">
        {TAB_LABELS.opening}
      </h2>
      {overdueCount >= 1 ? (
        <div role="status" className="flex flex-col gap-1 rounded-md border-2 border-slate-900 p-3">
          <p className="text-base">{debtMessage(overdueCount)}</p>
          <a href={tabPath('payments')} className={`${LINK_CLASS} self-start`}>
            {GO_TO_PAYMENTS}
          </a>
        </div>
      ) : null}
      {sessions.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {sessions.map((row) => {
            const card = openSessionCard(row);
            return <SessionCard key={card.key} card={card} />;
          })}
        </ul>
      ) : state.hasTeam ? (
        <p className="text-base">{NO_OPEN_SESSIONS}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-base">{NO_TEAM_OPEN}</p>
          <a href="/teams/find" className={`${LINK_CLASS} self-start`}>
            {FIND_A_TEAM}
          </a>
        </div>
      )}
    </section>
  );
}
