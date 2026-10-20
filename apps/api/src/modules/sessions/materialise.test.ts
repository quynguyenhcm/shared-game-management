/**
 * Pure parts of the series materialiser (session-scheduling-engine Phase 3): the NZ date window, the failure verdict that
 * decides retry or permanent failure (AC-ERROR-9), the rule job's payload, key and enqueue helper, the rule-to-template
 * mapping and the weekly banking notice. The transactional behaviour is in `sessions-job.int.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { toMoneyString } from '@sgm/shared';
import { classifySessionError } from './errors.ts';
import { buildPayoutMissingEmail } from './emails.ts';
import { failureVerdict, materialisationWindow } from './materialise.ts';
import {
  RECURRENCE_RULE_TRIGGERS,
  RecurrenceRulePayload,
  enqueueRuleMaterialisation,
  recurrenceRuleKey,
} from './rule-jobs.ts';
import { recurrenceRuleOf, templateOf } from './rule-template.ts';
import type { LockedRule } from './locks.ts';

const RULE = '0b6f0a5e-5d0b-4a52-9d52-0d9a0f0b1c11';
const TEAM = '3b241101-e2bb-4255-8caf-4136c566a962';

describe('materialisationWindow (AC-ASYNC-1)', () => {
  it('runs from the NZ date of the run to that date plus the horizon, both inclusive', () => {
    // 2026-10-19 11:30Z is 00:30 on 2026-10-20 in NZDT (+13).
    expect(materialisationWindow(new Date('2026-10-19T11:30:00Z'), 28)).toEqual({
      from: '2026-10-20',
      to: '2026-11-17',
    });
  });

  it('takes the date from NZ time, not UTC, on both sides of local midnight', () => {
    expect(materialisationWindow(new Date('2026-10-20T10:59:00Z'), 7).from).toBe('2026-10-20');
    expect(materialisationWindow(new Date('2026-10-20T11:00:00Z'), 7).from).toBe('2026-10-21');
  });

  it('counts calendar days across the DST change', () => {
    // 2026-09-27 is the spring-forward day: the window is days, not 24-hour blocks.
    expect(materialisationWindow(new Date('2026-09-24T12:00:00Z'), 7)).toEqual({
      from: '2026-09-25',
      to: '2026-10-02',
    });
  });
});

describe('failureVerdict (AC-ERROR-9)', () => {
  const failure = (code: string | undefined) =>
    classifySessionError(Object.assign(new Error('boom'), code === undefined ? {} : { code }));

  it('does nothing when no instance failed', () => {
    expect(failureVerdict([])).toBe('none');
  });

  it('retries when any failure was transient: lock timeout, deadlock, serialisation, connection or unknown', () => {
    for (const code of ['55P03', '40P01', '40001', '08006', undefined]) {
      expect(failureVerdict([failure(code)]), String(code)).toBe('retry');
    }
  });

  it('fails permanently only when every failure was a constraint or data error', () => {
    expect(failureVerdict([failure('23514'), failure('22007')])).toBe('permanent');
    expect(failureVerdict([failure('23514'), failure('55P03')])).toBe('retry');
  });
});

describe('recurrence-rule payload, key and enqueue helper (T-3)', () => {
  it('is strict: a rule id, a team id and one of the five triggers', () => {
    for (const trigger of RECURRENCE_RULE_TRIGGERS) {
      expect(RecurrenceRulePayload.safeParse({ ruleId: RULE, teamId: TEAM, trigger }).success).toBe(
        true,
      );
    }
    expect([...RECURRENCE_RULE_TRIGGERS]).toEqual([
      'sweep',
      'rule_created',
      'rule_updated',
      'rule_ended',
      'manual',
    ]);
    expect(RecurrenceRulePayload.safeParse({ ruleId: RULE, teamId: TEAM }).success).toBe(false);
    expect(
      RecurrenceRulePayload.safeParse({ ruleId: RULE, teamId: TEAM, trigger: 'manual', x: 1 })
        .success,
    ).toBe(false);
    expect(
      RecurrenceRulePayload.safeParse({ ruleId: 'nope', teamId: TEAM, trigger: 'manual' }).success,
    ).toBe(false);
  });

  it('queues the rule job under its singleton key and on the caller transaction when given one', async () => {
    const enqueue = vi.fn().mockResolvedValue('job-1');
    const trx = { executeQuery: vi.fn() };
    const input = { ruleId: RULE, teamId: TEAM, trigger: 'rule_created' } as const;

    await expect(enqueueRuleMaterialisation({ enqueue }, input, { trx })).resolves.toBe('job-1');
    expect(enqueue).toHaveBeenCalledWith('recurrence-rule', input, {
      singletonKey: `recurrence-rule:${RULE}`,
      trx,
    });
    expect(recurrenceRuleKey(RULE)).toBe(`recurrence-rule:${RULE}`);

    enqueue.mockClear();
    await enqueueRuleMaterialisation({ enqueue }, input);
    expect(enqueue).toHaveBeenCalledWith('recurrence-rule', input, {
      singletonKey: `recurrence-rule:${RULE}`,
    });
  });
});

describe('rule row to template mapping', () => {
  const row = {
    frequency: 'WEEKLY',
    day_of_week: 3,
    starts_on: '2026-10-07',
    monthly_week: null,
    recur_until: null,
    pricing_structure: 'FLAT',
    fee_flat: '17.00',
    fee_male: null,
    fee_female: null,
    fee_other: null,
    fee_beginner: null,
    fee_intermediate: null,
    fee_advanced: null,
    default_location: 'Hall',
    default_address: '1 Test St',
    default_max_players: 12,
    default_reserved_seats: 2,
    default_total_court_cost: null,
    default_extra_expenses: '4.50',
    default_custom_player_rate: null,
  } as unknown as LockedRule;

  it('maps the pattern and keeps an unset rate as "follow the suggestion"', () => {
    expect(recurrenceRuleOf(row)).toEqual({
      frequency: 'WEEKLY',
      dayOfWeek: 3,
      startsOn: '2026-10-07',
      monthlyWeek: null,
      recurUntil: null,
    });
    const template = templateOf(row);
    expect(template.customPlayerRate).toBeNull();
    expect(toMoneyString(template.courtCost)).toBe('0.00');
    expect(toMoneyString(template.extraExpenses)).toBe('4.50');
    expect(template).toMatchObject({ maxPlayers: 12, reservedSeats: 2, location: 'Hall' });
  });
});

describe('payout-missing email (AC-ASYNC-3)', () => {
  const email = buildPayoutMissingEmail({
    to: 'admin@example.test',
    recipientId: 'u-1',
    teamId: TEAM,
    teamName: 'Tuesday\nSmash Club',
    ruleId: RULE,
    windowStart: '2026-10-19',
    webBaseUrl: 'https://app.example.test',
  });

  it('names the team on one line and links to banking and the series page', () => {
    expect(email.subject).toBe(
      'Sessions not published for Tuesday Smash Club: bank account needed',
    );
    expect(email.to).toBe('admin@example.test');
    expect(email.text).toContain(`https://app.example.test/teams/${TEAM}/manage/banking`);
    expect(email.text).toContain(
      `https://app.example.test/teams/${TEAM}/manage/sessions/series/${RULE}`,
    );
  });

  it('carries no amounts and is keyed by rule, week and recipient so every admin gets one', () => {
    expect(email.text).not.toMatch(/\$|\d+\.\d{2}/);
    expect(email.idempotencyKey).toBe(`payout-missing:${RULE}:2026-10-19:u-1`);
  });
});
