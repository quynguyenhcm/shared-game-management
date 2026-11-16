import type { DashboardRegistrationRow, DashboardRegistrationsResponse } from '@sgm/shared';
import {
  NO_REGISTRATIONS,
  PAST_HEADING,
  REGISTRATIONS_LOAD_FAILED,
  SEE_OPEN_SESSIONS,
  UPCOMING_HEADING,
  VIEW_PAYMENT,
  VIEW_SESSION,
} from '../../lib/dashboard/labels.ts';
import { DASHBOARD_PATH, registrationsPagePath } from '../../lib/dashboard/paths.ts';
import { registrationCard, type RegistrationCard } from '../../lib/dashboard/view.ts';
import { SHOW_MORE } from '../../lib/billing/labels.ts';
import { LINK_CLASS } from '../auth/styles.ts';
import { Tag } from '../teams/team-shell.tsx';

export type RegistrationsState =
  | { kind: 'failed' }
  /** `firstPage` is false when `?cursor=` is set: the API then returns only the next `Past` page. */
  | { kind: 'ok'; data: DashboardRegistrationsResponse; firstPage: boolean };

function Card({ card }: { card: RegistrationCard }) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-slate-300 p-3">
      <h3 className="min-w-0 break-words text-lg font-semibold">{card.heading}</h3>
      <a href={card.teamHref} className={`${LINK_CLASS} min-w-0 break-words self-start text-sm`}>
        {card.teamName}
      </a>
      <p className="text-base">{card.when}</p>
      <p className="min-w-0 break-words text-base">{card.address}</p>
      <p className="text-base">{card.group}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-medium">{card.state}</span>
        {card.tag === null ? null : <Tag>{card.tag.text}</Tag>}
      </div>
      {card.total === null ? null : <p className="text-base">{card.total}</p>}
      {card.note === null ? null : <p className="text-sm">{card.note}</p>}
      <div className="flex flex-wrap gap-x-4">
        {card.paymentHref === null ? null : (
          <a href={card.paymentHref} className={LINK_CLASS}>
            {VIEW_PAYMENT}
          </a>
        )}
        <a href={card.sessionHref} className={LINK_CLASS}>
          {VIEW_SESSION}
        </a>
      </div>
    </li>
  );
}

function Section({
  id,
  title,
  rows,
}: {
  id: string;
  title: string;
  rows: readonly DashboardRegistrationRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const card = registrationCard(row);
          return <Card key={card.key} card={card} />;
        })}
      </ul>
    </section>
  );
}

/**
 * My Registration: every registration with its date, state, payment tag, team, address and total. Upcoming is first-page only;
 * Past pages by the API's opaque cursor through a plain `Show more` link. An unbilled row says so (never a made-up PENDING).
 */
export function RegistrationsTab({ state }: { state: RegistrationsState }) {
  if (state.kind === 'failed') {
    return (
      <p role="status" className="text-base">
        {REGISTRATIONS_LOAD_FAILED}
      </p>
    );
  }
  const { upcoming, past, nextCursor } = state.data;
  if (upcoming.length + past.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-base">{NO_REGISTRATIONS}</p>
        <a href={DASHBOARD_PATH} className={`${LINK_CLASS} self-start`}>
          {SEE_OPEN_SESSIONS}
        </a>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {state.firstPage ? <Section id="upcoming" title={UPCOMING_HEADING} rows={upcoming} /> : null}
      <Section id="past" title={PAST_HEADING} rows={past} />
      {nextCursor === null ? null : (
        <a href={registrationsPagePath(nextCursor)} className={`${LINK_CLASS} self-start`}>
          {SHOW_MORE}
        </a>
      )}
    </div>
  );
}
