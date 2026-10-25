import { describe, expect, it } from 'vitest';
import { CoreHost } from '../core-host';
import { chatOfSelectedProject, remoteSelection } from '../remote/remote-selection';

interface FakeCore {
  readonly authority: string;
  readonly ready: Promise<void>;
  isReady(): boolean;
  hasEnded(): boolean;
  dispose(): Promise<void>;
  ended?: boolean;
}

interface Chat {
  readonly id: string;
  readonly authority: string;
  readonly projectKey: string;
}

const LOCAL_PROJECT = 'C:\\work\\local';
const REMOTE_PROJECT = 'loopback|C:\\work\\remote';
const LOCAL_CHAT: Chat = { id: 'local-chat', authority: 'local', projectKey: LOCAL_PROJECT };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// Main's selection over the loopback authority's CoreHost, whose reopening ends with coreOpened as openRemoteChats' does; a
// chat selected moves the selected project to its own, as showChat does.
function desktop(opened?: Promise<void>) {
  let selectedProject: string | undefined = LOCAL_PROJECT;
  let selectedChat: Chat | undefined = LOCAL_CHAT;
  const selections: Array<readonly [FakeCore, string]> = [];
  const host: CoreHost<FakeCore> = new CoreHost<FakeCore>({
    start: () => {
      const core: FakeCore = { authority: 'loopback', ready: Promise.resolve(), isReady: () => !core.ended, hasEnded: () => core.ended === true, dispose: async () => undefined };
      return core;
    },
    openTabs: async () => {
      const core = host.current();
      if (core) await selection.coreOpened(core);
    },
    retainTabStates: () => undefined,
    log: () => undefined,
    drainTimeoutMs: 100,
    haltedChanged: () => undefined,
  });
  const selectChat = (chat: Chat): void => {
    selectedChat = chat;
    selectedProject = chat.projectKey;
  };
  const selection = remoteSelection<FakeCore, Chat>({
    selectedProject: () => selectedProject,
    selectedChat: () => selectedChat,
    host: (authority) => (authority === 'loopback' ? host : undefined),
    showProject: (key) => {
      selectedProject = key;
    },
    selectChatOf: async (core, key) => {
      selections.push([core, key]);
      await opened;
      selectChat({ id: `new:${selections.length}`, authority: core.authority, projectKey: key });
    },
  });
  // what the title bar pairs: the selected project and the chat it may name with it
  const breadcrumb = (): readonly [string | undefined, string | undefined] => [selectedProject, chatOfSelectedProject(selectedProject, selectedChat)?.id];
  return { host, selection, selections, selectChat, breadcrumb };
}

async function started(host: CoreHost<FakeCore>): Promise<FakeCore> {
  const core = host.start();
  await core.ready;
  await host.openTabs();
  return core;
}

describe('remote project selection', () => {
  it('adding a remote project while its core runs selects its chat, and the title never pairs it with another chat', async () => {
    const opening = deferred();
    const { host, selection, selections, breadcrumb } = desktop(opening.promise);
    const core = await started(host);

    const selecting = selection.select(REMOTE_PROJECT);
    expect(selections).toEqual([[core, REMOTE_PROJECT]]);
    // the local chat still shows while the project's chat opens: the title names the project alone
    expect(breadcrumb()).toEqual([REMOTE_PROJECT, undefined]);
    opening.resolve();
    await selecting;
    expect(breadcrumb()).toEqual([REMOTE_PROJECT, 'new:1']);
  });

  it('a remote project selected while its core is down gets its chat once the core starts', async () => {
    const { host, selection, selections, breadcrumb } = desktop();
    await selection.select(REMOTE_PROJECT);
    expect(selections).toEqual([]);
    expect(breadcrumb()).toEqual([REMOTE_PROJECT, undefined]);

    const core = await started(host);
    expect(selections).toEqual([[core, REMOTE_PROJECT]]);
    expect(breadcrumb()).toEqual([REMOTE_PROJECT, 'new:1']);
  });

  it('a remote project selected while its core restarts gets its chat from the core that replaces it', async () => {
    const { host, selection, selections, breadcrumb } = desktop();
    const crashed = await started(host);
    crashed.ended = true;
    await selection.select(REMOTE_PROJECT);
    expect(selections).toEqual([]);

    await host.restart(crashed);
    expect(selections).toEqual([[host.current(), REMOTE_PROJECT]]);
    expect(host.current()).not.toBe(crashed);
    expect(breadcrumb()).toEqual([REMOTE_PROJECT, 'new:1']);
  });

  it('a chat the user selects before the core starts stays selected', async () => {
    const { host, selection, selections, selectChat, breadcrumb } = desktop();
    await selection.select(REMOTE_PROJECT);
    selectChat(LOCAL_CHAT);

    await started(host);
    expect(selections).toEqual([]);
    expect(breadcrumb()).toEqual([LOCAL_PROJECT, LOCAL_CHAT.id]);
  });
});
