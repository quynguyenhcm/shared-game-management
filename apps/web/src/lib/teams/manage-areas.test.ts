import { describe, expect, it } from 'vitest';
import { MANAGE_AREAS, manageAreaLinks } from './manage-areas.ts';

const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';

describe('manage area registry (UI/UX Q2: the plug-in seam for later admin areas)', () => {
  it('holds only the People area today, at the manage root', () => {
    expect(MANAGE_AREAS.map((area) => [area.id, area.label, area.segment])).toEqual([
      ['people', 'People', ''],
    ]);
  });

  it('renders no area nav while there is a single area (a one-link nav is noise)', () => {
    expect(manageAreaLinks(TEAM_ID)).toEqual([]);
  });

  it('renders the nav once a second area registers, with hrefs under the manage root and the current one marked', () => {
    const areas = [
      ...MANAGE_AREAS,
      { id: 'banking', label: 'Banking', segment: 'banking' },
    ] as const;
    expect(manageAreaLinks(TEAM_ID, areas, 'banking')).toEqual([
      { id: 'people', label: 'People', href: `/teams/${TEAM_ID}/manage`, current: false },
      { id: 'banking', label: 'Banking', href: `/teams/${TEAM_ID}/manage/banking`, current: true },
    ]);
  });
});
