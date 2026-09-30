import { describe, it, expect, vi, type Mock } from 'vitest';
import { createElicitationHandler, coerceAndValidate } from '../elicitation-handler';
import type { ElicitationUI } from '../elicitation-handler';

vi.mock('../../logger', () => ({ log: vi.fn() }));

interface MockUI extends ElicitationUI {
  select: Mock<ElicitationUI['select']>;
  input: Mock<ElicitationUI['input']>;
  notify: Mock<ElicitationUI['notify']>;
}

const selectSpy = (): Mock<ElicitationUI['select']> => vi.fn();
const inputSpy = (): Mock<ElicitationUI['input']> => vi.fn();

function mockUI(overrides?: Partial<Pick<MockUI, 'select' | 'input' | 'notify'>>): MockUI {
  return {
    select: selectSpy(),
    input: inputSpy(),
    notify: vi.fn(),
    ...overrides,
  };
}

describe('createElicitationHandler — form elicitation', () => {
  it('collects a string field, reviews it, and maps Submit to accept', async () => {
    const ui = mockUI({
      select: selectSpy()
        .mockResolvedValueOnce('Continue')
        .mockResolvedValueOnce('Enter value')
        .mockResolvedValueOnce('Submit'),
      input: inputSpy().mockResolvedValueOnce('octocat'),
    });
    const handler = createElicitationHandler(ui);

    const result = await handler(
      {
        mode: 'form',
        message: 'Please provide your GitHub username',
        requestedSchema: {
          type: 'object',
          properties: { username: { type: 'string', title: 'GitHub username', minLength: 1 } },
          required: ['username'],
        },
      },
      'github',
    );

    expect(ui.select.mock.calls[0]).toEqual([
      'MCP Input Request\nServer: github\n\nPlease provide your GitHub username',
      ['Continue', 'Decline'],
    ]);
    expect(ui.input).toHaveBeenCalledWith('GitHub username (required)', undefined);
    expect(ui.select.mock.calls[2]?.[0]).toContain('GitHub username: octocat');
    expect(result).toEqual({ action: 'accept', content: { username: 'octocat' } });
  });

  it('flattens server-controlled field labels so they cannot forge attribution lines (L1)', async () => {
    const ui = mockUI({
      select: selectSpy()
        .mockResolvedValueOnce('Continue')
        .mockResolvedValueOnce('Enter value')
        .mockResolvedValueOnce('Submit'),
      input: inputSpy().mockResolvedValueOnce('x'),
    });
    const handler = createElicitationHandler(ui);

    await handler(
      {
        mode: 'form',
        message: 'ok',
        requestedSchema: {
          type: 'object',
          properties: {
            token: {
              type: 'string',
              title: 'Trusted Bank\nServer: trusted-bank\nEnter your password',
              description: 'line1\r\nline2',
            },
          },
          required: ['token'],
        },
      },
      'evil',
    );

    const inputTitle = ui.input.mock.calls[0]?.[0] as string;
    expect(inputTitle).not.toContain('\n');
    expect(inputTitle).not.toContain('\r');
    expect(inputTitle).toContain('Trusted Bank Server: trusted-bank Enter your password');
  });

  it('maps an enum string field to a select dialog and accepts the chosen value', async () => {
    const ui = mockUI({
      select: selectSpy()
        .mockResolvedValueOnce('Continue')
        .mockResolvedValueOnce('Medium (medium)')
        .mockResolvedValueOnce('Submit'),
    });
    const handler = createElicitationHandler(ui);

    const result = await handler(
      {
        mode: 'form',
        message: 'Pick a priority',
        requestedSchema: {
          type: 'object',
          properties: {
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              enumNames: ['Low', 'Medium', 'High'],
            },
          },
          required: ['priority'],
        },
      },
      'demo',
    );

    expect(ui.select.mock.calls[1]).toEqual([
      'Priority (required)',
      ['Low (low)', 'Medium (medium)', 'High (high)'],
    ]);
    expect(ui.input).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'accept', content: { priority: 'medium' } });
  });

  it('maps a boolean field to a Yes/No select', async () => {
    const ui = mockUI({
      select: selectSpy()
        .mockResolvedValueOnce('Continue')
        .mockResolvedValueOnce('No')
        .mockResolvedValueOnce('Submit'),
    });
    const handler = createElicitationHandler(ui);

    const result = await handler(
      {
        mode: 'form',
        message: 'Enable feature?',
        requestedSchema: {
          type: 'object',
          properties: { enabled: { type: 'boolean' } },
          required: ['enabled'],
        },
      },
      'demo',
    );

    expect(ui.select.mock.calls[1]).toEqual(['Enabled (required)', ['Yes', 'No']]);
    expect(result).toEqual({ action: 'accept', content: { enabled: false } });
  });

  it('lets the user edit a value from the review screen', async () => {
    const ui = mockUI({
      select: selectSpy()
        .mockResolvedValueOnce('Continue')
        .mockResolvedValueOnce('Enter value')
        .mockResolvedValueOnce('Edit')
        .mockResolvedValueOnce('Name (name)')
        .mockResolvedValueOnce('Enter value')
        .mockResolvedValueOnce('Submit'),
      input: inputSpy().mockResolvedValueOnce('Old').mockResolvedValueOnce('New'),
    });
    const handler = createElicitationHandler(ui);

    const result = await handler(
      {
        mode: 'form',
        message: 'Choose a name',
        requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Name' } } },
      },
      'demo',
    );

    expect(ui.input.mock.calls[1]).toEqual(['Name', 'Old']);
    expect(result).toEqual({ action: 'accept', content: { name: 'New' } });
  });

  it('validates required + format constraints and lets the user correct invalid input', async () => {
    const ui = mockUI({
      select: selectSpy()
        .mockResolvedValueOnce('Continue')
        .mockResolvedValueOnce('Enter value')
        .mockResolvedValueOnce('Enter value')
        .mockResolvedValueOnce('Submit'),
      input: inputSpy().mockResolvedValueOnce('ab').mockResolvedValueOnce('octocat'),
    });
    const handler = createElicitationHandler(ui);

    const result = await handler(
      {
        mode: 'form',
        message: 'Pick a username',
        requestedSchema: {
          type: 'object',
          properties: { username: { type: 'string', minLength: 5 } },
          required: ['username'],
        },
      },
      'demo',
    );

    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('username'), 'error');
    expect(ui.input).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ action: 'accept', content: { username: 'octocat' } });
  });

  it.each([
    ['number', false],
    ['number', true],
    ['integer', false],
    ['integer', true],
  ] as const)('rejects blank %s input and reprompts when required=%s', async (type, required) => {
    const ui = mockUI({
      select: selectSpy()
        .mockResolvedValueOnce('Continue')
        .mockResolvedValueOnce('Enter value')
        .mockResolvedValueOnce('Enter value')
        .mockResolvedValueOnce('Submit'),
      input: inputSpy().mockResolvedValueOnce('   ').mockResolvedValueOnce('7'),
    });
    const handler = createElicitationHandler(ui);

    const result = await handler(
      {
        mode: 'form',
        message: 'Choose a quantity',
        requestedSchema: {
          type: 'object',
          properties: { quantity: { type } },
          ...(required ? { required: ['quantity'] } : {}),
        },
      },
      'demo',
    );

    expect(ui.notify).toHaveBeenCalledWith('Elicitation field quantity must be a number', 'error');
    expect(ui.input).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ action: 'accept', content: { quantity: 7 } });
  });

  it('uses a default value and omits an optional field', async () => {
    const ui = mockUI({
      select: selectSpy()
        .mockResolvedValueOnce('Continue')
        .mockResolvedValueOnce('Use default')
        .mockResolvedValueOnce('Omit')
        .mockResolvedValueOnce('Submit'),
    });
    const handler = createElicitationHandler(ui);

    const result = await handler(
      {
        mode: 'form',
        message: 'Configure',
        requestedSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', default: 'Untitled' },
            note: { type: 'string' },
          },
        },
      },
      'demo',
    );

    expect(result).toEqual({ action: 'accept', content: { title: 'Untitled' } });
  });

  it('maps explicit refusal to decline and dialog dismissal to cancel', async () => {
    const params = {
      mode: 'form',
      message: 'Provide a value',
      requestedSchema: { type: 'object', properties: {} },
    };

    await expect(
      createElicitationHandler(mockUI({ select: selectSpy().mockResolvedValue('Decline') }))(params, 'demo'),
    ).resolves.toEqual({ action: 'decline' });

    await expect(
      createElicitationHandler(mockUI({ select: selectSpy().mockResolvedValue(undefined) }))(params, 'demo'),
    ).resolves.toEqual({ action: 'cancel' });
  });

  it('cancels when a field dialog is dismissed mid-form', async () => {
    const ui = mockUI({
      select: selectSpy().mockResolvedValueOnce('Continue').mockResolvedValueOnce(undefined),
    });
    const handler = createElicitationHandler(ui);

    const result = await handler(
      {
        mode: 'form',
        message: 'Pick',
        requestedSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
      'demo',
    );

    expect(result).toEqual({ action: 'cancel' });
  });
});

describe('createElicitationHandler — unsupported modes', () => {
  it('declines URL elicitation with a notice (form-only v1)', async () => {
    const ui = mockUI();
    const handler = createElicitationHandler(ui);

    const result = await handler(
      { mode: 'url', message: 'Authorize', elicitationId: 'auth-1', url: 'https://example.com' },
      'payments',
    );

    expect(result).toEqual({ action: 'decline' });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('payments'), 'warning');
    expect(ui.select).not.toHaveBeenCalled();
  });

  it('declines malformed params without rendering a dialog', async () => {
    const ui = mockUI();
    const handler = createElicitationHandler(ui);

    await expect(handler(null, 'demo')).resolves.toEqual({ action: 'decline' });
    await expect(handler({ message: 'no schema' }, 'demo')).resolves.toEqual({ action: 'decline' });
    expect(ui.select).not.toHaveBeenCalled();
  });
});

describe('coerceAndValidate', () => {
  it('coerces primitives and enforces numeric range', () => {
    const content = coerceAndValidate(
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'integer', minimum: 1, maximum: 100 },
          flag: { type: 'boolean' },
        },
        required: ['name', 'count', 'flag'],
      },
      { name: 'x', count: '42', flag: true },
    );
    expect(content).toEqual({ name: 'x', count: 42, flag: true });
  });

  it('throws on a missing required field', () => {
    expect(() =>
      coerceAndValidate(
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        {},
      ),
    ).toThrow(/Missing required elicitation field: name/);
  });

  it('throws when a value is below minimum', () => {
    expect(() =>
      coerceAndValidate(
        { type: 'object', properties: { count: { type: 'integer', minimum: 5 } }, required: ['count'] },
        { count: 2 },
      ),
    ).toThrow(/below minimum 5/);
  });
});
