import { describe, it, expect } from 'vitest';
import {
  buildRedactedResult,
  BrowserFormInjectionError,
  cssAttrValue,
  injectField,
  createBrowserRequestInputTool,
  type InjectionOutcome,
} from '../browser-request-input-tool';
import type { FormSchema } from '../../../../shared/types/forms';
import type { Page } from 'patchright';

// Sentinel values a user might have entered. NONE of these must ever appear in the redacted result.
const SECRET_PASSWORD = 'hunter2-SENTINEL';
const SECRET_EMAIL = 'victim@example-SENTINEL.com';
const SECRET_SELECT = 'admin-SENTINEL-role';
const SECRETS = [SECRET_PASSWORD, SECRET_EMAIL, SECRET_SELECT];

const schema: FormSchema = {
  title: 'Login',
  fields: [
    { id: 'email', label: 'Email', type: 'email', selector: '#email' },
    { id: 'pw', label: 'Password', type: 'password', selector: '#pw', sensitive: true },
    { id: 'role', label: 'Role', type: 'select', selector: '#role', options: [{ label: 'Admin', value: SECRET_SELECT }] },
    { id: 'missing', label: 'Nickname', type: 'text', selector: '#missing' },
  ],
  submitSelector: '#submit',
};

describe('buildRedactedResult', () => {
  const outcomes: InjectionOutcome[] = [
    { id: 'email', label: 'Email', type: 'email', ok: true },
    { id: 'pw', label: 'Password', type: 'password', ok: true },
    { id: 'role', label: 'Role', type: 'select', ok: true },
    { id: 'missing', label: 'Nickname', type: 'text', ok: false, reason: 'element not found or not fillable (timed out)' },
  ];
  const result = buildRedactedResult(schema, outcomes, true);
  const json = JSON.stringify(result);

  it('never includes any entered value (JSON scan)', () => {
    for (const secret of SECRETS) {
      expect(json).not.toContain(secret);
    }
  });

  it('counts filled = number of ok:true outcomes and carries submitted', () => {
    expect(result.filled).toBe(3);
    expect(result.submitted).toBe(true);
  });

  it('masks sensitive fields (masked:true) and not others', () => {
    const byLabel = new Map(result.fields.map((f) => [f.label, f]));
    expect(byLabel.get('Password')!.masked).toBe(true);
    expect(byLabel.get('Email')!.masked).toBe(false);
  });

  it('records a failing field as ok:false with a value-free reason', () => {
    const failed = result.fields.find((f) => f.label === 'Nickname')!;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe('element not found or not fillable (timed out)');
    for (const secret of SECRETS) {
      expect(failed.reason).not.toContain(secret);
    }
  });

  it('emits exactly one entry per schema field, preserving label + type', () => {
    expect(result.fields).toHaveLength(schema.fields.length);
    expect(result.fields.map((f) => f.type)).toEqual(['email', 'password', 'select', 'text']);
  });

  it('marks a field missing from outcomes as ok:false', () => {
    const partial = buildRedactedResult(schema, [{ id: 'email', label: 'Email', type: 'email', ok: true }], false);
    expect(partial.filled).toBe(1);
    expect(partial.fields.filter((f) => !f.ok)).toHaveLength(3);
  });
});

describe('BrowserFormInjectionError', () => {
  it('carries a value-free reason and optional context', () => {
    const err = new BrowserFormInjectionError('selector not found', { label: 'Password', type: 'password' });
    expect(err.reason).toBe('selector not found');
    expect(err.label).toBe('Password');
    expect(err.type).toBe('password');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(SECRET_PASSWORD);
  });
});

describe('cssAttrValue', () => {
  it('escapes backslashes then double quotes, leaving plain text intact', () => {
    expect(cssAttrValue('plain')).toBe('plain');
    expect(cssAttrValue('a"b')).toBe('a\\"b');
    expect(cssAttrValue('a\\b')).toBe('a\\\\b');
    // Backslash-first ordering: a " \ b -> a \" \\ b
    expect(cssAttrValue('a"\\b')).toBe('a\\"\\\\b');
  });

  it('never leaves an unescaped quote that could break out of the attribute selector', () => {
    const escaped = cssAttrValue('x" ] , input');
    // Every double quote in the escaped output is backslash-prefixed.
    expect(/(^|[^\\])"/.test(escaped)).toBe(false);
  });
});

// A recording Playwright Page/Locator double: captures the method + args injectField drives, so we can
// assert the right control was used with the entered value and the finite action timeout — WITHOUT a
// real browser.
type Rec = Array<[string, ...unknown[]]>;
function makeLocator(rec: Rec): Record<string, unknown> {
  const loc: Record<string, unknown> = {
    first: () => loc,
    fill: async (...a: unknown[]) => { rec.push(['fill', ...a]); },
    selectOption: async (...a: unknown[]) => { rec.push(['selectOption', ...a]); },
    setChecked: async (...a: unknown[]) => { rec.push(['setChecked', ...a]); },
    check: async (...a: unknown[]) => { rec.push(['check', ...a]); },
    click: async (...a: unknown[]) => { rec.push(['click', ...a]); },
    locator: (sub: string) => { rec.push(['sublocator', sub]); return makeLocator(rec); },
  };
  return loc;
}
function makePage(rec: Rec): Page {
  return { locator: (sel: string) => { rec.push(['locator', sel]); return makeLocator(rec); } } as unknown as Page;
}
function throwingPage(name = 'TimeoutError'): Page {
  const err = Object.assign(new Error('boom'), { name });
  const loc: Record<string, unknown> = {
    first: () => loc,
    fill: async () => { throw err; },
    selectOption: async () => { throw err; },
    setChecked: async () => { throw err; },
    check: async () => { throw err; },
    locator: () => loc,
  };
  return { locator: () => loc } as unknown as Page;
}

describe('injectField', () => {
  const TIMEOUT = { timeout: 15_000 };

  it('fills text-like fields with String(value) and the action timeout', async () => {
    for (const type of ['text', 'password', 'textarea', 'number', 'email', 'url', 'tel', 'date'] as const) {
      const rec: Rec = [];
      await injectField(makePage(rec), { id: 'a', label: 'A', type, selector: '#a' }, 'VALUE-SENTINEL');
      expect(rec).toContainEqual(['fill', 'VALUE-SENTINEL', TIMEOUT]);
    }
  });

  it('selects an option with a SINGLE call (a bare string matches value or label)', async () => {
    const rec: Rec = [];
    await injectField(makePage(rec), { id: 's', label: 'S', type: 'select', selector: '#s' }, 'pro');
    const selects = rec.filter((r) => r[0] === 'selectOption');
    expect(selects).toHaveLength(1);
    expect(selects[0]).toEqual(['selectOption', 'pro', TIMEOUT]);
  });

  it('does NOT retry selectOption on failure (one timeout budget, never doubled)', async () => {
    let calls = 0;
    const loc: Record<string, unknown> = {
      first: () => loc,
      selectOption: async () => {
        calls++;
        throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      },
    };
    const page = { locator: () => loc } as unknown as Page;
    await expect(
      injectField(page, { id: 's', label: 'S', type: 'select', selector: '#s' }, 'nope'),
    ).rejects.toMatchObject({ reason: 'element not found or not fillable (timed out)' });
    expect(calls).toBe(1);
  });

  it('sets a checkbox from the coerced boolean value', async () => {
    const rec: Rec = [];
    await injectField(makePage(rec), { id: 'c', label: 'C', type: 'checkbox', selector: '#c' }, true);
    expect(rec).toContainEqual(['setChecked', true, TIMEOUT]);
    const rec2: Rec = [];
    await injectField(makePage(rec2), { id: 'c', label: 'C', type: 'checkbox', selector: '#c' }, false);
    expect(rec2).toContainEqual(['setChecked', false, TIMEOUT]);
  });

  it('checks a radio via a value-selector escaped through cssAttrValue', async () => {
    const rec: Rec = [];
    const tricky = 'a"b\\c';
    await injectField(makePage(rec), { id: 'r', label: 'R', type: 'radio', selector: '#r' }, tricky);
    const sub = rec.find((r) => r[0] === 'sublocator');
    expect(sub?.[1]).toBe(`input[type="radio"][value="${cssAttrValue(tricky)}"]`);
    expect(rec.some((r) => r[0] === 'check')).toBe(true);
  });

  it('throws a value-free error when no value is provided', async () => {
    const rec: Rec = [];
    await expect(
      injectField(makePage(rec), { id: 'a', label: 'A', type: 'text', selector: '#a' }, undefined),
    ).rejects.toMatchObject({ reason: 'no value provided' });
  });

  it('maps a locator timeout to a value-free reason (never the entered value)', async () => {
    await expect(
      injectField(throwingPage('TimeoutError'), { id: 'a', label: 'A', type: 'text', selector: '#a' }, 'SECRET-SENTINEL'),
    ).rejects.toMatchObject({ reason: 'element not found or not fillable (timed out)' });
    await expect(
      injectField(throwingPage('OtherError'), { id: 'a', label: 'A', type: 'text', selector: '#a' }, 'SECRET-SENTINEL'),
    ).rejects.toMatchObject({ reason: 'element not fillable' });
  });
});

describe('buildRedactedResult — skipped optional fields', () => {
  const s: FormSchema = {
    fields: [
      { id: 'a', label: 'A', type: 'text', selector: '#a' },
      { id: 'b', label: 'B', type: 'text', selector: '#b' },
    ],
  };
  it('excludes skipped fields from filled and marks them skipped', () => {
    const r = buildRedactedResult(
      s,
      [
        { id: 'a', label: 'A', type: 'text', ok: true },
        { id: 'b', label: 'B', type: 'text', ok: true, skipped: true },
      ],
      false,
    );
    expect(r.filled).toBe(1);
    expect(r.fields.find((f) => f.label === 'B')!.skipped).toBe(true);
    expect(r.fields.find((f) => f.label === 'A')!.skipped).toBeUndefined();
  });
});

describe('createBrowserRequestInputTool.execute', () => {
  const makeTool = (
    canUseTool: (...a: unknown[]) => Promise<unknown>,
    getCurrentPage: () => Page | null,
  ) => {
    const pi = { defineTool: (cfg: unknown) => cfg } as never;
    // The tool now binds to a per-agent scope handle: it reads the scope's current page and reveals it
    // to the human before prompting so the form's fields belong to the tab the values inject into.
    const scope = { getCurrentPage, reveal: () => {} } as never;
    const permissionHandler = { canUseTool } as never;
    return createBrowserRequestInputTool(pi, scope, permissionHandler) as unknown as {
      execute: (id: string, params: unknown, signal: AbortSignal) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
    };
  };
  const signal = () => new AbortController().signal;

  it('throws (error tool result) when the user cancels/denies', async () => {
    const tool = makeTool(async () => ({ behavior: 'deny', message: 'User cancelled the input form' }), () => makePage([]));
    await expect(
      tool.execute('t', { fields: [{ id: 'a', label: 'A', type: 'text', selector: '#a' }] }, signal()),
    ).rejects.toThrow(/cancelled|reject/i);
  });

  it('never prompts when there is no active page (checks the page BEFORE canUseTool)', async () => {
    let prompted = false;
    const tool = makeTool(async () => { prompted = true; return { behavior: 'allow', updatedInput: { values: {} } }; }, () => null);
    const res = await tool.execute('t', { fields: [{ id: 'a', label: 'A', type: 'text', selector: '#a' }] }, signal());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No active browser page/);
    expect(prompted).toBe(false); // the user is never asked to type a secret with nowhere to inject it
  });

  it('rejects a malformed schema as a fixable tool error, not a user denial, without prompting', async () => {
    let prompted = false;
    const tool = makeTool(async () => { prompted = true; return { behavior: 'allow', updatedInput: { values: {} } }; }, () => makePage([]));
    // Duplicate field id — valid TypeBox shape but semantically invalid.
    const res = await tool.execute('t', {
      fields: [
        { id: 'dup', label: 'A', type: 'text', selector: '#a' },
        { id: 'dup', label: 'B', type: 'text', selector: '#b' },
      ],
    }, signal());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/invalid form schema/i);
    expect(res.content[0].text).not.toMatch(/user|reject|denied/i);
    expect(prompted).toBe(false);
  });

  it('does NOT click the submit selector when a required field failed to inject', async () => {
    const rec: Rec = [];
    // A page whose fill throws (required field injection fails); every other locator method records.
    const page = {
      locator: (sel: string) => {
        rec.push(['locator', sel]);
        const loc: Record<string, unknown> = {
          first: () => loc,
          fill: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); },
          click: async (...a: unknown[]) => { rec.push(['click', sel, ...a]); },
        };
        return loc;
      },
    } as unknown as Page;
    const schema: FormSchema = {
      fields: [{ id: 'name', label: 'Name', type: 'text', selector: '#name', required: true }],
      submitSelector: '#go',
    };
    const tool = makeTool(async () => ({ behavior: 'allow', updatedInput: { values: { name: 'X' } } }), () => page);
    const res = await tool.execute('t', schema, signal());
    const parsed = JSON.parse(res.content[0].text!);
    expect(parsed.submitted).toBe(false);
    expect(parsed.fields[0].ok).toBe(false);
    // The submit control was never clicked — the live form is not posted partially filled.
    expect(rec.some((r) => r[0] === 'click')).toBe(false);
  });

  it('returns an isError result when there is no active page', async () => {
    const tool = makeTool(async () => ({ behavior: 'allow', updatedInput: { values: {} } }), () => null);
    const res = await tool.execute('t', { fields: [{ id: 'a', label: 'A', type: 'text', selector: '#a' }] }, signal());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No active browser page/);
  });

  it('injects values, submits, skips blank optionals, and returns a value-free result', async () => {
    const SECRET = 'p@ss-SENTINEL';
    const rec: Rec = [];
    const page = makePage(rec);
    const schema: FormSchema = {
      fields: [
        { id: 'email', label: 'Email', type: 'email', selector: '#email' },
        { id: 'pw', label: 'Password', type: 'password', selector: '#pw', sensitive: true, required: true },
        { id: 'nick', label: 'Nick', type: 'text', selector: '#nick' },
      ],
      submitSelector: '#submit',
    };
    const tool = makeTool(
      async () => ({ behavior: 'allow', updatedInput: { values: { email: 'a@b.com', pw: SECRET } } }),
      () => page,
    );
    const res = await tool.execute('t', schema, signal());
    const parsed = JSON.parse(res.content[0].text!);
    expect(parsed.filled).toBe(2);
    expect(parsed.submitted).toBe(true);
    expect(parsed.fields.find((f: { label: string }) => f.label === 'Nick').skipped).toBe(true);
    // The secret was injected via fill but never appears in the model-facing result.
    expect(rec).toContainEqual(['fill', SECRET, { timeout: 15_000 }]);
    expect(res.content[0].text).not.toContain(SECRET);
  });

  it('reports a required-empty field as a value-free failure and never injects ""', async () => {
    const rec: Rec = [];
    const page = makePage(rec);
    const schema: FormSchema = {
      fields: [
        { id: 'name', label: 'Name', type: 'text', selector: '#name', required: true },
        { id: 'nick', label: 'Nick', type: 'text', selector: '#nick' },
      ],
    };
    // Allowed with an empty required field (the webview normally blocks this — defense in depth).
    const tool = makeTool(
      async () => ({ behavior: 'allow', updatedInput: { values: { name: '', nick: '' } } }),
      () => page,
    );
    const res = await tool.execute('t', schema, signal());
    const parsed = JSON.parse(res.content[0].text!);
    const name = parsed.fields.find((f: { label: string }) => f.label === 'Name');
    expect(name.ok).toBe(false);
    expect(name.reason).toBe('required field was left empty');
    expect(parsed.fields.find((f: { label: string }) => f.label === 'Nick').skipped).toBe(true);
    expect(parsed.filled).toBe(0);
    // Nothing was injected — no empty fill for the required field.
    expect(rec.some((r) => r[0] === 'fill')).toBe(false);
  });

  it('does not crash when allow carries no updatedInput (auto-allow path)', async () => {
    const schema: FormSchema = { fields: [{ id: 'a', label: 'A', type: 'text', selector: '#a' }] };
    const tool = makeTool(async () => ({ behavior: 'allow' }), () => makePage([]));
    const res = await tool.execute('t', schema, signal());
    const parsed = JSON.parse(res.content[0].text!);
    expect(parsed.fields[0].skipped).toBe(true);
  });
});
