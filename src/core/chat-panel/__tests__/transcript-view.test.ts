import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelHost } from "../../../platform/window-service";
import { VSCODE_HOST_CAPABILITIES, type ExtensionToWebviewMessage } from "../../../shared/types/messages";

vi.mock("../../logger", () => ({ log: vi.fn() }));

import { listMirroredSessions, mirroredProjectFolder, mirroredSessionFile, openTranscriptView } from "../transcript-view";
import { replaySessionFileReadOnly } from "../../pi-session/session-store";
import { initPiLoader } from "../../pi-session/pi-loader";

let userData: string;
let mirror: string;

// pi's one import per worker, which every replay and session row read awaits, so no test's own time includes it
beforeAll(async () => {
  expect(await initPiLoader()).not.toBeNull();
});

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "damocles-transcript-"));
  mirror = path.join(userData, "remote", "host1", "mirror", "0123abcd");
  fs.mkdirSync(mirror, { recursive: true });
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const at = "2026-01-01T00:00:00.000Z";
// A pi session file as the daemon's core wrote it, ending in a torn line, as a mirror copy taken mid-append does: pi's own
// SessionManager.open would append a newline to repair it.
const SESSION_TEXT = [
  { type: "session", version: 3, id: SESSION_ID, timestamp: at, cwd: "/srv/app" },
  { type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "list the files" }], timestamp: 1 } },
  { type: "message", id: "a1", parentId: "u1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "Here they are." }], provider: "openai", model: "gpt-x", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } },
].map((entry) => JSON.stringify(entry)).join("\n") + '\n{"type":"message","id":"u2","par';

// pi's own session file name, `<timestamp>_<session id>.jsonl`
const FILE_NAME = `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`;

function writeSession(): string {
  const file = path.join(mirror, FILE_NAME);
  fs.writeFileSync(file, SESSION_TEXT);
  fs.utimesSync(file, 1_000_000, 1_000_000);
  return file;
}

// A desktop panel host: main builds the page it is told to show, and the page's messages arrive through onMessage.
function host(): PanelHost & { posted: ExtensionToWebviewMessage[]; pages: unknown[]; send(message: unknown): void; next(type: string): Promise<void> } {
  const listeners = new Set<(message: unknown) => void>();
  const posted: ExtensionToWebviewMessage[] = [];
  const pages: unknown[] = [];
  const waiting: Array<{ type: string; resolve: () => void }> = [];
  return {
    posted,
    pages,
    send: (message) => {
      for (const listener of listeners) listener(message);
    },
    // settles at the next post of that type
    next: (type) => new Promise((resolve) => waiting.push({ type, resolve })),
    visible: true,
    active: true,
    retainsContextWhenHidden: true,
    column: undefined,
    cspSource: "",
    themeCssSource: () => "",
    setHtml: () => { throw new Error("a desktop host builds its own page"); },
    showPage: (page) => { pages.push(page); },
    postMessage: async (message) => {
      posted.push(message as ExtensionToWebviewMessage);
      const type = (message as ExtensionToWebviewMessage).type;
      for (const waiter of waiting.filter((entry) => entry.type === type)) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve();
      }
      return true;
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    onDispose: () => ({ dispose: () => undefined }),
    onDidChangeViewState: () => ({ dispose: () => undefined }),
    asResourceUri: (absolutePath) => absolutePath,
    setIcon: () => undefined,
    setTitle: () => undefined,
    setFolderLabel: () => undefined,
    reveal: () => undefined,
    close: () => undefined,
  };
}


describe("mirroredSessionFile", () => {
  it("accepts a session file of that host's mirror and refuses every other path", async () => {
    const file = writeSession();
    expect(await mirroredSessionFile(userData, "host1", file)).toEqual({ path: fs.realpathSync.native(file), sessionId: SESSION_ID });
    // another host's mirror, a relative path, a bad host id, an unsafe id, a file outside every mirror
    fs.mkdirSync(path.join(userData, "remote", "host2", "mirror"), { recursive: true });
    expect(await mirroredSessionFile(userData, "host2", file)).toBeUndefined();
    expect(await mirroredSessionFile(userData, "host1", path.relative(process.cwd(), file))).toBeUndefined();
    expect(await mirroredSessionFile(userData, "../host1", file)).toBeUndefined();
    const plain = path.join(mirror, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(plain, SESSION_TEXT);
    expect(await mirroredSessionFile(userData, "host1", plain)).toEqual({ path: fs.realpathSync.native(plain), sessionId: SESSION_ID });
    const unsafe = path.join(mirror, ".hidden.jsonl");
    fs.writeFileSync(unsafe, "");
    expect(await mirroredSessionFile(userData, "host1", unsafe)).toBeUndefined();
    const outside = path.join(userData, FILE_NAME);
    fs.writeFileSync(outside, SESSION_TEXT);
    expect(await mirroredSessionFile(userData, "host1", outside)).toBeUndefined();
    expect(await mirroredSessionFile(userData, "host1", path.join(mirror, "..", "..", "..", "..", FILE_NAME))).toBeUndefined();
    expect(await mirroredSessionFile(userData, "host1", path.join(mirror, "missing.jsonl"))).toBeUndefined();
    // a session's own agent files sit deeper, and so does a file straight in the mirror's root
    const agents = path.join(mirror, SESSION_ID, "subagents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, FILE_NAME), SESSION_TEXT);
    expect(await mirroredSessionFile(userData, "host1", path.join(agents, FILE_NAME))).toBeUndefined();
    fs.writeFileSync(path.join(path.dirname(mirror), FILE_NAME), SESSION_TEXT);
    expect(await mirroredSessionFile(userData, "host1", path.join(path.dirname(mirror), FILE_NAME))).toBeUndefined();
  });
});

const DESKTOP_CAPABILITIES = { ...VSCODE_HOST_CAPABILITIES, historyInPanel: false, settingsInPanel: false, windowLayout: true };
const transcriptOf = (file: string) => ({
  file,
  capabilities: DESKTOP_CAPABILITIES,
  locale: () => "el",
  replay: (post: (message: ExtensionToWebviewMessage) => void, signal: AbortSignal) => replaySessionFileReadOnly(file, SESSION_ID, post, signal),
});

describe("openTranscriptView", () => {
  it("names the chat by its session list row after the replay, as a live chat's ready does, with the host's capabilities first", async () => {
    const file = writeSession();
    fs.appendFileSync(file, `
${JSON.stringify({ type: "session_info", id: "n1", parentId: "a1", timestamp: at, name: "Mirrored title" })}
`);
    const before = { bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs };
    const view = host();
    openTranscriptView(view, transcriptOf(file));
    const named = view.next("storedSessions");
    view.send({ type: "ready" });
    await named;
    const types = view.posted.map((message) => message.type);
    expect(types[0]).toBe("hostCapabilities");
    expect(view.posted[0]).toEqual({ type: "hostCapabilities", capabilities: DESKTOP_CAPABILITIES });
    expect(types.indexOf("done")).toBeLessThan(types.indexOf("storedSessions"));
    const listed = view.posted.at(-1);
    expect(listed?.type === "storedSessions" && listed.sessions.map((session) => [session.id, session.customTitle || session.aiTitle || session.preview])).toEqual([[SESSION_ID, "Mirrored title"]]);
    expect(fs.readFileSync(file).equals(before.bytes)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  });

  it("replays the mirrored file on ready, refuses a send, and writes nothing to the file", async () => {
    const file = writeSession();
    const before = { bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs };
    const view = host();
    openTranscriptView(view, transcriptOf(file));
    expect(view.pages).toEqual([{ kind: "chat" }]);
    const named = view.next("storedSessions");
    view.send({ type: "ready" });
    await named;
    expect(view.posted.at(-1)?.type).toBe("storedSessions");
    const types = view.posted.map((message) => message.type);
    expect(types.slice(0, 3)).toEqual(["hostCapabilities", "languageChange", "sessionCleared"]);
    expect(view.posted[1]).toEqual({ type: "languageChange", locale: "el" });
    expect(types).toContain("userReplay");
    expect(types.at(-2)).toBe("done");
    expect(view.posted.find((message) => message.type === "userReplay")).toMatchObject({ content: "list the files" });
    const replayed = view.posted.length;
    view.send({ type: "sendMessage", text: "rm -rf /", sessionId: SESSION_ID });
    view.send({ type: "setPermissionMode", mode: "bypassPermissions" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.posted).toHaveLength(replayed);
    expect(fs.readFileSync(file).equals(before.bytes)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readdirSync(mirror)).toEqual([FILE_NAME]);
  });

  it("replays again on a reloaded page's ready", async () => {
    const file = writeSession();
    const view = host();
    openTranscriptView(view, transcriptOf(file));
    const named = view.next("storedSessions");
    view.send({ type: "ready" });
    await named;
    const first = view.posted.length;
    const namedAgain = view.next("storedSessions");
    view.send({ type: "ready" });
    await namedAgain;
    expect(view.posted.length).toBe(first * 2);
  });

  it("gives a page reloaded mid-replay one replay, the later ready's", async () => {
    const file = writeSession();
    const view = host();
    openTranscriptView(view, transcriptOf(file));
    const named = view.next("storedSessions");
    view.send({ type: "ready" });
    view.send({ type: "ready" });
    await named;
    const count = (type: string): number => view.posted.filter((message) => message.type === type).length;
    expect([count("userReplay"), count("done"), count("storedSessions")]).toEqual([1, 1, 1]);
  });
});

describe("the offline chat list's mirrored chats", () => {
  // every file under the mirror with its bytes and mtime, which a read-only listing leaves as they were
  const snapshot = (): Record<string, { bytes: string; mtimeMs: number }> => Object.fromEntries(
    (fs.readdirSync(path.join(userData, "remote"), { recursive: true }) as string[])
      .map((name) => path.join(userData, "remote", name))
      .filter((file) => fs.statSync(file).isFile())
      .map((file) => [file, { bytes: fs.readFileSync(file).toString("base64"), mtimeMs: fs.statSync(file).mtimeMs }]),
  );

  it("lists each mirrored session with its title and time, newest first, narrowed by a search, and writes nothing", async () => {
    writeSession();
    const OTHER_ID = "66666666-7777-4888-8999-000000000000";
    const named = [
      { type: "session", version: 3, id: OTHER_ID, timestamp: "2026-02-01T00:00:00.000Z", cwd: "/srv/app" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-02-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "fix the build" }], timestamp: Date.parse("2026-02-02T10:00:00.000Z") } },
      { type: "session_info", id: "n1", parentId: "u1", timestamp: "2026-02-01T00:00:00.000Z", name: "Build fix" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    fs.writeFileSync(path.join(mirror, `2026-02-01T00-00-00-000Z_${OTHER_ID}.jsonl`), named);
    // an agent file in its session's folder and a stray file are not chats
    fs.mkdirSync(path.join(mirror, SESSION_ID, "subagents"), { recursive: true });
    fs.writeFileSync(path.join(mirror, SESSION_ID, "subagents", "agent-1.jsonl"), SESSION_TEXT);
    fs.writeFileSync(path.join(mirror, "notes.txt"), "x");
    const before = snapshot();

    const rows = await listMirroredSessions(mirror, "");
    expect(rows.map((row) => [row.id, row.customTitle ?? row.aiTitle ?? row.preview, row.timestamp])).toEqual([
      [OTHER_ID, "Build fix", Date.parse("2026-02-02T10:00:00.000Z")],
      [SESSION_ID, "list the files", 2],
    ]);
    expect((await listMirroredSessions(mirror, "BUILD")).map((row) => row.id)).toEqual([OTHER_ID]);
    // the torn last line stays torn: nothing was repaired, migrated, indexed or added
    expect(snapshot()).toEqual(before);
  });

  it("takes only a project folder of that host's mirror, and a folder the mirror holds nothing for lists nothing", async () => {
    expect(await mirroredProjectFolder(userData, "host1", mirror)).toBe(fs.realpathSync.native(mirror));
    expect(await mirroredProjectFolder(userData, "host1", path.join(path.dirname(mirror), "feedbeef"))).toBeNull();
    expect(await mirroredProjectFolder(userData, "host2", mirror)).toBeUndefined();
    expect(await mirroredProjectFolder(userData, "host1", path.dirname(mirror))).toBeUndefined();
    expect(await mirroredProjectFolder(userData, "host1", path.join(mirror, "nested"))).toBeUndefined();
    expect(await mirroredProjectFolder(userData, "host1", path.join(mirror, "..", "..", "..", "..", "x"))).toBeUndefined();
    expect(await mirroredProjectFolder(userData, "../host1", mirror)).toBeUndefined();
    expect(await mirroredProjectFolder(userData, "host1", "relative")).toBeUndefined();
    // a link that leaves the mirror
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "damocles-outside-"));
    try {
      const link = path.join(path.dirname(mirror), "linked");
      fs.symlinkSync(outside, link, "junction");
      expect(await mirroredProjectFolder(userData, "host1", link)).toBeUndefined();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
