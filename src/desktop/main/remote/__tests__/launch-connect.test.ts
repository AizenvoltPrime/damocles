import { describe, expect, it } from 'vitest';
import { authoritiesToConnectAtLaunch } from '../launch-connect';

const prod = 'ssh+prod1|/srv/app';
const prodOther = 'ssh+prod1|/srv/billing';
const staging = 'ssh+stage|/srv/app';
const idle = 'ssh+idle|/home/u/x';
const loop = 'loopback|/tmp/l';
const local = '/home/me/local';
const all = [prod, prodOther, staging, idle, loop];
const none = { remoteProjectKeys: all, editorAuthorities: [], terminalAuthorities: [], chatAuthorities: [], selectedProjectKey: undefined };

describe('authoritiesToConnectAtLaunch', () => {
  it('connects nothing when no remote view was restored and a local project was selected', () => {
    expect(authoritiesToConnectAtLaunch({ ...none, editorAuthorities: ['local'], selectedProjectKey: local })).toEqual([]);
  });

  it('connects the hosts of restored editor tabs, terminals and chats, once each', () => {
    expect(authoritiesToConnectAtLaunch({ ...none, editorAuthorities: ['ssh+prod1', 'ssh+prod1', 'local'] })).toEqual(['ssh+prod1']);
    expect(authoritiesToConnectAtLaunch({ ...none, terminalAuthorities: ['ssh+stage'] })).toEqual(['ssh+stage']);
    expect(authoritiesToConnectAtLaunch({ ...none, chatAuthorities: ['loopback'] })).toEqual(['loopback']);
  });

  it('connects the last selected project\'s host', () => {
    expect(authoritiesToConnectAtLaunch({ ...none, selectedProjectKey: staging })).toEqual(['ssh+stage']);
  });

  it('never connects a host whose projects are no longer listed (the remote gate, a removed project)', () => {
    expect(authoritiesToConnectAtLaunch({ remoteProjectKeys: [], editorAuthorities: ['ssh+prod1'], terminalAuthorities: ['ssh+prod1'], chatAuthorities: ['ssh+stage'], selectedProjectKey: prod })).toEqual([]);
  });

  it('keeps the projects list\'s order and leaves the idle host out', () => {
    expect(authoritiesToConnectAtLaunch({ ...none, editorAuthorities: ['loopback'], terminalAuthorities: ['ssh+stage'], selectedProjectKey: prod })).toEqual(['ssh+prod1', 'ssh+stage', 'loopback']);
  });
});
