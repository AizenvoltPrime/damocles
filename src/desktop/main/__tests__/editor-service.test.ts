import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PanelHost } from '../../../platform/window-service';
import type { SettingsSectionId } from '../../../shared/settings-sections';
import { EDITOR_MAX_DOCUMENT_BYTES, type ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { resolveChatTab, type ChatTabSources } from '../chat-tab-target';
import { fileBody, fileDocument, languageIdForName, memoryDocument, textBody } from '../platform/editor-document';
import { createDesktopEditorService, type ChatTabMessenger } from '../platform/editor-service';
import type { EditorPane } from '../editor-pane';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-editor-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string | Buffer): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('editor documents', () => {
  it('sends a file over 1 MB as text with its language', async () => {
    const content = `export const big = '${'x'.repeat(1024 * 1024 + 10)}';\n`;
    const doc = await fileDocument(write('big.ts', content));
    expect(doc).toEqual({ name: 'big.ts', path: path.join(dir, 'big.ts'), body: { kind: 'text', content, languageId: 'typescript' } });
  });

  it('refuses a file over the limit from its size without reading it', async () => {
    const file = path.join(dir, 'huge.log');
    const handle = fs.openSync(file, 'w');
    fs.ftruncateSync(handle, EDITOR_MAX_DOCUMENT_BYTES + 1);
    fs.closeSync(handle);
    const open = vi.spyOn(fs.promises, 'open');
    try {
      expect(await fileBody(file, 'plaintext')).toEqual({ kind: 'tooLarge', bytes: EDITOR_MAX_DOCUMENT_BYTES + 1, limitBytes: EDITOR_MAX_DOCUMENT_BYTES });
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it('never sends content with a NUL byte in the first 8000 bytes', async () => {
    const early = Buffer.concat([Buffer.from('PNG'), Buffer.from([0]), Buffer.alloc(100, 0x41)]);
    expect(await fileBody(write('image.png', early), 'plaintext')).toEqual({ kind: 'binary' });
    const late = Buffer.concat([Buffer.alloc(8000, 0x41), Buffer.from([0])]);
    expect((await fileBody(write('late.txt', late), 'plaintext')).kind).toBe('text');
  });

  // Opening a FIFO would park a libuv thread until a writer appears.
  it.skipIf(process.platform === 'win32')('refuses a FIFO without opening it', async () => {
    const fifo = path.join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(await fileBody(fifo, 'plaintext')).toEqual({ kind: 'unreadable', error: `${fifo} is not a file` });
  });

  it('reads a file larger than one read chunk whole', async () => {
    const content = 'y'.repeat(200 * 1024);
    expect(await fileBody(write('chunks.txt', content), 'plaintext')).toEqual({ kind: 'text', content, languageId: 'plaintext' });
  });

  it('shows a missing file as empty text', async () => {
    expect(await fileBody(path.join(dir, 'absent.py'), 'python')).toEqual({ kind: 'text', content: '', languageId: 'python' });
  });

  it('reports other read errors as unreadable', async () => {
    const body = await fileBody(dir, 'plaintext');
    expect(body.kind).toBe('unreadable');
  });

  it('applies the size and NUL rules to in-memory text', () => {
    expect(textBody('a\0b', 'plaintext')).toEqual({ kind: 'binary' });
    const over = 'é'.repeat(EDITOR_MAX_DOCUMENT_BYTES / 2 + 1);
    expect(textBody(over, 'plaintext')).toEqual({ kind: 'tooLarge', bytes: EDITOR_MAX_DOCUMENT_BYTES + 2, limitBytes: EDITOR_MAX_DOCUMENT_BYTES });
    expect(memoryDocument('abc-original-app.tsx', 'x')).toEqual({ name: 'abc-original-app.tsx', body: { kind: 'text', content: 'x', languageId: 'typescript' } });
  });

  it('decodes a UTF-8 or UTF-16 byte order mark as VS Code does, leaving the mark out of the text', async () => {
    const text = 'Καλημέρα\r\n';
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    for (const [name, bytes] of [['le.ps1', le], ['be.txt', be], ['bom.md', utf8]] as const) {
      const body = await fileBody(write(name, bytes), 'plaintext');
      expect(body, name).toEqual({ kind: 'text', content: text, languageId: 'plaintext' });
    }
  });

  it('sniffs in-memory text for NUL in its first 8000 bytes, not characters', () => {
    const late = `${'é'.repeat(7000)}\0`;
    expect(textBody(late, 'plaintext').kind).toBe('text');
    expect(textBody(`${'é'.repeat(3000)}\0`, 'plaintext')).toEqual({ kind: 'binary' });
  });

  it('reads a file as text for the editor, refusing what it cannot show', async () => {
    const huge = path.join(dir, 'huge-read.log');
    const handle = fs.openSync(huge, 'w');
    fs.ftruncateSync(handle, EDITOR_MAX_DOCUMENT_BYTES + 1);
    fs.closeSync(handle);
    const service = createDesktopEditorService({} as ChatTabMessenger, () => ({}) as EditorPane, () => undefined);

    await expect(service.readText(write('read.ts', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const a = 1;\n')])))).resolves.toBe('const a = 1;\n');
    await expect(service.readText(huge)).rejects.toThrow('over the');
    await expect(service.readText(write('read.bin', Buffer.from([1, 0, 2])))).rejects.toThrow('binary');
    await expect(service.readText(path.join(dir, 'absent-read.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps file names to Monaco language ids', () => {
    expect(languageIdForName('constructor')).toBe('plaintext');
    expect(languageIdForName('toString')).toBe('plaintext');
    expect(languageIdForName('C:\\src\\Main.CS')).toBe('csharp');
    expect(languageIdForName('/x/Dockerfile')).toBe('dockerfile');
    expect(languageIdForName('schema.proto')).toBe('proto');
    expect(languageIdForName('settings.jsonc')).toBe('json');
    expect(languageIdForName('Cargo.toml')).toBe('plaintext');
    expect(languageIdForName('README')).toBe('plaintext');
  });
});

function fakeHost(name: string): PanelHost {
  return { reveal: vi.fn(), name } as unknown as PanelHost;
}

function sources(init: { panels: Array<[string, PanelHost]>; selected?: unknown; chats: unknown[]; opened?: PanelHost }): ChatTabSources & { openChat: ReturnType<typeof vi.fn> } {
  const panels = new Map(init.panels.map(([id, host]) => [id, { host }]));
  return {
    panels: () => panels,
    selected: () => init.selected,
    chats: () => init.chats,
    openChat: vi.fn(async () => {
      if (!init.opened) throw new Error('unexpected open');
      panels.set('host-9', { host: init.opened, webviewReady: Promise.resolve() } as { host: PanelHost });
      return 'host-9';
    }),
  };
}

describe('resolveChatTab', () => {
  const a = fakeHost('a');
  const b = fakeHost('b');
  // A chat whose panel core has not registered yet, or no longer holds.
  const unregistered = fakeHost('closing');

  it('picks the requesting chat while it is loaded', async () => {
    const s = sources({ panels: [['host-1', a], ['host-2', b]], selected: a, chats: [a, b] });
    expect(await resolveChatTab(s, 'host-2')).toEqual({ panelId: 'host-2', host: b });
  });

  it('falls back to the selected chat, then the first loaded chat', async () => {
    expect(await resolveChatTab(sources({ panels: [['host-1', a], ['host-2', b]], selected: b, chats: [a, b] }), 'host-7')).toEqual({ panelId: 'host-2', host: b });
    expect(await resolveChatTab(sources({ panels: [['host-1', a], ['host-2', b]], chats: [unregistered, b, a] }), undefined)).toEqual({ panelId: 'host-2', host: b });
  });

  it('opens a chat in the selected project when none is loaded, after its webview is ready', async () => {
    const opened = fakeHost('new');
    const s = sources({ panels: [], selected: unregistered, chats: [unregistered], opened });
    expect(await resolveChatTab(s, 'host-1')).toEqual({ panelId: 'host-9', host: opened });
    expect(s.openChat).toHaveBeenCalledOnce();
  });
});

describe('desktop editor service (D15 routing)', () => {
  function service(): {
    editor: ReturnType<typeof createDesktopEditorService>;
    delivered: Array<[string | undefined, ExtensionToWebviewMessage]>;
    posted: Array<[string, ExtensionToWebviewMessage]>;
    pane: string[];
    settingsOpened: Array<SettingsSectionId | undefined>;
  } {
    const delivered: Array<[string | undefined, ExtensionToWebviewMessage]> = [];
    const posted: Array<[string, ExtensionToWebviewMessage]> = [];
    const pane: string[] = [];
    const settingsOpened: Array<SettingsSectionId | undefined> = [];
    const tabs: ChatTabMessenger = {
      deliver: async (panelId, message) => {
        delivered.push([panelId, message]);
        return 'host-3';
      },
      post: (panelId, message) => { posted.push([panelId, message]); },
    };
    const fakePane = {
      openPath: async (filePath: string, opts: { line?: number; focus: boolean; preview?: boolean }) => {
        pane.push(`openPath:${path.basename(filePath)}:${JSON.stringify(opts)}`);
      },
      openUntitled: (content: string, name: string, languageId: string, opts: { focus: boolean }) => {
        pane.push(`untitled:${name}:${languageId}:${content}:${String(opts.focus)}`);
      },
      showDiff: async (titleOf: (name: string) => string, filePath: string, _left: unknown, _right: unknown, opts: { focus: boolean }) => {
        const title = titleOf(path.basename(filePath));
        pane.push(`diff:${title}:${String(opts.focus)}`);
        return { close: () => { pane.push(`closeDiff:${title}`); } };
      },
      openSettingsFile: async (scope: string, key?: string) => {
        pane.push(`settings:${scope}:${key ?? ''}`);
      },
    } as unknown as EditorPane;
    return { editor: createDesktopEditorService(tabs, () => fakePane, (section) => { settingsOpened.push(section); }), delivered, posted, pane, settingsOpened };
  }

  it('opens files in the editor pane, focused only when the caller did not set preserveFocus, at a valid line only', async () => {
    const { editor, delivered, pane } = service();
    await editor.openFile('/w/lines.py', { line: 2, panelId: 'host-1' });
    await editor.openFile('/w/lines.py', { line: 0, preserveFocus: true });
    expect(pane).toEqual(['openPath:lines.py:{"focus":true,"line":2}', 'openPath:lines.py:{"focus":false}']);
    expect(delivered).toEqual([]);
  });

  it('opens a markdown preview, an untitled buffer with a bundled language only, and settings files in the pane', async () => {
    const { editor, delivered, pane } = service();
    await editor.showMarkdownPreview('/tmp/damocles-system-prompt.md', { panelId: 'host-4' });
    await editor.openUntitled('<p>hi</p>', 'html', { panelId: 'host-4' });
    await editor.openUntitled('x', 'brainfuck');
    await editor.openSettingsFile('project', { key: 'damocles.desktop.files.exclude' });
    expect(pane).toEqual([
      'openPath:damocles-system-prompt.md:{"focus":true,"preview":true}',
      'untitled:untitled.html:html:<p>hi</p>:true',
      'untitled:untitled.brainfuck:plaintext:x:true',
      'settings:project:damocles.desktop.files.exclude',
    ]);
    expect(delivered).toEqual([]);
  });

  it('shows a diff without an approval id in the pane, never in a chat', async () => {
    const { editor, delivered, pane } = service();
    const view = await editor.showDiff({ title: (name) => `${name} (At checkpoint ↔ Current)`, filePath: '/w/a.ts', left: { name: 'x-a.ts', content: 'a' }, right: { path: '/w/a.ts' }, purpose: 'checkpoint', panelId: 'host-2' });
    const agent = await editor.showDiff({ title: (name) => name, filePath: '/w/b.ts', left: { name: 'b.ts', content: 'a' }, right: { name: 'b2.ts', content: 'b' }, purpose: 'checkpoint', preserveFocus: true });
    await view.close();
    await agent.close();
    expect(pane).toEqual(['diff:a.ts (At checkpoint ↔ Current):true', 'diff:b.ts:false', 'closeDiff:a.ts (At checkpoint ↔ Current)', 'closeDiff:b.ts']);
    expect(delivered).toEqual([]);
  });

  it('posts an approval diff to the requesting chat, never to the pane, and closes it in the chat it went to, once', async () => {
    const { editor, delivered, posted, pane } = service();
    const file = write('edit.md', '# old\n');
    const view = await editor.showDiff({
      title: (name) => `${name} (Current ↔ Proposed)`,
      filePath: file,
      left: { path: file },
      right: { name: 'tool-1-proposed-edit.md', content: '# new\n' },
      purpose: 'proposal',
      panelId: 'host-2',
      approvalId: 'tool-1',
    });
    const [[panelId, message]] = delivered as [[string | undefined, Extract<ExtensionToWebviewMessage, { type: 'editorShowDiff' }>]];
    expect(panelId).toBe('host-2');
    expect(message).toMatchObject({
      type: 'editorShowDiff',
      title: 'edit.md (Current ↔ Proposed)',
      purpose: 'proposal',
      approvalId: 'tool-1',
      original: { name: 'edit.md', path: file, body: { kind: 'text', content: '# old\n', languageId: 'markdown' } },
      modified: { name: 'tool-1-proposed-edit.md', body: { kind: 'text', content: '# new\n', languageId: 'markdown' } },
    });
    expect(pane).toEqual([]);
    expect(posted).toEqual([]);
    await view.close();
    await view.close();
    expect(posted).toEqual([['host-3', { type: 'editorCloseView', viewId: message.viewId }]]);
  });

  it('reads the disk text, never an unsaved buffer', async () => {
    const { editor } = service();
    await expect(editor.readText(write('disk.ts', 'on disk\n'))).resolves.toBe('on disk\n');
  });

  it('opens host settings in the app settings at the section asked for, without a round trip through a chat', async () => {
    const { editor, delivered, settingsOpened } = service();
    await editor.openHostSettings('damocles.browser.devToolsPort', 'integrations');
    await editor.openHostSettings('damocles');
    expect(settingsOpened).toEqual(['integrations', undefined]);
    expect(delivered).toEqual([]);
  });
});
