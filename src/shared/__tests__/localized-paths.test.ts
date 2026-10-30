import { describe, expect, it } from 'vitest';
import { malformedLocalizedText, malformedWebviewText } from '../localized-paths';

const TEXT = { message: 'Failed: {0}', args: ['disk full'] };

describe('malformedLocalizedText', () => {
  it('passes LocalizedText and an absent field, and names the first path that holds anything else', () => {
    expect(malformedLocalizedText({ error: TEXT }, ['.error'], 100)).toBeUndefined();
    expect(malformedLocalizedText({}, ['.error'], 100)).toBeUndefined();
    expect(malformedLocalizedText({ error: 'disk full' }, ['.error'], 100)).toBe('.error');
    expect(malformedLocalizedText({ error: null }, ['.error'], 100)).toBe('.error');
    expect(malformedLocalizedText({ a: TEXT, b: { message: 'x'.repeat(101) } }, ['.a', '.b'], 100)).toBe('.b');
  });

  it('checks every item of an array, and a union member only where its tag holds', () => {
    const paths = ['.servers[].error', '.status[kind="failed"].message'];
    expect(malformedLocalizedText({ servers: [{ error: TEXT }, {}], status: { kind: 'failed', message: TEXT } }, paths, 100)).toBeUndefined();
    expect(malformedLocalizedText({ servers: [{ error: TEXT }, { error: 'boom' }] }, paths, 100)).toBe('.servers[].error');
    expect(malformedLocalizedText({ status: { kind: 'ready', message: 'Ready' } }, paths, 100)).toBeUndefined();
    expect(malformedLocalizedText({ status: { kind: 'failed', message: 'Failed' } }, paths, 100)).toBe('.status[kind="failed"].message');
    expect(malformedLocalizedText({ kind: 'refused', message: 7 }, ['[kind="refused"].message'], 100)).toBe('[kind="refused"].message');
    expect(malformedLocalizedText({ kind: 'ok' }, ['[kind="refused"].message'], 100)).toBeUndefined();
  });
});

describe('malformedWebviewText', () => {
  it('reads the paths of the message\'s own type, and passes a type that carries no LocalizedText', () => {
    expect(malformedWebviewText({ type: 'notification', message: TEXT, notificationType: 'info' })).toBeUndefined();
    expect(malformedWebviewText({ type: 'notification', message: 'Your prompt was blocked by a hook.', notificationType: 'warning' })).toBe('.message');
    expect(malformedWebviewText({ type: 'voiceRuntimeStatus', status: { kind: 'failed', message: { message: 'x', args: [{ number: Number.NaN }] } } })).toBe('.status[kind="failed"].message');
    expect(malformedWebviewText({ type: 'partial', data: { message: 'not core text' } })).toBeUndefined();
    expect(malformedWebviewText('nonsense')).toBeUndefined();
  });
});
