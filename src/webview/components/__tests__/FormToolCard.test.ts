// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FormToolCard from '../FormToolCard.vue';
import { i18n } from '@/i18n';
import type { ToolCall } from '@shared/types/session';
import type { FormResult } from '@shared/types/forms';

function makeToolCall(input: unknown, result?: FormResult, status = 'completed'): ToolCall {
  return {
    id: 't1',
    toolName: 'BrowserRequestInput',
    input,
    result: result ? JSON.stringify(result) : undefined,
    status,
  } as unknown as ToolCall;
}

function render(toolCall: ToolCall) {
  return mount(FormToolCard, { props: { toolCall }, global: { plugins: [i18n] } });
}

const baseInput = {
  fields: [
    { id: 'email', label: 'Email', type: 'email', selector: '#e' },
    { id: 'pw', label: 'Password', type: 'password', selector: '#p', sensitive: true },
    { id: 'nick', label: 'Nick', type: 'text', selector: '#n' },
  ],
};

const baseResult = (submitted: boolean): FormResult => ({
  filled: 2,
  submitted,
  fields: [
    { label: 'Email', type: 'email', ok: true, masked: false },
    { label: 'Password', type: 'password', ok: true, masked: true },
    { label: 'Nick', type: 'text', ok: true, skipped: true },
  ],
});

describe('FormToolCard, submit-status badge', () => {
  it('hides the Submitted/Not-submitted badge when no submitSelector was requested', () => {
    const text = render(makeToolCall(baseInput, baseResult(false))).text();
    expect(text).not.toContain('Not submitted');
    expect(text).not.toContain('Submitted');
    expect(text).toContain('2 / 3 filled');
  });

  it('shows "Not submitted" when a submitSelector was requested but the page form was not submitted', () => {
    const text = render(makeToolCall({ ...baseInput, submitSelector: '#go' }, baseResult(false))).text();
    expect(text).toContain('Not submitted');
  });

  it('shows "Submitted" when a submitSelector was requested and the page form was submitted', () => {
    const text = render(makeToolCall({ ...baseInput, submitSelector: '#go' }, baseResult(true))).text();
    expect(text).toContain('Submitted');
    expect(text).not.toContain('Not submitted');
  });
});

describe('FormToolCard, masking and skipped', () => {
  it('masks a sensitive field with dots and does not render any value', () => {
    const text = render(makeToolCall(baseInput, baseResult(false))).text();
    expect(text).toContain('••••');
  });

  it('marks an optional blank field as skipped, not failed', () => {
    const text = render(makeToolCall(baseInput, baseResult(false))).text();
    expect(text).toContain('optional, left blank');
  });
});

describe('FormToolCard, header', () => {
  it('pluralizes the field count', () => {
    expect(render(makeToolCall({ fields: [{ id: 'a', label: 'A', type: 'text', selector: '#a' }] })).text()).toContain('Requesting input (1 field)');
    expect(render(makeToolCall(baseInput)).text()).toContain('Requesting input (3 fields)');
  });

  it('uses the schema title when present', () => {
    expect(render(makeToolCall({ ...baseInput, title: 'Sign in' })).text()).toContain('Sign in');
  });
});
