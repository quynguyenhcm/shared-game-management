import type { TeamMemberRow } from '@sgm/shared';
import {
  autoEnrollTag,
  skillLevelLabel,
  skillProgressLine,
  skillProvenanceLine,
} from '../../lib/teams/skill-levels-view.ts';
import { Tag } from './team-shell.tsx';

/**
 * The read-only lines of an approved member's row: level and Auto Enroll tag, who set the level and when, and
 * how far the member is from the next level. Pure render of the view-model strings, so scanning the list
 * needs no clicks. Nothing relies on colour: every state is a word.
 */
export function MemberSkillSummary({
  member,
  todayNz,
}: {
  member: Pick<
    TeamMemberRow,
    'skillLevel' | 'skillOverride' | 'skillChangedAt' | 'autoEnroll' | 'skillProgress'
  >;
  todayNz: string;
}) {
  const tag = autoEnrollTag(member.autoEnroll, todayNz);
  return (
    <>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
        <span>
          <span className="sr-only">Skill level: </span>
          <span className="font-medium">{skillLevelLabel(member.skillLevel)}</span>
        </span>
        {tag === null ? null : <Tag>{tag}</Tag>}
      </p>
      <p className="text-sm text-slate-700">{skillProvenanceLine(member)}</p>
      <p className="text-sm text-slate-700">{skillProgressLine(member.skillProgress)}</p>
    </>
  );
}
