import { describe, expect, it } from 'vitest';
import { initialManageState, manageReducer } from './manage-state.ts';

describe('manageReducer (per-section status regions and one open confirm per section)', () => {
  it('starts with empty status regions and nothing open', () => {
    const state = initialManageState();
    const none = {
      requests: null,
      members: null,
      invite: null,
      banned: null,
      banking: null,
      gst: null,
    };
    expect(state.status).toEqual(none);
    expect(state.open).toEqual(none);
  });

  it('the banking and gst sections have their own status region and confirm, independent of People', () => {
    let state = manageReducer(initialManageState(), {
      type: 'open',
      section: 'banking',
      id: 'remove-banking',
    });
    state = manageReducer(state, { type: 'open', section: 'members', id: 'ban-a' });
    expect(state.open.banking).toBe('remove-banking');
    expect(state.open.members).toBe('ban-a');
    state = manageReducer(state, {
      type: 'result',
      section: 'gst',
      message: 'GST settings saved.',
      ok: true,
    });
    expect(state.status.gst).toEqual({ message: 'GST settings saved.', ok: true });
    expect(state.status.banking).toBeNull();
    expect(state.open.banking).toBe('remove-banking');
  });

  it('a terminal failure (close: true, e.g. banking_in_use) closes the confirm and still shows the error; a plain failure keeps it open', () => {
    const open = manageReducer(initialManageState(), {
      type: 'open',
      section: 'banking',
      id: 'remove-banking',
    });
    const kept = manageReducer(open, {
      type: 'result',
      section: 'banking',
      message: 'Something went wrong on our side and nothing was removed. Try again in a minute.',
      ok: false,
    });
    expect(kept.open.banking).toBe('remove-banking');
    const closed = manageReducer(open, {
      type: 'result',
      section: 'banking',
      message: 'Cancel or complete your published paid sessions.',
      ok: false,
      close: true,
    });
    expect(closed.open.banking).toBeNull();
    expect(closed.status.banking).toEqual({
      message: 'Cancel or complete your published paid sessions.',
      ok: false,
    });
  });

  it('opening a confirm closes any other confirm in the same section only', () => {
    let state = manageReducer(initialManageState(), {
      type: 'open',
      section: 'members',
      id: 'ban-a',
    });
    state = manageReducer(state, { type: 'open', section: 'invite', id: 'regen' });
    state = manageReducer(state, { type: 'open', section: 'members', id: 'ban-b' });
    expect(state.open.members).toBe('ban-b');
    expect(state.open.invite).toBe('regen');
  });

  it('closing only closes the confirm that is open (a late close of an old one is ignored)', () => {
    let state = manageReducer(initialManageState(), {
      type: 'open',
      section: 'members',
      id: 'ban-b',
    });
    state = manageReducer(state, { type: 'close', section: 'members', id: 'ban-a' });
    expect(state.open.members).toBe('ban-b');
    state = manageReducer(state, { type: 'close', section: 'members', id: 'ban-b' });
    expect(state.open.members).toBeNull();
  });

  it('a result sets that section status text and kind and leaves the others alone', () => {
    const state = manageReducer(initialManageState(), {
      type: 'result',
      section: 'requests',
      message: 'Ana Lee has been approved.',
      ok: true,
    });
    expect(state.status.requests).toEqual({ message: 'Ana Lee has been approved.', ok: true });
    expect(state.status.members).toBeNull();
  });

  it('a successful result closes that section confirm; a failed one keeps it open (5xx keeps the panel)', () => {
    const open = manageReducer(initialManageState(), {
      type: 'open',
      section: 'members',
      id: 'ban-a',
    });
    const failed = manageReducer(open, {
      type: 'result',
      section: 'members',
      message:
        'Something went wrong on our side. Your details are still here. Try again in a minute.',
      ok: false,
    });
    expect(failed.open.members).toBe('ban-a');
    const done = manageReducer(failed, {
      type: 'result',
      section: 'members',
      message: 'Dee Park has been banned.',
      ok: true,
    });
    expect(done.open.members).toBeNull();
  });
});
