import { describe, expect, it } from 'vitest';
import { ChatTabTitle, MAX_TAB_TITLE_CHARS } from '../tab-title';

const list = (sessions: object[]): object => ({ type: 'storedSessions', sessions, isFirstPage: true });

describe('ChatTabTitle', () => {
  it('starts as a new conversation and takes the title of its own session from the session list', () => {
    const title = new ChatTabTitle();
    expect(title.title).toBe('');
    expect(title.observe(list([{ id: 'a', preview: 'other' }]))).toBe(false);
    expect(title.observe({ type: 'sessionStarted', sessionId: 'b' })).toBe(false);
    expect(title.observe(list([{ id: 'a', preview: 'other' }, { id: 'b', preview: 'fix the build', aiTitle: 'Build fix' }]))).toBe(true);
    expect(title.title).toBe('Build fix');
    expect(title.observe(list([{ id: 'b', customTitle: 'Mine', aiTitle: 'Build fix' }]))).toBe(true);
    expect(title.title).toBe('Mine');
  });

  it('follows renames, clears and folder switches', () => {
    const title = new ChatTabTitle({ sessionId: 's', sessionName: 'Restored' });
    expect(title.title).toBe('Restored');
    expect(title.observe({ type: 'sessionRenamed', sessionId: 'other', newName: 'x' })).toBe(false);
    expect(title.observe({ type: 'sessionRenamed', sessionId: 's', newName: 'Renamed' })).toBe(true);
    expect(title.title).toBe('Renamed');
    title.observe({ type: 'sessionCleared' });
    expect(title.title).toBe('');
    title.observe({ type: 'resumeAccepted', sessionId: 'r' });
    title.observe(list([{ id: 'r', preview: 'resumed' }]));
    expect(title.title).toBe('resumed');
    expect(title.observe({ type: 'workspaceFolderUpdate', switched: false })).toBe(false);
    expect(title.observe({ type: 'workspaceFolderUpdate', switched: true })).toBe(true);
    expect(title.title).toBe('');
  });

  it('reports busy while the session runs or waits for the user', () => {
    const title = new ChatTabTitle();
    expect(title.observe({ type: 'sessionStateChanged', state: 'running', sessionId: 's' })).toBe(true);
    expect(title.busy).toBe(true);
    expect(title.observe({ type: 'sessionStateChanged', state: 'requires_action', sessionId: 's' })).toBe(false);
    expect(title.observe({ type: 'sessionStateChanged', state: 'idle', sessionId: 's' })).toBe(true);
    expect(title.busy).toBe(false);
  });

  it('collapses whitespace and clips a long preview', () => {
    const title = new ChatTabTitle({ sessionId: 's' });
    title.observe(list([{ id: 's', preview: `line one\n\n${'x'.repeat(300)}` }]));
    expect(title.title.length).toBe(MAX_TAB_TITLE_CHARS);
    expect(title.title.startsWith('line one x')).toBe(true);
    expect(title.title.endsWith('…')).toBe(true);
  });

  it('ignores anything that is not a host message object', () => {
    const title = new ChatTabTitle();
    expect(title.observe(null)).toBe(false);
    expect(title.observe('storedSessions')).toBe(false);
    expect(title.observe({ type: 'storedSessions', sessions: 'nope' })).toBe(false);
  });
});
