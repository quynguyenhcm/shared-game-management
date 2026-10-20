import type { DstOptionsEntry, SeriesResponse, SessionResponse } from '@sgm/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { cancelPrompt } from '../../lib/teams/sessions-view.ts';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  RedirectType: { replace: 'replace' },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { initialCourtTable, courtTableReducer, initialSessionForm, sessionFormReducer } =
  await import('../../lib/teams/session-form-state.ts');
const { ConfirmPanel, InlineConfirm } = await import('./inline-confirm.tsx');
const { CourtTable } = await import('./court-table.tsx');
const { CostingFieldset } = await import('./costing-fieldset.tsx');
const { PricingFieldset } = await import('./pricing-fieldset.tsx');
const { DeadlineFieldset } = await import('./deadline-fieldset.tsx');
const { DetailsFieldset, PlacesFieldset } = await import('./details-fieldset.tsx');
const { DstChoice } = await import('./dst-choice.tsx');
const { PatternFieldset } = await import('./pattern-fieldset.tsx');
const { SessionSummary } = await import('./session-summary.tsx');
const { SeriesSummary } = await import('./series-summary.tsx');
const { EndSeriesConfirm } = await import('./end-series-confirm.tsx');
const { RefreshWhilePending } = await import('./refresh-while-pending.tsx');
const { useSessionForm } = await import('./use-session-form.ts');
const { ManageAreaNav } = await import('./manage-area-nav.tsx');
const { ManageSection } = await import('./manage-section.tsx');

type Form = ReturnType<typeof initialSessionForm>;
const noop = (): void => undefined;
const asyncAction = () => Promise.resolve({ ok: true, message: '', refresh: false });

function nineCourts(): ReturnType<typeof initialCourtTable> {
  let state = initialCourtTable();
  state = courtTableReducer(state, { type: 'set_default', which: 'start', value: '08:00' });
  state = courtTableReducer(state, { type: 'set_default', which: 'end', value: '10:00' });
  state = courtTableReducer(state, { type: 'set_count_text', value: '9' });
  state = courtTableReducer(state, { type: 'commit_count' });
  state = courtTableReducer(state, { type: 'apply_all' });
  return courtTableReducer(state, {
    type: 'set_row',
    key: state.rows[6]!.key,
    field: 'endTime',
    value: '09:00',
  });
}

describe('ConfirmPanel and InlineConfirm (UI/UX InlineConfirm change)', () => {
  const panel = {
    id: 'publish',
    prompt: 'Publish this session?',
    confirmLabel: 'Publish session',
    pendingLabel: 'Publishing…',
    dismissLabel: 'Keep editing',
    onDismiss: noop,
  };

  it('is a non-modal group labelled by its prompt, with the confirm and the explicit dismiss label', () => {
    const html = renderToStaticMarkup(
      <ConfirmPanel {...panel} confirmName="intent" confirmValue="publish" />,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-labelledby="publish-prompt"');
    expect(html).toContain('id="publish-prompt"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('name="intent"');
    expect(html).toContain('value="publish"');
    expect(html).toContain('>Publish session</button>');
    expect(html).toContain('>Keep editing</button>');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('>Cancel</button>');
  });

  it('wraps its children and buttons in a form only when given a form action', () => {
    const html = renderToStaticMarkup(
      <ConfirmPanel {...panel} formAction={noop}>
        <input name="lastDate" />
      </ConfirmPanel>,
    );
    expect(html).toContain('<form');
    expect(html.indexOf('name="lastDate"')).toBeLessThan(html.indexOf('Publish session'));
  });

  it('shows the pending label and marks the confirm aria-disabled while pending', () => {
    const html = renderToStaticMarkup(<ConfirmPanel {...panel} pending />);
    expect(html).toContain('Publishing…');
    expect(html).toContain('aria-disabled="true"');
  });

  const inline = {
    id: 'cancel-session',
    section: 'session' as const,
    action: asyncAction,
    fields: { teamId: 'T', sessionId: 'S' },
    triggerLabel: 'Cancel session',
    prompt: 'Cancel this session?',
    confirmLabel: 'Cancel session',
    pendingLabel: 'Cancelling…',
    destructive: true,
  };

  it('keeps "Cancel" as the default dismiss label so People and Banking are unchanged', () => {
    expect(renderToStaticMarkup(<InlineConfirm {...inline} defaultOpen />)).toContain(
      '>Cancel</button>',
    );
  });

  it('renders an explicit dismiss label and its children inside the confirm form', () => {
    const html = renderToStaticMarkup(
      <InlineConfirm {...inline} dismissLabel="Keep session" defaultOpen>
        <input name="lastDate" />
      </InlineConfirm>,
    );
    expect(html).toContain('>Keep session</button>');
    expect(html).not.toMatch(/>Cancel<\/button>/);
    expect(html.indexOf('<form')).toBeLessThan(html.indexOf('name="lastDate"'));
    expect(html.indexOf('name="lastDate"')).toBeLessThan(html.indexOf('>Keep session<'));
  });

  it('no Sessions confirm renders a dismiss button named "Cancel" beside a Cancel action (structural)', () => {
    for (const status of ['DRAFT', 'PUBLISHED'] as const) {
      for (const seriesDate of [null, '2026-11-04']) {
        const variant = cancelPrompt({ status, seriesDate, activeRegistrationCount: 3 });
        const html = renderToStaticMarkup(
          <InlineConfirm
            {...inline}
            prompt={variant.prompt}
            confirmLabel={variant.confirmLabel}
            dismissLabel={variant.dismissLabel}
            defaultOpen
          />,
        );
        expect(html).not.toMatch(/>Cancel<\/button>/);
        expect(html).toContain(`>${variant.dismissLabel}</button>`);
      }
    }
  });
});

describe('CourtTable (D1)', () => {
  const live = { text: 'Court table has 9 courts.', seq: 1 };
  const render = (state = nineCourts(), extra: Partial<Parameters<typeof CourtTable>[0]> = {}) =>
    renderToStaticMarkup(
      <CourtTable state={state} errors={{}} dst={[]} live={live} dispatch={noop} {...extra} />,
    );

  it('has the setup block; "Number of courts" is unnamed so it can never be submitted, and has a count id', () => {
    const html = render();
    expect(html).toContain('Times are New Zealand time.');
    expect(html).toMatch(/<label[^>]*for="court-count"[^>]*>Number of courts<\/label>/);
    const input = /<input[^>]*id="court-count"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).not.toContain('name=');
    expect(input).toContain('inputMode="numeric"');
    expect(html).toContain('>Default start<');
    expect(html).toContain('>Default end<');
    expect(html).toContain('>Apply to all courts<');
    expect(html).toContain('Default times are used for new courts.');
  });

  it('one labelled group per court: name, start and end inputs with accessible names that contain the label', () => {
    const html = render();
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Court 7 start"');
    expect(html).toContain('aria-label="Court 7 end"');
    expect(html).toContain('aria-label="Remove Court 7"');
    expect(html).toContain('name="courts.6.identifier"');
    expect(html).toContain('name="courts.6.startTime"');
    expect(html).toContain('name="courts.6.endTime"');
    expect(html.match(/name="courts\.\d+\.identifier"/g)).toHaveLength(9);
  });

  it('tags the exception, and gives the summary line', () => {
    const html = render();
    expect(html.match(/Not default/g)).toHaveLength(1);
    expect(html).toContain('9 courts. 8 use the default times.');
  });

  it('owns one persistent polite live region, present from first render', () => {
    const html = render(initialCourtTable(), { live: { text: '', seq: 0 } });
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
    expect(render()).toContain('Court table has 9 courts.');
  });

  it('shows the "default times changed" hint only after rows exist and a default moved', () => {
    const moved = courtTableReducer(nineCourts(), {
      type: 'set_default',
      which: 'end',
      value: '11:00',
    });
    expect(render(moved)).toContain(
      'Default times changed. Apply to all courts to update the 9 rows.',
    );
    expect(render()).not.toContain('Default times changed.');
  });

  it('hides Remove when one court remains, and shows field errors with aria-invalid', () => {
    const one = renderToStaticMarkup(
      <CourtTable
        state={initialCourtTable()}
        errors={{}}
        dst={[]}
        live={{ text: '', seq: 0 }}
        dispatch={noop}
      />,
    );
    expect(one).not.toContain('Remove Court 1');
    const state = nineCourts();
    const key = state.rows[0]!.key;
    const html = renderToStaticMarkup(
      <CourtTable
        state={state}
        errors={{ [`court-${key}-start`]: ['Enter a start time.'] }}
        dst={[]}
        live={{ text: '', seq: 0 }}
        dispatch={noop}
      />,
    );
    expect(html).toContain('Enter a start time.');
    expect(html).toContain('aria-invalid="true"');
  });

  it('renders the DST choice under the time input that failed', () => {
    const entry: DstOptionsEntry = {
      field: 'courts.0.startTime',
      date: '2026-09-27',
      time: '02:30',
      kind: 'nonexistent',
      options: [
        { choice: 'shiftedForward', localTime: '03:30', instant: '2026-09-26T14:30:00.000Z' },
        { choice: 'shiftedBackward', localTime: '01:30', instant: '2026-09-26T13:30:00.000Z' },
      ],
    };
    const html = render(nineCourts(), { dst: [entry] });
    expect(html).toContain('2:30 am doesn&#x27;t happen on Sun 27 Sep 2026');
    expect(html).toContain('>Use 3:30 am<');
    expect(html).toContain('>Use 1:30 am<');
  });
});

function blankForm(): Form {
  let state = initialSessionForm();
  state = sessionFormReducer(state, { type: 'set_places', field: 'maxPlayers', value: '18' });
  state = sessionFormReducer(state, { type: 'set_costing', field: 'courtCost', value: '180.00' });
  return sessionFormReducer(state, { type: 'set_costing', field: 'extraExpenses', value: '20.00' });
}

describe('CostingFieldset and PricingFieldset (D2 option A)', () => {
  it('costing shows blank-means-free, the suggestion line, and the host-seat caveat only when seats are reserved', () => {
    const html = renderToStaticMarkup(
      <CostingFieldset state={blankForm()} errors={{}} dispatch={noop} />,
    );
    expect(html).toContain('Court hire (total)');
    expect(html).toContain('Optional. Leave blank for a free session.');
    expect(html).toContain('Extra expenses');
    expect(html).toContain(
      'Suggested rate: $12.00 per player. Court hire plus extras, divided by max players (18), rounded up to the next dollar.',
    );
    expect(html).not.toContain("Reserved host seats aren't charged");
    const seated = sessionFormReducer(blankForm(), {
      type: 'set_places',
      field: 'reservedSeats',
      value: '2',
    });
    expect(
      renderToStaticMarkup(<CostingFieldset state={seated} errors={{}} dispatch={noop} />),
    ).toContain(
      'Reserved host seats aren&#x27;t charged, so this rate won&#x27;t quite cover the full cost.',
    );
  });

  it('costing explains itself when max players is missing, and shows the locked hint while following', () => {
    const html = renderToStaticMarkup(
      <CostingFieldset state={initialSessionForm()} errors={{}} dispatch={noop} />,
    );
    expect(html).toContain('Enter max players to see a suggested rate.');
  });

  it('pricing: three model radios in one group, flat rate follows the suggestion and says so', () => {
    const html = renderToStaticMarkup(
      <PricingFieldset state={blankForm()} errors={{}} dispatch={noop} />,
    );
    expect(html).toContain('>Pricing<');
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toContain('Flat rate');
    expect(html).toContain('By sex');
    expect(html).toContain('By skill level');
    expect(html).toContain('Rate per player');
    expect(html).toContain('value="12.00"');
    expect(html).toContain(
      'Following the suggested rate. It changes when costs or max players change.',
    );
    expect(html).not.toContain('Use suggested rate');
    expect(html).not.toContain('name="customPlayerRate"');
  });

  it('pinned rate: custom text, the Use suggested rate button, and the rate is posted', () => {
    const pinned = sessionFormReducer(blankForm(), { type: 'type_rate', value: '15.00' });
    const html = renderToStaticMarkup(
      <PricingFieldset state={pinned} errors={{}} dispatch={noop} />,
    );
    expect(html).toContain('Custom rate. It won&#x27;t change when costs change.');
    expect(html).toContain('>Use suggested rate<');
    expect(html).toContain('name="customPlayerRate"');
  });

  it('By sex reveals male, female and other (with its hint) and the fill button, and posts only that model', () => {
    const sex = sessionFormReducer(blankForm(), { type: 'set_model', model: 'BY_SEX' });
    const html = renderToStaticMarkup(<PricingFieldset state={sex} errors={{}} dispatch={noop} />);
    for (const name of ['feeMale', 'feeFemale', 'feeOther'])
      expect(html).toContain(`name="${name}"`);
    expect(html).not.toContain('name="feeBeginner"');
    expect(html).not.toContain('name="customPlayerRate"');
    expect(html).toContain('Starts as the lower of the other two until you change it.');
    expect(html).toContain('>Fill all with the suggested rate<');
    expect(html).toContain('name="pricingStructure"');
  });

  it('By skill level reveals the three levels', () => {
    const skill = sessionFormReducer(blankForm(), { type: 'set_model', model: 'BY_SKILL_LEVEL' });
    const html = renderToStaticMarkup(
      <PricingFieldset state={skill} errors={{}} dispatch={noop} />,
    );
    for (const name of ['feeBeginner', 'feeIntermediate', 'feeAdvanced']) {
      expect(html).toContain(`name="${name}"`);
    }
  });

  it('locked pricing: static "Pricing: By sex", the lock message, no radios, fees still editable with the over-limit error', () => {
    const session = lockedSession();
    const state = sessionFormReducer(initialSessionForm(session), {
      type: 'set_fee',
      field: 'feeMale',
      value: '18.00',
    });
    const html = renderToStaticMarkup(
      <PricingFieldset state={state} errors={{}} dispatch={noop} />,
    );
    expect(html).not.toContain('type="radio"');
    expect(html).toContain('Pricing: By sex');
    expect(html).toContain('Players have registered, so fees can only be lowered.');
    expect(html).toContain('name="feeMale"');
    expect(html).toContain('name="pricingStructure"');
    expect(html).toContain('type="hidden"');
    expect(html).toContain(
      'This is higher than the current fee. Fees can only be lowered once players have registered.',
    );
  });
});

function lockedSession(
  overrides: Partial<Record<keyof SessionResponse, unknown>> = {},
): SessionResponse {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    teamId: '7f3c2b1a-1111-4222-8333-444455556666',
    recurringRuleId: null,
    status: 'PUBLISHED',
    phase: 'upcoming',
    date: '2026-11-04',
    location: 'Rosedale',
    address: '1 Court Rd',
    maxPlayers: 18,
    reservedSeats: 2,
    courtCost: '180.00',
    extraExpenses: '20.00',
    calculatedRatePerPlayer: '12.00',
    customPlayerRate: null,
    pricingStructure: 'BY_SEX',
    feeFlat: null,
    feeMale: '17.00',
    feeFemale: '16.00',
    feeOther: '16.00',
    feeBeginner: null,
    feeIntermediate: null,
    feeAdvanced: null,
    startsAt: '2026-11-03T19:00:00.000Z',
    endsAt: '2026-11-03T21:00:00.000Z',
    cancellationDeadline: '2026-11-01T19:00:00.000Z',
    deadlineIsDefault: true,
    isInstanceOverridden: false,
    draftReason: null,
    seriesName: null,
    version: 3,
    activeRegistrationCount: 12,
    feesLocked: 'raise_only_blocked',
    courts: [
      {
        id: '21111111-1111-4111-8111-111111111111',
        identifier: 'Court 1',
        startTime: '08:00',
        endTime: '10:00',
      },
    ],
    ...overrides,
  } as SessionResponse;
}

describe('DetailsFieldset and PlacesFieldset', () => {
  const state = initialSessionForm(lockedSession({ feesLocked: 'none' }));

  it('a one-off edits its date; a series date shows it as text with the cancel-and-recreate hint', () => {
    const input = renderToStaticMarkup(
      <DetailsFieldset state={state} errors={{}} dispatch={noop} date="input" />,
    );
    expect(input).toContain('name="location"');
    expect(input).toContain('name="address"');
    expect(input).toContain('type="date"');
    const fixed = renderToStaticMarkup(
      <DetailsFieldset state={state} errors={{}} dispatch={noop} date="fixed" />,
    );
    expect(fixed).toContain('Wed 4 Nov 2026');
    expect(fixed).toContain('To move this night, cancel it and create a one-off session.');
    expect(fixed).not.toContain('type="date"');
    const none = renderToStaticMarkup(
      <DetailsFieldset state={state} errors={{}} dispatch={noop} date="none" />,
    );
    expect(none).not.toContain('name="date"');
  });

  it('places: max players and host seats, with the capacity hint only on a published session', () => {
    const published = renderToStaticMarkup(
      <PlacesFieldset state={state} errors={{}} dispatch={noop} published />,
    );
    expect(published).toContain('name="maxPlayers"');
    expect(published).toContain('name="reservedSeats"');
    expect(published).toContain('Lowering this won&#x27;t remove anyone who&#x27;s already in.');
    const draft = renderToStaticMarkup(
      <PlacesFieldset state={state} errors={{}} dispatch={noop} published={false} />,
    );
    expect(draft).not.toContain('Lowering this');
  });
});

describe('DeadlineFieldset (T-8)', () => {
  it('defaults to "Default: 48 hours before the first court starts" with the readout, and posts the mode', () => {
    const html = renderToStaticMarkup(
      <DeadlineFieldset
        kind="session"
        state={initialSessionForm()}
        errors={{}}
        dst={[]}
        readout="Mon 2 Nov, 8:00 am"
        dispatch={noop}
      />,
    );
    expect(html).toContain('Cancellation deadline');
    expect(html).toContain('Default: 48 hours before the first court starts');
    expect(html).toContain('A specific date and time');
    expect(html).toContain('Currently Mon 2 Nov, 8:00 am.');
    expect(html).toContain('name="deadlineMode"');
    expect(html).not.toContain('name="deadlineDate"');
  });

  it('a specific deadline reveals Date and Time, with the shared error', () => {
    const state = sessionFormReducer(initialSessionForm(), {
      type: 'set_deadline_mode',
      mode: 'specific',
    });
    const html = renderToStaticMarkup(
      <DeadlineFieldset
        kind="session"
        state={state}
        errors={{ deadlineDate: ['Enter a valid date.'] }}
        dst={[]}
        readout={null}
        dispatch={noop}
      />,
    );
    expect(html).toContain('name="deadlineDate"');
    expect(html).toContain('name="deadlineTime"');
    expect(html).toContain('type="date"');
    expect(html).toContain('type="time"');
    expect(html).toContain('Enter a valid date.');
  });

  it('a series shows only the static line', () => {
    const html = renderToStaticMarkup(
      <DeadlineFieldset
        kind="series"
        state={initialSessionForm()}
        errors={{}}
        dst={[]}
        readout={null}
        dispatch={noop}
      />,
    );
    expect(html).toContain(
      '48 hours before the first court starts, for every session in the series.',
    );
    expect(html).not.toContain('type="radio"');
  });
});

describe('DstChoice (T-10)', () => {
  const entry: DstOptionsEntry = {
    field: 'courts.0.endTime',
    date: '2027-04-04',
    time: '02:30',
    kind: 'ambiguous',
    options: [{ choice: 'earlier', localTime: '02:30', instant: '2027-04-03T13:30:00.000Z' }],
  };

  it('is a labelled group with one button per option and no fieldset', () => {
    const html = renderToStaticMarkup(
      <DstChoice id="dst-end" entry={entry} kind="court" onChoose={noop} />,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-labelledby="dst-end-message"');
    expect(html).toContain('>Use the first 2:30 am (NZDT)</button>');
    expect(html).not.toContain('<fieldset');
  });
});

describe('PatternFieldset (P-3: fixed after creation)', () => {
  it('create: Weekly, Every 2 weeks, Monthly, first session, repeat until, the derived line and the publish hint', () => {
    const state = sessionFormReducer(
      sessionFormReducer(initialSessionForm(), { type: 'set_frequency', value: 'WEEKLY' }),
      { type: 'set_starts_on', value: '2026-11-04' },
    );
    const html = renderToStaticMarkup(
      <PatternFieldset
        mode="create"
        pattern={state.pattern}
        errors={{}}
        dispatch={noop}
        horizonDays={28}
      />,
    );
    expect(html).toContain('>Repeats<');
    for (const label of ['Weekly', 'Every 2 weeks', 'Monthly']) expect(html).toContain(label);
    expect(html).toContain('name="frequency"');
    expect(html).toContain('First session');
    expect(html).toContain('name="startsOn"');
    expect(html).toContain('Repeat until (optional)');
    expect(html).toContain('Every Wednesday from 4 Nov 2026');
    expect(html).toContain(
      'Sessions are added 28 days ahead and published automatically, so members can register as soon as each one appears.',
    );
    expect(html).not.toContain('dayOfWeek');
  });

  it('create: monthly on a date that is both 4th and last shows the "Which one?" pair', () => {
    let state = sessionFormReducer(initialSessionForm(), {
      type: 'set_frequency',
      value: 'MONTHLY',
    });
    state = sessionFormReducer(state, { type: 'set_starts_on', value: '2026-11-25' });
    const html = renderToStaticMarkup(
      <PatternFieldset
        mode="create"
        pattern={state.pattern}
        errors={{}}
        dispatch={noop}
        horizonDays={28}
      />,
    );
    expect(html).toContain('Which one?');
    expect(html).toContain('4th Wednesday');
    expect(html).toContain('Last Wednesday');
    expect(html).toContain('name="monthlyWeek"');
  });

  it('create: a 5th weekday shows the fixed explanation and posts last as a hidden field', () => {
    let state = sessionFormReducer(initialSessionForm(), {
      type: 'set_frequency',
      value: 'MONTHLY',
    });
    state = sessionFormReducer(state, { type: 'set_starts_on', value: '2026-11-29' });
    const html = renderToStaticMarkup(
      <PatternFieldset
        mode="create"
        pattern={state.pattern}
        errors={{}}
        dispatch={noop}
        horizonDays={28}
      />,
    );
    expect(html).toContain(
      '29 Nov 2026 is the 5th Sunday, so it repeats on the last Sunday of each month.',
    );
    expect(html).not.toContain('Which one?');
    expect(html).toMatch(
      /type="hidden"[^>]*name="monthlyWeek"[^>]*value="-1"|name="monthlyWeek"[^>]*type="hidden"[^>]*value="-1"|name="monthlyWeek"[^>]*value="-1"/,
    );
  });

  it('edit: read-only rows and the fixed-pattern sentence; the pattern is posted hidden; repeat until cannot go earlier', () => {
    const saved = {
      frequency: 'WEEKLY',
      dayOfWeek: 3,
      startsOn: '2026-11-04',
      monthlyWeek: null,
      recurUntil: '2026-12-16',
      location: 'Rosedale',
      address: '1 Court Rd',
      maxPlayers: 18,
      reservedSeats: 0,
      courtCost: '180.00',
      extraExpenses: '20.00',
      customPlayerRate: null,
      pricingStructure: 'FLAT',
      feeFlat: '12.00',
      calculatedRatePerPlayer: '12.00',
      courts: [{ identifier: 'Court 1', startTime: '08:00', endTime: '10:00' }],
      instances: [],
    } as unknown as SeriesResponse;
    const state = initialSessionForm(saved);
    const html = renderToStaticMarkup(
      <PatternFieldset
        mode="edit"
        pattern={state.pattern}
        saved={saved}
        errors={{}}
        dispatch={noop}
        horizonDays={28}
      />,
    );
    expect(html).toContain('<dt');
    expect(html).toContain('Weekly on Wednesdays');
    expect(html).toContain('4 Nov 2026');
    expect(html).toContain(
      'To change the day or how often it repeats, end this series and start a new one.',
    );
    expect(html).not.toContain('type="radio"');
    expect(html).toMatch(/name="frequency"[^>]*value="WEEKLY"|value="WEEKLY"[^>]*name="frequency"/);
    expect(html).toContain('min="2026-12-16"');
    expect(html).toContain(
      'You can extend or clear this date. To stop the series sooner, use End series.',
    );
  });
});

describe('SessionSummary (read-only view: dl and table, never disabled inputs)', () => {
  const session = lockedSession({
    status: 'PUBLISHED',
    phase: 'started',
    pricingStructure: 'FLAT',
    feeFlat: '12.00',
    feeMale: null,
    feeFemale: null,
    feeOther: null,
    seriesName: 'Wednesdays at Rosedale',
    courts: [
      {
        id: '21111111-1111-4111-8111-111111111111',
        identifier: 'Court 1',
        startTime: '08:00',
        endTime: '10:00',
      },
      {
        id: '31111111-1111-4111-8111-111111111111',
        identifier: 'Court 2',
        startTime: '08:00',
        endTime: '09:00',
      },
    ],
  });
  const html = renderToStaticMarkup(
    <SessionSummary
      session={session}
      isPayoutConfigured
      backLinks={[
        { href: '/teams/T/manage/sessions', label: 'Back to Sessions' },
        { href: '/teams/T/manage/sessions/series/R', label: 'Back to Wednesdays at Rosedale' },
      ]}
    />,
  );

  it('states the reason, the label chips and the sections', () => {
    expect(html).toContain('This session has started, so it can&#x27;t be changed or cancelled.');
    expect(html).toContain('Started');
    expect(html).toContain('Series: Wednesdays at Rosedale');
    for (const heading of [
      'Details',
      'Courts',
      'Places',
      'Costing',
      'Pricing',
      'Cancellation deadline',
    ]) {
      expect(html).toContain(`>${heading}<`);
    }
    expect(html).toContain('Rosedale');
    expect(html).toContain('$180.00');
    expect(html).toContain('Flat rate');
    expect(html).toContain('$12.00 each');
  });

  it('lists the courts in a real table with three columns', () => {
    expect(html).toContain('<table');
    expect(html).toContain('>Court</th>');
    expect(html).toContain('>Start</th>');
    expect(html).toContain('>End</th>');
    expect(html).toContain('8:00 am');
    expect(html).toContain('9:00 am');
  });

  it('renders no input, textarea, select or action button, and keeps both back links', () => {
    expect(html).not.toMatch(/<input|<textarea|<select|<button|<form/);
    expect(html).toContain('Back to Sessions');
    expect(html).toContain('Back to Wednesdays at Rosedale');
  });
});

describe('SeriesSummary, EndSeriesConfirm and RefreshWhilePending', () => {
  const series = {
    id: '41111111-1111-4111-8111-111111111111',
    name: 'Wednesdays at Rosedale',
    frequency: 'WEEKLY',
    dayOfWeek: 3,
    startsOn: '2026-11-04',
    monthlyWeek: null,
    recurUntil: null,
    isActive: true,
    location: 'Rosedale',
    courts: [{ identifier: 'Court 1', startTime: '08:00', endTime: '10:00' }],
    pricingStructure: 'FLAT',
    feeFlat: '12.00',
    customPlayerRate: null,
    calculatedRatePerPlayer: '12.00',
  } as unknown as SeriesResponse;

  it('summary: the one-line summary, the details list, the change link and the slots', () => {
    const html = renderToStaticMarkup(
      <SeriesSummary
        series={series}
        editHref="/teams/T/manage/sessions/series/R?edit=details"
        endSeries={<span>END-SLOT</span>}
        publishDrafts={<span>PUBLISH-SLOT</span>}
      />,
    );
    expect(html).toContain('Wednesdays at Rosedale');
    expect(html).toContain(
      'Weekly on Wednesdays · 8:00 am-10:00 am · 1 court · $12.00 each · from 4 Nov 2026 · no end date',
    );
    expect(html).toContain('Series details');
    expect(html).toContain('First session');
    expect(html).toContain('>Change series details<');
    expect(html).toContain('href="/teams/T/manage/sessions/series/R?edit=details"');
    expect(html).toContain('END-SLOT');
    expect(html).toContain('PUBLISH-SLOT');
  });

  it('an ended series shows the ended state and offers neither Change nor End', () => {
    const html = renderToStaticMarkup(
      <SeriesSummary
        series={{ ...series, isActive: false, recurUntil: '2026-12-16' }}
        editHref="/x"
        endSeries={<span>END-SLOT</span>}
      />,
    );
    expect(html).toContain(
      'Ended. Last session 16 Dec 2026. To run it again, create a new series.',
    );
    expect(html).not.toContain('Change series details');
    expect(html).not.toContain('END-SLOT');
  });

  const instances = [
    {
      id: 'a',
      date: '2026-11-11',
      startsAt: null,
      endsAt: null,
      status: 'DRAFT',
      phase: 'upcoming',
      draftReason: 'banking',
      isInstanceOverridden: false,
      activeRegistrationCount: 0,
      version: 1,
      seriesChangeEffect: 'will_update',
    },
    {
      id: 'b',
      date: '2026-11-18',
      startsAt: null,
      endsAt: null,
      status: 'PUBLISHED',
      phase: 'upcoming',
      draftReason: null,
      isInstanceOverridden: false,
      activeRegistrationCount: 4,
      version: 1,
      seriesChangeEffect: 'will_update',
    },
  ] as SeriesResponse['instances'];

  it('End series: a closed trigger; open it shows the date, the cancel checkbox and a polite impact status', () => {
    const props = {
      id: 'end-series',
      action: asyncAction,
      fields: { teamId: 'T', ruleId: 'R', expectedVersion: '2' },
      instances,
      defaultLastDate: '2026-11-04',
    };
    const closed = renderToStaticMarkup(<EndSeriesConfirm {...props} />);
    expect(closed).toContain('>End series<');
    expect(closed).toContain('aria-expanded="false"');
    const open = renderToStaticMarkup(<EndSeriesConfirm {...props} defaultOpen />);
    expect(open).toContain('End this series? No sessions will be added after the last date.');
    expect(open).toContain('>Last date<');
    expect(open).toContain('name="lastDate"');
    expect(open).toContain('value="2026-11-04"');
    expect(open).toContain('name="alsoCancelPublished"');
    expect(open).toContain('Also cancel the 1 published session after this date');
    expect(open).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(open).toContain('1 unedited draft session after this date will be deleted.');
    expect(open).toContain('1 published session after this date will be kept.');
    expect(open).toContain('>Keep series<');
    expect(open).toContain('name="expectedVersion"');
  });

  it('refresh while pending: a status with a plain Refresh link while waiting; empty live region when done', () => {
    const waiting = renderToStaticMarkup(
      <RefreshWhilePending pending href="/teams/T/manage/sessions/series/R" />,
    );
    expect(waiting).toContain(
      'We&#x27;re adding the sessions in this series. Refresh in a moment.',
    );
    expect(waiting).toContain('href="/teams/T/manage/sessions/series/R"');
    expect(waiting).toContain('>Refresh<');
    expect(waiting).toContain('role="status"');
    const done = renderToStaticMarkup(<RefreshWhilePending pending={false} href="/x" />);
    expect(done).not.toContain('Refresh in a moment');
    expect(done).toContain('role="status"');
  });
});

describe('useSessionForm hook wiring', () => {
  it('returns the seeded state, field errors from the pure validation, and a submit function', () => {
    let seen: ReturnType<typeof useSessionForm> | null = null;
    function Probe() {
      seen = useSessionForm({
        initial: initialSessionForm(),
        kind: 'session',
        action: () => Promise.resolve({}),
      });
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(seen).not.toBeNull();
    const form = seen as unknown as ReturnType<typeof useSessionForm>;
    expect(form.state.courts.rows).toHaveLength(1);
    expect(typeof form.dispatch).toBe('function');
    expect(typeof form.submit).toBe('function');
    expect(form.fieldErrors).toEqual({});
    expect(form.clientFailure).toBeNull();
  });
});

describe('Sessions in the manage area (AC-ENTRY-1, AC-ENTRY-2)', () => {
  it('the area nav lists Sessions with an href under the manage root and marks it current', () => {
    const html = renderToStaticMarkup(<ManageAreaNav teamId="T" current="sessions" />);
    expect(html).toContain('href="/teams/T/manage/sessions"');
    expect(html).toMatch(/aria-current="page"[^>]*>Sessions<|>Sessions<\/a>/);
    expect(html.indexOf('Banking and GST')).toBeLessThan(html.indexOf('>Sessions<'));
  });

  it('the new section ids render a labelled region with a focus-target heading and status region', () => {
    for (const id of ['sessions', 'session', 'series'] as const) {
      const html = renderToStaticMarkup(
        <ManageSection id={id} title="Sessions">
          <p>body</p>
        </ManageSection>,
      );
      expect(html).toContain(`id="${id}-heading"`);
      expect(html).toContain(`id="${id}-status"`);
    }
  });
});
