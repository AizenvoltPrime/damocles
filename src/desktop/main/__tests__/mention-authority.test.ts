import { describe, expect, it } from 'vitest';
import { crossedAuthority, crossedByMention, crossedByViewMessage, ownRemoteDrop } from '../mention-authority';

describe('crossedAuthority', () => {
  it('names the other authority of a project file, and nothing for the chat\'s own', () => {
    expect(crossedAuthority('loopback', 'c:\\work\\app')).toBe('local');
    expect(crossedAuthority('local', 'loopback|c:\\work\\app')).toBe('loopback');
    expect(crossedAuthority('ssh+abc', 'loopback|/srv/app')).toBe('loopback');
    expect(crossedAuthority('loopback', 'loopback|c:\\work\\app')).toBeUndefined();
    expect(crossedAuthority('local', 'c:\\work\\app')).toBeUndefined();
  });
});

describe('crossedByMention', () => {
  it('names the authority a file outside every project is on when the chat runs elsewhere, as for a project file', () => {
    expect(crossedByMention('loopback', { path: '/home/me/notes.md', authority: 'loopback' })).toBeUndefined();
    expect(crossedByMention('local', { path: '/home/me/notes.md', authority: 'loopback' })).toBe('loopback');
    expect(crossedByMention('loopback', { path: 'C:\\Users\\me\\notes.md', authority: 'local' })).toBe('local');
    expect(crossedByMention('local', { path: 'C:\\Users\\me\\notes.md', authority: 'local' })).toBeUndefined();
    expect(crossedByMention('ssh+abc', { projectKey: 'loopback|/srv/app', relativePath: 'a.ts' })).toBe('loopback');
    expect(crossedByMention('loopback', { projectKey: 'loopback|/srv/app', relativePath: 'a.ts' })).toBeUndefined();
  });
});

describe('crossedByViewMessage', () => {
  it('refuses a local file dropped into a remote chat and a remote file dropped into a local one', () => {
    expect(crossedByViewMessage('loopback', { type: 'mentionDropped', projectKey: 'c:\\work\\app', relativePath: 'a.ts' })).toBe('local');
    expect(crossedByViewMessage('local', { type: 'mentionDropped', projectKey: 'loopback|c:\\work\\app', relativePath: 'a.ts' })).toBe('loopback');
  });

  it('refuses no drop of the chat\'s own host', () => {
    expect(crossedByViewMessage('loopback', { type: 'mentionDropped', projectKey: 'loopback|c:\\work\\app', relativePath: 'a.ts' })).toBeUndefined();
  });

  it('takes a drop of a remote chat\'s own host for its core\'s client, which strips the prefix the page names it by', () => {
    expect(ownRemoteDrop('loopback', { type: 'mentionDropped', projectKey: 'loopback|/srv/app', relativePath: 'src/a.ts' })).toEqual({ projectKey: 'loopback|/srv/app', relativePath: 'src/a.ts' });
    expect(ownRemoteDrop('loopback', { type: 'mentionDropped', projectKey: '/home/me/app', relativePath: 'a.ts' })).toBeUndefined();
    expect(ownRemoteDrop('ssh+abc', { type: 'mentionDropped', projectKey: 'loopback|/srv/app', relativePath: 'a.ts' })).toBeUndefined();
    expect(ownRemoteDrop('local', { type: 'mentionDropped', projectKey: '/home/me/app', relativePath: 'a.ts' })).toBeUndefined();
    expect(ownRemoteDrop('loopback', { type: 'mentionDropped', projectKey: 'loopback|/srv/app', relativePath: '../escape' })).toBeUndefined();
  });

  it('lets content attachments through: pasted images and attached text name no file', () => {
    expect(ownRemoteDrop('loopback', { type: 'sendMessage', content: [{ type: 'text', text: 'loopback|/srv/app' }] })).toBeUndefined();
    const image = { type: 'sendMessage', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }, { type: 'text', text: 'see this' }] };
    expect(crossedByViewMessage('loopback', image)).toBeUndefined();
    expect(crossedByViewMessage('loopback', { type: 'sendMessage', content: [{ type: 'text', text: 'c:\\work\\app\\a.ts' }] })).toBeUndefined();
  });
});
