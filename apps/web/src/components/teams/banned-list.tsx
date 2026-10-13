import type { TeamMemberRow } from '@sgm/shared';
import { EMPTY_BANNED, bannedLine } from '../../lib/teams/labels.ts';

/** Banned rows, newest first, read-only. The reason is admin-only text: rendered escaped, never as HTML. */
export function BannedList({ members }: { members: readonly TeamMemberRow[] }) {
  if (members.length === 0) return <p className="text-base">{EMPTY_BANNED}</p>;
  return (
    <ul aria-labelledby="banned-heading" className="flex flex-col gap-3">
      {members.map((person) => (
        <li
          key={person.userId}
          className="flex flex-col gap-1 rounded-md border border-slate-300 p-4"
        >
          <p className="break-words text-base font-medium">{person.fullName}</p>
          <p className="whitespace-pre-line break-words text-base">
            {person.bannedAt === null ? (
              bannedLine(null, person.banReason)
            ) : (
              <time dateTime={person.bannedAt}>
                {bannedLine(person.bannedAt, person.banReason)}
              </time>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}
