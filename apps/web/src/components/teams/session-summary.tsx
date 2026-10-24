import { instantToLocal, type SessionResponse } from '@sgm/shared';
import type { ReactNode } from 'react';
import {
  formatClock,
  formatDay,
  formatDayShort,
  formatMoneyText,
  pricingLine,
  readOnlyReason,
  sessionLabel,
} from '../../lib/teams/sessions-view.ts';
import { LINK_CLASS } from '../auth/styles.ts';

export interface BackLink {
  href: string;
  label: string;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="flex flex-col gap-1">
      {rows.map(([term, value]) => (
        <div key={term} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
          <dt className="text-base font-medium sm:w-48">{term}</dt>
          <dd className="min-w-0 break-words text-base text-slate-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The read-only view of a session that has started, ended, completed, been cancelled or expired as a draft
 * (UI/UX "Read-only session summary"): `dl` groups and a real courts table, never disabled inputs. The
 * reason sits in a bordered block with no live-region role (it is page content). No Save, Publish or Cancel
 * is rendered; a form posted across the boundary answers 409 and reloads this view.
 */
export function SessionSummary({
  session,
  isPayoutConfigured,
  backLinks,
}: {
  session: SessionResponse;
  isPayoutConfigured: boolean;
  backLinks: readonly BackLink[];
}) {
  const reason = readOnlyReason(session);
  const label = sessionLabel(session, { isPayoutConfigured });
  const deadline =
    session.cancellationDeadline === null
      ? 'None'
      : (() => {
          const local = instantToLocal(new Date(session.cancellationDeadline));
          return `${formatDayShort(local.date)}, ${formatClock(local.time)}`;
        })();
  return (
    <div className="flex flex-col gap-6">
      {reason === null ? null : (
        <div className="rounded-md border-2 border-slate-900 p-4 text-base">{reason}</div>
      )}
      <ul className="flex flex-wrap gap-2">
        {[label.label, ...label.tags].map((text) => (
          <li
            key={text}
            className="rounded-md border border-slate-500 px-2 py-1 text-sm text-slate-900"
          >
            {text}
          </li>
        ))}
      </ul>
      <Group title="Details">
        <Rows
          rows={[
            ['Location', session.location],
            ['Address', session.address],
            ['Date', formatDay(session.date)],
          ]}
        />
      </Group>
      <Group title="Courts">
        <table className="w-full max-w-lg text-left text-base">
          <thead>
            <tr>
              <th scope="col" className="py-1 pr-4 font-medium">
                Court
              </th>
              <th scope="col" className="py-1 pr-4 font-medium">
                Start
              </th>
              <th scope="col" className="py-1 font-medium">
                End
              </th>
            </tr>
          </thead>
          <tbody>
            {session.courts.map((court) => (
              <tr key={court.id} className="border-t border-slate-300">
                <th scope="row" className="py-1 pr-4 font-normal">
                  {court.identifier}
                </th>
                <td className="py-1 pr-4">{formatClock(court.startTime)}</td>
                <td className="py-1">{formatClock(court.endTime)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Group>
      <Group title="Places">
        <Rows
          rows={[
            ['Max players', String(session.maxPlayers)],
            ['Reserved host seats', String(session.reservedSeats)],
          ]}
        />
      </Group>
      <Group title="Costing">
        <Rows
          rows={[
            ['Court hire', formatMoneyText(session.courtCost)],
            ['Extra expenses', formatMoneyText(session.extraExpenses)],
          ]}
        />
      </Group>
      <Group title="Pricing">
        <p className="text-base text-slate-900">{pricingLine(session)}</p>
      </Group>
      <Group title="Cancellation deadline">
        <p className="text-base text-slate-900">{deadline}</p>
      </Group>
      <nav aria-label="Back links" className="flex flex-col gap-1 sm:flex-row sm:gap-6">
        {backLinks.map((link) => (
          <a key={link.href} href={link.href} className={LINK_CLASS}>
            {`‹ ${link.label}`}
          </a>
        ))}
      </nav>
    </div>
  );
}
