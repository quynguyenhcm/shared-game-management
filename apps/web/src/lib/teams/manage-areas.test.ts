import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANAGE_AREAS, manageAreaLinks } from './manage-areas.ts';

const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';

describe('manage area registry (UI/UX Q2: the plug-in seam for later admin areas)', () => {
  it('holds People at the manage root and Banking and GST under /banking', () => {
    expect(MANAGE_AREAS.map((area) => [area.id, area.label, area.segment])).toEqual([
      ['people', 'People', ''],
      ['banking', 'Banking and GST', 'banking'],
    ]);
  });

  it('renders the nav with hrefs under the manage root and exactly one area current (default: People)', () => {
    expect(manageAreaLinks(TEAM_ID)).toEqual([
      { id: 'people', label: 'People', href: `/teams/${TEAM_ID}/manage`, current: true },
      {
        id: 'banking',
        label: 'Banking and GST',
        href: `/teams/${TEAM_ID}/manage/banking`,
        current: false,
      },
    ]);
  });

  it('marks the banking area current when asked, and still exactly one', () => {
    const links = manageAreaLinks(TEAM_ID, MANAGE_AREAS, 'banking');
    expect(links.filter((link) => link.current).map((link) => link.id)).toEqual(['banking']);
  });

  it('still renders no nav for a single-area registry (a one-link nav is noise)', () => {
    expect(manageAreaLinks(TEAM_ID, MANAGE_AREAS.slice(0, 1))).toEqual([]);
  });
});

describe('every area page renders ManageAreaNav (UI/UX Sub-decision A guard)', () => {
  const manageDir = fileURLToPath(new URL('../../app/teams/[teamId]/manage/', import.meta.url));

  it.each(MANAGE_AREAS.map((area) => [area.id, area.segment] as const))(
    'the %s page file uses ManageAreaNav with its own current id',
    (id, segment) => {
      const file = `${manageDir}${segment === '' ? '' : `${segment}/`}page.tsx`;
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('ManageAreaNav');
      expect(source).toMatch(new RegExp(`current=(["']${id}["']|\\{["']${id}["']\\})`));
    },
  );

  it('the shared layout no longer renders the nav, and NoAccess never does', () => {
    expect(readFileSync(`${manageDir}layout.tsx`, 'utf8')).not.toContain('<nav');
    const noAccess = fileURLToPath(
      new URL('../../components/teams/no-access.tsx', import.meta.url),
    );
    expect(readFileSync(noAccess, 'utf8')).not.toContain('ManageAreaNav');
  });
});
