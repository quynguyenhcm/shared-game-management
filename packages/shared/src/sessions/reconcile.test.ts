import { describe, expect, it } from 'vitest';
import { parseMoney, type Money } from '../money/money.ts';
import { parseLocalDate, parseLocalTime, type LocalDate } from '../time/time.ts';
import type { SessionStatus } from '../types/enums.ts';
import { buildInstance, type RuleCourtTemplate, type SeriesTemplate } from './instance.ts';
import {
  planEndSeries,
  planSeriesReconciliation,
  seriesChangeEffect,
  summariseReconciliation,
  type ExistingInstance,
  type ReconcileAction,
  type SeriesRule,
} from './reconcile.ts';

const m = (s: string): Money => parseMoney(s);
const date = (s: string): LocalDate => parseLocalDate(s);
const court = (start: string, end: string): RuleCourtTemplate => ({
  courtIdentifier: '1',
  startTime: parseLocalTime(start),
  endTime: parseLocalTime(end),
});

// Today is Tue 2026-10-20, 21:00 NZDT = 08:00Z (algorithm doc "Reconciliation vectors").
const TODAY = date('2026-10-20');
const NOW = new Date('2026-10-20T08:00:00.000Z');

const TEMPLATE: SeriesTemplate = {
  location: 'Rosedale Hall',
  address: '1 Hall Rd, Auckland',
  maxPlayers: 12,
  reservedSeats: 0,
  courtCost: m('120.00'),
  extraExpenses: m('12.00'),
  customPlayerRate: null,
  pricingStructure: 'FLAT',
  feeFlat: null,
  feeMale: null,
  feeFemale: null,
  feeOther: null,
  feeBeginner: null,
  feeIntermediate: null,
  feeAdvanced: null,
};

const OLD_COURTS = [court('18:00', '20:00')];
const NEW_COURTS = [court('19:00', '21:00')];

const RULE: SeriesRule = {
  frequency: 'WEEKLY',
  dayOfWeek: 3, // Wednesday
  startsOn: date('2026-09-02'),
  monthlyWeek: null,
  recurUntil: null,
  ...TEMPLATE,
};

interface Spec {
  readonly status: SessionStatus;
  readonly edited?: boolean;
  readonly registrations?: number;
  readonly template?: SeriesTemplate;
}

function instance(day: string, spec: Spec): ExistingInstance {
  const plan = buildInstance(spec.template ?? TEMPLATE, OLD_COURTS, date(day));
  return {
    ...plan,
    id: `s-${day}`,
    status: spec.status,
    isInstanceOverridden: spec.edited ?? false,
    activeRegistrationCount: spec.registrations ?? 0,
  };
}

/** The scenario table: 10-21 deadline passed, 10-28 unedited, 11-04 edited, 11-11 gate-refused draft. */
function scenario(): ExistingInstance[] {
  return [
    instance('2026-10-14', { status: 'COMPLETED' }),
    instance('2026-10-21', { status: 'PUBLISHED' }),
    instance('2026-10-28', { status: 'PUBLISHED' }),
    instance('2026-11-04', { status: 'PUBLISHED', edited: true }),
    instance('2026-11-11', { status: 'DRAFT' }),
  ];
}

function plan(
  newRule: SeriesRule,
  courts: readonly RuleCourtTemplate[],
  instances: ExistingInstance[],
): ReconcileAction[] {
  return planSeriesReconciliation({ rule: newRule, courts, instances, today: TODAY, now: NOW });
}

const brief = (actions: readonly ReconcileAction[]): string[] =>
  actions.map((a) =>
    a.kind === 'skip'
      ? `${a.date} skip:${a.reason}`
      : a.kind === 'keep_off_pattern'
        ? `${a.date} keep_off_pattern`
        : `${a.date} ${a.kind}`,
  );

describe('planSeriesReconciliation: the algorithm doc vectors (AC-HAPPY-7)', () => {
  it('start 18:00 -> 19:00', () => {
    const actions = plan(RULE, NEW_COURTS, scenario());
    expect(brief(actions)).toEqual([
      '2026-10-21 skip:deadline_passed',
      '2026-10-28 update',
      '2026-11-04 skip:edited',
      '2026-11-11 update',
    ]); // 10-14 (COMPLETED, before today) is never mentioned
    const update = actions.find((a) => a.kind === 'update' && a.date === '2026-10-28');
    expect(update?.kind === 'update' && update.target.startsAt.toISOString()).toBe(
      '2026-10-28T06:00:00.000Z',
    );
  });

  it('recur_until 2026-10-31 (End series shape)', () => {
    const actions = plan({ ...RULE, recurUntil: date('2026-10-31') }, OLD_COURTS, scenario());
    expect(brief(actions)).toEqual([
      '2026-10-21 unchanged',
      '2026-10-28 unchanged',
      '2026-11-04 keep_off_pattern',
      '2026-11-11 delete',
    ]);
  });

  it('no change (a retried save): zero writes', () => {
    const actions = plan(RULE, OLD_COURTS, scenario());
    expect(actions.some((a) => a.kind === 'update' || a.kind === 'delete')).toBe(false);
    expect(brief(actions)).toEqual([
      '2026-10-21 unchanged',
      '2026-10-28 unchanged',
      '2026-11-04 skip:edited',
      '2026-11-11 unchanged',
    ]);
  });

  it('is idempotent: applying the update targets and planning again changes nothing', () => {
    const first = plan(RULE, NEW_COURTS, scenario());
    const converged = scenario().map((i) => {
      const action = first.find((a) => a.kind === 'update' && a.sessionId === i.id);
      return action?.kind === 'update' ? { ...i, ...action.target } : i;
    });
    const second = plan(RULE, NEW_COURTS, converged);
    expect(second.some((a) => a.kind === 'update')).toBe(false);
  });
});

describe('planSeriesReconciliation: every skip reason (T-5)', () => {
  it('closed: a CANCELLED or COMPLETED future instance is never touched', () => {
    const actions = plan(RULE, NEW_COURTS, [
      instance('2026-10-28', { status: 'CANCELLED' }),
      instance('2026-11-04', { status: 'COMPLETED' }),
    ]);
    expect(brief(actions)).toEqual(['2026-10-28 skip:closed', '2026-11-04 skip:closed']);
  });

  it('started: a PUBLISHED instance whose start has passed', () => {
    // 2026-10-20 18:00 NZDT = 05:00Z, before now (08:00Z).
    const actions = plan(RULE, NEW_COURTS, [instance('2026-10-20', { status: 'PUBLISHED' })]);
    expect(brief(actions)).toEqual(['2026-10-20 skip:started']);
  });

  // A Thursday series (2026-10-22 is a Thursday), so the instance is on the pattern.
  const THURSDAY_RULE: SeriesRule = { ...RULE, dayOfWeek: 4, startsOn: date('2026-09-03') };
  const LATE_COURTS = [court('22:00', '23:30')];

  function lateInstance(status: SessionStatus): ExistingInstance {
    // Current: 22:00 NZDT 10-22 (09:00Z), deadline 10-20T09:00Z is still ahead of now (08:00Z).
    return {
      ...instance('2026-10-22', { status }),
      ...buildInstance(TEMPLATE, LATE_COURTS, date('2026-10-22')),
    };
  }

  it('deadline_passed: the new default deadline would already be in the past', () => {
    // New: 18:00 (05:00Z) puts the deadline at 10-20T05:00Z, already passed.
    const late = lateInstance('PUBLISHED');
    expect(late.cancellationDeadline.getTime()).toBeGreaterThan(NOW.getTime());
    expect(brief(plan(THURSDAY_RULE, OLD_COURTS, [late]))).toEqual([
      '2026-10-22 skip:deadline_passed',
    ]);
  });

  it('a DRAFT is not held to the deadline rule', () => {
    expect(brief(plan(THURSDAY_RULE, OLD_COURTS, [lateInstance('DRAFT')]))).toEqual([
      '2026-10-22 update',
    ]);
  });

  it('fee_locked: a raise reaching a PUBLISHED instance with registrations', () => {
    // 12 -> 10 players makes the followed FLAT suggestion rise from $11 to $14.
    const actions = plan({ ...RULE, maxPlayers: 10 }, OLD_COURTS, [
      instance('2026-10-28', { status: 'PUBLISHED', registrations: 3 }),
      instance('2026-11-04', { status: 'PUBLISHED', registrations: 0 }),
    ]);
    expect(brief(actions)).toEqual(['2026-10-28 skip:fee_locked', '2026-11-04 update']);
  });

  it('fee_locked: a fee decrease is applied even with registrations', () => {
    const actions = plan({ ...RULE, maxPlayers: 14 }, OLD_COURTS, [
      instance('2026-10-28', { status: 'PUBLISHED', registrations: 3 }),
    ]);
    expect(brief(actions)).toEqual(['2026-10-28 update']);
  });

  it('fee_locked: any pricing-structure change counts with registrations', () => {
    const bySex: SeriesRule = {
      ...RULE,
      pricingStructure: 'BY_SEX',
      feeMale: m('11.00'),
      feeFemale: m('11.00'),
      feeOther: m('11.00'),
    };
    const actions = plan(bySex, OLD_COURTS, [
      instance('2026-10-28', { status: 'PUBLISHED', registrations: 1 }),
    ]);
    expect(brief(actions)).toEqual(['2026-10-28 skip:fee_locked']);
  });

  it('precedence: closed, started, off-pattern, edited, unchanged, deadline, fee', () => {
    const edited = instance('2026-10-28', { status: 'PUBLISHED', edited: true, registrations: 5 });
    expect(brief(plan({ ...RULE, maxPlayers: 10 }, NEW_COURTS, [edited]))).toEqual([
      '2026-10-28 skip:edited',
    ]);
  });
});

describe('planSeriesReconciliation: off-pattern delete or keep, per status and override', () => {
  const ended: SeriesRule = { ...RULE, recurUntil: date('2026-10-21') };
  it.each([
    ['unedited DRAFT', { status: 'DRAFT' }, 'delete'],
    ['edited DRAFT', { status: 'DRAFT', edited: true }, 'keep_off_pattern'],
    ['unedited PUBLISHED', { status: 'PUBLISHED' }, 'keep_off_pattern'],
    ['edited PUBLISHED', { status: 'PUBLISHED', edited: true }, 'keep_off_pattern'],
  ] as const)('%s after the end date -> %s', (_name, spec, kind) => {
    const [action] = plan(ended, OLD_COURTS, [instance('2026-11-04', spec)]);
    expect(action?.kind).toBe(kind);
  });

  it('CANCELLED and COMPLETED after the end date are skipped as closed, not deleted', () => {
    const actions = plan(ended, OLD_COURTS, [
      instance('2026-11-04', { status: 'CANCELLED' }),
      instance('2026-11-11', { status: 'COMPLETED' }),
    ]);
    expect(brief(actions)).toEqual(['2026-11-04 skip:closed', '2026-11-11 skip:closed']);
  });

  it('a started off-pattern instance is skipped as started', () => {
    const actions = plan({ ...RULE, recurUntil: date('2026-10-19') }, OLD_COURTS, [
      instance('2026-10-20', { status: 'PUBLISHED' }),
    ]);
    expect(brief(actions)).toEqual(['2026-10-20 skip:started']);
  });
});

describe('summariseReconciliation and seriesChangeEffect (T-5, UI/UX assumption 5)', () => {
  it('counts updated, unchanged, removed, kept and skipped by reason', () => {
    const actions = plan({ ...RULE, recurUntil: date('2026-10-31') }, NEW_COURTS, [
      ...scenario(),
      instance('2026-10-27', { status: 'CANCELLED' }),
    ]);
    expect(summariseReconciliation(actions)).toEqual({
      updated: 1, // 10-28
      unchanged: 0,
      removed: 1, // 11-11 draft
      keptOffPattern: 1, // 11-04
      skipped: { edited: 0, started: 0, closed: 1, deadlinePassed: 1, feeLocked: 0 },
    });
  });

  it('maps each instance to will_update, edited, closed or has_registrations', () => {
    const instances = [
      instance('2026-10-21', { status: 'PUBLISHED' }),
      instance('2026-10-28', { status: 'PUBLISHED' }),
      instance('2026-11-04', { status: 'PUBLISHED', edited: true }),
      instance('2026-11-11', { status: 'CANCELLED' }),
      instance('2026-11-18', { status: 'PUBLISHED', registrations: 2 }),
    ];
    const effects = seriesChangeEffect({
      rule: { ...RULE, maxPlayers: 10 },
      courts: NEW_COURTS,
      instances,
      today: TODAY,
      now: NOW,
    });
    expect(effects.map((e) => `${e.date} ${e.effect}`)).toEqual([
      '2026-10-21 closed', // deadline passed
      '2026-10-28 will_update',
      '2026-11-04 edited',
      '2026-11-11 closed',
      '2026-11-18 has_registrations',
    ]);
  });

  it('says nothing about an instance the change would not touch', () => {
    const effects = seriesChangeEffect({
      rule: RULE,
      courts: OLD_COURTS,
      instances: [instance('2026-10-28', { status: 'PUBLISHED' })],
      today: TODAY,
      now: NOW,
    });
    expect(effects).toEqual([]);
  });
});

describe('planEndSeries (T-6, AC-HAPPY-10)', () => {
  const base = {
    rule: RULE,
    instances: [...scenario(), instance('2026-11-18', { status: 'DRAFT', edited: true })],
    today: TODAY,
    now: NOW,
  };

  it('deletes unedited drafts and keeps edited drafts and published sessions after the last date', () => {
    const result = planEndSeries({
      ...base,
      lastDate: date('2026-10-31'),
      alsoCancelPublished: false,
    });
    expect(result.recurUntil).toBe('2026-10-31');
    expect(result.isActive).toBe(true);
    expect(brief(result.actions)).toEqual([
      '2026-11-04 keep_off_pattern',
      '2026-11-11 delete',
      '2026-11-18 keep_off_pattern',
    ]);
    expect(result.counts).toEqual({ draftsToDelete: 1, publishedAfter: 1, editedDraftsKept: 1 });
  });

  it('cancels the published sessions after the date when asked, still keeping edited drafts', () => {
    const result = planEndSeries({
      ...base,
      lastDate: date('2026-10-31'),
      alsoCancelPublished: true,
    });
    expect(brief(result.actions)).toEqual([
      '2026-11-04 cancel',
      '2026-11-11 delete',
      '2026-11-18 keep_off_pattern',
    ]);
  });

  it('becomes inactive when the last date is today or earlier', () => {
    const isActive = (lastDate: string): boolean =>
      planEndSeries({ ...base, lastDate: date(lastDate), alsoCancelPublished: false }).isActive;
    expect(isActive('2026-10-19')).toBe(false);
    expect(isActive('2026-10-20')).toBe(false); // today
    expect(isActive('2026-10-21')).toBe(true);
  });

  it('never touches sessions on or before the last date, or closed and started ones after it', () => {
    const result = planEndSeries({
      ...base,
      instances: [
        instance('2026-10-28', { status: 'PUBLISHED' }),
        instance('2026-11-04', { status: 'CANCELLED' }),
        instance('2026-10-20', { status: 'PUBLISHED' }), // started
      ],
      lastDate: date('2026-10-19'),
      alsoCancelPublished: true,
    });
    expect(brief(result.actions)).toEqual(['2026-10-28 cancel']);
  });

  it('refuses a last date before the first session', () => {
    expect(() =>
      planEndSeries({ ...base, lastDate: date('2026-09-01'), alsoCancelPublished: false }),
    ).toThrow();
  });
});
