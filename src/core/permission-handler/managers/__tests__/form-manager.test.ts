import { describe, it, expect } from 'vitest';
import { FormManager, validateForm } from '../form-manager';
import { PermissionState } from '../../state';
import type { CanUseToolContext } from '../../types';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';

const validField = (overrides: Record<string, unknown> = {}) => ({
  id: 'email',
  label: 'Email',
  type: 'email',
  selector: '#email',
  ...overrides,
});

const validForm = (overrides: Record<string, unknown> = {}) => ({
  fields: [validField()],
  ...overrides,
});

describe('validateForm', () => {
  it('accepts a minimal valid single-field form', () => {
    const r = validateForm(validForm());
    expect(r.ok).toBe(true);
  });

  it('accepts a full form with title/description/submit + select options', () => {
    const r = validateForm({
      title: 'Login',
      description: 'Sign in',
      submitSelector: '#submit',
      submitLabel: 'Go',
      fields: [
        validField({ id: 'pw', label: 'Password', type: 'password', selector: '#pw', sensitive: true, required: true, placeholder: '••' }),
        validField({ id: 'role', label: 'Role', type: 'select', selector: '#role', options: [{ label: 'Admin', value: 'admin' }] }),
        validField({ id: 'plan', label: 'Plan', type: 'radio', selector: '#plan', options: [{ label: 'Pro', value: 'pro' }] }),
        validField({ id: 'tos', label: 'Accept', type: 'checkbox', selector: '#tos' }),
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validateForm(null).ok).toBe(false);
    expect(validateForm('x').ok).toBe(false);
  });

  it('rejects non-array fields', () => {
    const r = validateForm({ fields: 'nope' });
    expect(r).toEqual({ ok: false, reason: 'fields must be an array' });
  });

  it('rejects empty fields array', () => {
    const r = validateForm({ fields: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/non-empty/);
  });

  it('rejects more than 30 fields', () => {
    const r = validateForm({ fields: Array(31).fill(validField()) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/at most 30/);
  });

  it('rejects a field that is not an object', () => {
    const r = validateForm({ fields: [null] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fields\[0\] must be an object/);
  });

  it('rejects missing id', () => {
    const r = validateForm({ fields: [validField({ id: '  ' })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/id must be a non-empty string/);
  });

  it('rejects missing label', () => {
    const r = validateForm({ fields: [validField({ label: '' })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/label must be a non-empty string/);
  });

  it('rejects missing selector', () => {
    const r = validateForm({ fields: [validField({ selector: '' })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/selector must be a non-empty string/);
  });

  it('rejects an unsupported type', () => {
    const r = validateForm({ fields: [validField({ type: 'color' })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/type must be one of/);
  });

  it('rejects select without options', () => {
    const r = validateForm({ fields: [validField({ type: 'select', options: undefined })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/options must be a non-empty array/);
  });

  it('rejects radio with empty options', () => {
    const r = validateForm({ fields: [validField({ type: 'radio', options: [] })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/options must be a non-empty array/);
  });

  it('rejects select options with non-string value', () => {
    const r = validateForm({ fields: [validField({ type: 'select', options: [{ label: 'A', value: 1 }] })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/label and value/);
  });

  it('rejects non-boolean sensitive', () => {
    const r = validateForm({ fields: [validField({ sensitive: 'yes' })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/sensitive must be a boolean/);
  });

  it('rejects non-string submitSelector', () => {
    const r = validateForm({ ...validForm(), submitSelector: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/submitSelector must be a string/);
  });

  it('rejects duplicate field ids', () => {
    const r = validateForm({
      fields: [validField({ id: 'dup' }), validField({ id: 'dup', label: 'Other', selector: '#other' })],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fields\[1\]\.id duplicates an earlier field id/);
  });

  it('rejects a field string longer than the 2000-char cap', () => {
    const r = validateForm({ fields: [validField({ label: 'x'.repeat(2001) })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/label must be at most 2000 characters/);
  });

  it('rejects a form-level string longer than the cap', () => {
    const r = validateForm({ ...validForm(), title: 'y'.repeat(2001) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/title must be at most 2000 characters/);
  });

  it('rejects more than 100 options', () => {
    const r = validateForm({
      fields: [validField({ type: 'select', options: Array(101).fill({ label: 'A', value: 'a' }) })],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/options must have at most 100 items/);
  });

  it('rejects an option label/value longer than the cap', () => {
    const r = validateForm({
      fields: [validField({ type: 'select', options: [{ label: 'z'.repeat(2001), value: 'a' }] })],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/label\/value must be at most 2000 characters/);
  });
});

function makeContext(signal: AbortSignal, toolUseID: string | null = 'tool-1'): CanUseToolContext {
  return { signal, toolUseID, parentToolUseId: null };
}

describe('FormManager', () => {
  const setup = () => {
    const state = new PermissionState();
    const posted: ExtensionToWebviewMessage[] = [];
    const mgr = new FormManager(state, () => (m) => posted.push(m));
    return { state, posted, mgr };
  };

  it('rejects invalid input with a value-free deny', async () => {
    const { mgr } = setup();
    const ac = new AbortController();
    const r = await mgr.handleForm({ fields: [] }, makeContext(ac.signal));
    expect(r.behavior).toBe('deny');
    expect(r.message).toMatch(/^BrowserRequestInput input invalid:/);
  });

  it('posts requestForm (schema only) and stores a pending entry', () => {
    const { state, posted, mgr } = setup();
    const ac = new AbortController();
    void mgr.handleForm(validForm(), makeContext(ac.signal));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'requestForm', toolUseId: 'tool-1' });
    // The posted payload carries the schema, never any values.
    expect(JSON.stringify(posted[0])).not.toMatch(/values/);
    expect(state.pendingForms.size).toBe(1);
  });

  it('resolve happy path returns allow + values and clears pending', async () => {
    const { state, mgr } = setup();
    const ac = new AbortController();
    const p = mgr.handleForm(validForm(), makeContext(ac.signal));
    mgr.resolveForm('tool-1', { email: 'a@b.com' });
    const r = await p;
    expect(r).toEqual({ behavior: 'allow', updatedInput: { values: { email: 'a@b.com' } } });
    expect(state.pendingForms.size).toBe(0);
  });

  it('cancel (null) returns deny and clears pending', async () => {
    const { state, mgr } = setup();
    const ac = new AbortController();
    const p = mgr.handleForm(validForm(), makeContext(ac.signal));
    mgr.resolveForm('tool-1', null);
    const r = await p;
    expect(r).toEqual({ behavior: 'deny', message: 'User cancelled the input form' });
    expect(state.pendingForms.size).toBe(0);
  });

  it('denies immediately when the signal is already aborted (no dangling pending)', async () => {
    const { state, mgr } = setup();
    const ac = new AbortController();
    ac.abort();
    const r = await mgr.handleForm(validForm(), makeContext(ac.signal));
    expect(r).toEqual({ behavior: 'deny', message: 'User cancelled the input form' });
    expect(state.pendingForms.size).toBe(0);
  });

  it('abort fires cleanup, denies, and leaves NO dangling pending entry', async () => {
    const { state, mgr } = setup();
    const ac = new AbortController();
    const p = mgr.handleForm(validForm(), makeContext(ac.signal));
    expect(state.pendingForms.size).toBe(1);
    ac.abort();
    const r = await p;
    expect(r).toEqual({ behavior: 'deny', message: 'User cancelled the input form' });
    expect(state.pendingForms.size).toBe(0);
  });

  it('double-resolve is a no-op (second resolve does not overwrite or throw)', async () => {
    const { state, mgr } = setup();
    const ac = new AbortController();
    const p = mgr.handleForm(validForm(), makeContext(ac.signal));
    mgr.resolveForm('tool-1', { email: 'first@x.com' });
    expect(() => mgr.resolveForm('tool-1', { email: 'second@x.com' })).not.toThrow();
    const r = await p;
    expect(r).toEqual({ behavior: 'allow', updatedInput: { values: { email: 'first@x.com' } } });
    expect(state.pendingForms.size).toBe(0);
  });

  it('denies when no postMessage channel is wired', async () => {
    const state = new PermissionState();
    const mgr = new FormManager(state, () => null);
    const ac = new AbortController();
    const r = await mgr.handleForm(validForm(), makeContext(ac.signal));
    expect(r).toEqual({ behavior: 'deny', message: 'User cancelled the input form' });
  });
});
