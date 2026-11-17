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
import { log } from "../../logger";

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

  it("accepts a worktree chat's session file in its project's worktree.<id> or adopted.<id> folder, and no other folder or depth", async () => {
    const adopted = path.join(mirror, "adopted.gone0002");
    fs.mkdirSync(adopted, { recursive: true });
    fs.writeFileSync(path.join(adopted, FILE_NAME), SESSION_TEXT);
    expect(await mirroredSessionFile(userData, "host1", path.join(adopted, FILE_NAME))).toEqual({ path: fs.realpathSync.native(path.join(adopted, FILE_NAME)), sessionId: SESSION_ID });
    const worktree = path.join(mirror, "worktree.live0001");
    fs.mkdirSync(path.join(worktree, SESSION_ID, "subagents"), { recursive: true });
    const file = path.join(worktree, FILE_NAME);
    fs.writeFileSync(file, SESSION_TEXT);
    expect(await mirroredSessionFile(userData, "host1", file)).toEqual({ path: fs.realpathSync.native(file), sessionId: SESSION_ID });
    fs.writeFileSync(path.join(worktree, SESSION_ID, "subagents", FILE_NAME), SESSION_TEXT);
    expect(await mirroredSessionFile(userData, "host1", path.join(worktree, SESSION_ID, "subagents", FILE_NAME))).toBeUndefined();
    for (const name of ["worktree.NOTANID", "worktree.live00012", "other"]) {
      fs.mkdirSync(path.join(mirror, name), { recursive: true });
      fs.writeFileSync(path.join(mirror, name, FILE_NAME), SESSION_TEXT);
      expect(await mirroredSessionFile(userData, "host1", path.join(mirror, name, FILE_NAME))).toBeUndefined();
    }
    // a worktree folder of another host's mirror
    const elsewhere = path.join(userData, "remote", "host2", "mirror", "0123abcd", "worktree.live0001");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, FILE_NAME), SESSION_TEXT);
    expect(await mirroredSessionFile(userData, "host1", path.join(elsewhere, FILE_NAME))).toBeUndefined();
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

  it("gives a page reloaded mid-replay one replay, the later ready's, and logs no failure for the one it stopped", async () => {
    vi.mocked(log).mockClear();
    const file = writeSession();
    const view = host();
    openTranscriptView(view, transcriptOf(file));
    const named = view.next("storedSessions");
    view.send({ type: "ready" });
    view.send({ type: "ready" });
    await named;
    const count = (type: string): number => view.posted.filter((message) => message.type === type).length;
    expect([count("userReplay"), count("done"), count("storedSessions")]).toEqual([1, 1, 1]);
    expect(vi.mocked(log).mock.calls.map(([format]) => String(format)).filter((format) => format.startsWith("[transcript]"))).toEqual([]);
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

    const rows = await listMirroredSessions(mirror, "", "linux");
    expect(rows.map((row) => [row.id, row.customTitle ?? row.aiTitle ?? row.preview, row.timestamp])).toEqual([
      [OTHER_ID, "Build fix", Date.parse("2026-02-02T10:00:00.000Z")],
      [SESSION_ID, "list the files", 2],
    ]);
    expect((await listMirroredSessions(mirror, "BUILD", "linux")).map((row) => row.id)).toEqual([OTHER_ID]);
    // the torn last line stays torn: nothing was repaired, migrated, indexed or added
    expect(snapshot()).toEqual(before);
  });

  it("lists the project's worktree chats from its worktree.<id> folders with its own, each session once, and nothing from other folders", async () => {
    writeSession();
    const WORKTREE_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const worktreeChat = [
      { type: "session", version: 3, id: WORKTREE_ID, timestamp: "2026-03-01T00:00:00.000Z", cwd: "/home/dev/.damocles/worktrees/app-abc123/live0001" },
      { type: "custom", customType: "damocles.worktree", id: "w1", parentId: null, timestamp: "2026-03-01T00:00:00.000Z", data: { worktreeId: "live0001", projectPath: "/srv/app", place: "worktree" } },
      { type: "message", id: "u1", parentId: "w1", timestamp: "2026-03-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "work in the worktree" }], timestamp: Date.parse("2026-03-02T10:00:00.000Z") } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const worktree = path.join(mirror, "worktree.live0001");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, `2026-03-01T00-00-00-000Z_${WORKTREE_ID}.jsonl`), worktreeChat);
    // the project's own session listed again from a worktree folder (colliding session folders) lists once, as its own: its entry
    // names another project, so the worktree folder's rule keeps it and only the one-row-per-session check leaves it out
    const otherProjects = { type: "custom", customType: "damocles.worktree", id: "w9", parentId: "a1", timestamp: at, data: { worktreeId: "live0001", projectPath: "/srv/other", place: "worktree" } };
    fs.writeFileSync(path.join(worktree, FILE_NAME), `${SESSION_TEXT.slice(0, SESSION_TEXT.lastIndexOf("\n") + 1)}${JSON.stringify(otherProjects)}\n`);
    // a folder that is no worktree's, and an agent file in a worktree chat's session folder, are not chats
    fs.mkdirSync(path.join(mirror, "worktree.NOTANID"), { recursive: true });
    fs.writeFileSync(path.join(mirror, "worktree.NOTANID", `2026-04-01T00-00-00-000Z_${WORKTREE_ID.replace("7", "9")}.jsonl`), worktreeChat);
    fs.mkdirSync(path.join(worktree, WORKTREE_ID, "subagents"), { recursive: true });
    fs.writeFileSync(path.join(worktree, WORKTREE_ID, "subagents", "agent-1.jsonl"), SESSION_TEXT);
    const before = snapshot();

    const rows = await listMirroredSessions(mirror, "", "linux");
    expect(rows.map((row) => [row.id, row.preview])).toEqual([
      [WORKTREE_ID, "work in the worktree"],
      [SESSION_ID, "list the files"],
    ]);
    expect((await listMirroredSessions(mirror, "worktree", "linux")).map((row) => row.id)).toEqual([WORKTREE_ID]);
    expect(snapshot()).toEqual(before);
  });

  // docs/invariants.md "Worktree chats", Ownership: a chat worktree's folder holds the project's sessions, which have a worktree
  // entry, and its own chats from when it was open as a project, which never record one; a deleted adopted worktree's are the
  // project's history (rule 18).
  it("lists from a worktree.<id> folder only the sessions with a worktree entry, and from an adopted.<id> folder only those without", async () => {
    const chat = (id: string, cwd: string, text: string, entry: boolean): string => [
      { type: "session", version: 3, id, timestamp: "2026-03-01T00:00:00.000Z", cwd },
      ...(entry ? [{ type: "custom", customType: "damocles.worktree", id: "w1", parentId: null, timestamp: "2026-03-01T00:00:00.000Z", data: { worktreeId: "live0001", projectPath: "/srv/app", place: "worktree" } }] : []),
      { type: "message", id: "u1", parentId: entry ? "w1" : null, timestamp: "2026-03-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse("2026-03-02T10:00:00.000Z") } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const ids = { cleared: "77777777-8888-4999-8aaa-000000000001", own: "77777777-8888-4999-8aaa-000000000002", history: "77777777-8888-4999-8aaa-000000000003", adoptedOwn: "77777777-8888-4999-8aaa-000000000004" };
    const worktree = path.join(mirror, "worktree.live0001");
    const adopted = path.join(mirror, "adopted.gone0002");
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(adopted, { recursive: true });
    const cwd = "/home/dev/.damocles/worktrees/app-abc123/live0001";
    fs.writeFileSync(path.join(worktree, `2026-03-01T00-00-00-000Z_${ids.cleared}.jsonl`), chat(ids.cleared, cwd, "cleared in the worktree", true));
    fs.writeFileSync(path.join(worktree, `2026-03-01T00-00-00-000Z_${ids.own}.jsonl`), chat(ids.own, cwd, "the worktree's own chat", false));
    fs.writeFileSync(path.join(adopted, `2026-03-01T00-00-00-000Z_${ids.history}.jsonl`), chat(ids.history, "/srv/app-gone", "the adopted worktree's chat", false));
    fs.writeFileSync(path.join(adopted, `2026-03-01T00-00-00-000Z_${ids.adoptedOwn}.jsonl`), chat(ids.adoptedOwn, "/srv/app-gone", "its own worktree's chat", true));

    expect((await listMirroredSessions(mirror, "", "linux")).map((row) => row.id).sort()).toEqual([ids.cleared, ids.history].sort());
  });

  // A chat worktree open as a project mirrors its own session folder as that project's, where its project's chats live too.
  it("lists from a project's own folder the sessions that belong to the folder they were created in, a relocation's old paths mapped", async () => {
    const chat = (id: string, cwd: string, entryProject?: string): string => [
      { type: "session", version: 3, id, timestamp: "2026-03-01T00:00:00.000Z", cwd },
      ...(entryProject !== undefined ? [{ type: "custom", customType: "damocles.worktree", id: "w1", parentId: null, timestamp: "2026-03-01T00:00:00.000Z", data: { worktreeId: "live0001", projectPath: entryProject, place: "worktree" } }] : []),
      { type: "message", id: "u1", parentId: entryProject !== undefined ? "w1" : null, timestamp: "2026-03-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: id }], timestamp: Date.parse("2026-03-02T10:00:00.000Z") } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const worktree = "/home/dev/.damocles/worktrees/app-abc123/live0001";
    const ids = { own: "77777777-8888-4999-8aaa-000000000011", projects: "77777777-8888-4999-8aaa-000000000012", handedOff: "77777777-8888-4999-8aaa-000000000013", moved: "77777777-8888-4999-8aaa-000000000014" };
    const write = (id: string, text: string): void => fs.writeFileSync(path.join(mirror, `2026-03-01T00-00-00-000Z_${id}.jsonl`), text);
    // as the worktree's own folder: its own chat, and one of its project's that started there
    write(ids.own, chat(ids.own, worktree));
    write(ids.projects, chat(ids.projects, worktree, "/srv/app"));
    expect((await listMirroredSessions(mirror, "", "linux")).map((row) => row.id)).toEqual([ids.own]);
    // as the project's own folder: a chat handed off into a worktree, and one made before the project moved from /srv/old
    write(ids.handedOff, chat(ids.handedOff, "/srv/app", "/srv/app"));
    write(ids.moved, chat(ids.moved, "/srv/old", "/srv/app"));
    const moved = (folder: string): string => (folder === "/srv/old" ? "/srv/app" : folder);
    expect((await listMirroredSessions(mirror, "", "linux", moved)).map((row) => row.id).sort()).toEqual([ids.own, ids.handedOff, ids.moved].sort());
  });

  // The mirror sync replaces a host's folders while a list reads them.
  it("lists the rest when a worktree folder goes while the list reads the project's folder", async () => {
    writeSession();
    const worktree = path.join(mirror, "worktree.live0001");
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, `2026-03-01T00-00-00-000Z_${SESSION_ID.replace("1", "9")}.jsonl`), SESSION_TEXT);
    const readdir = fs.promises.readdir.bind(fs.promises) as (folder: string, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
    const spy = vi.spyOn(fs.promises, "readdir").mockImplementationOnce((async (folder: string, options: { withFileTypes: true }) => {
      const entries = await readdir(folder, options);
      fs.rmSync(worktree, { recursive: true, force: true });
      return entries;
    }) as typeof fs.promises.readdir);
    try {
      expect((await listMirroredSessions(mirror, "", "linux")).map((row) => row.id)).toEqual([SESSION_ID]);
    } finally {
      spy.mockRestore();
    }
  });

  // Both paths come from the host, so the host's rules decide whether they name one folder, whatever this computer folds.
  it("compares the folders a session names by the path rules of the host's OS", async () => {
    const chat = (id: string, cwd: string, entryProject: string): string => [
      { type: "session", version: 3, id, timestamp: "2026-03-01T00:00:00.000Z", cwd },
      { type: "custom", customType: "damocles.worktree", id: "w1", parentId: null, timestamp: "2026-03-01T00:00:00.000Z", data: { worktreeId: "live0001", projectPath: entryProject, place: "project" } },
      { type: "message", id: "u1", parentId: "w1", timestamp: "2026-03-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: id }], timestamp: Date.parse("2026-03-02T10:00:00.000Z") } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const ids = { windows: "77777777-8888-4999-8aaa-000000000021", posix: "77777777-8888-4999-8aaa-000000000022" };
    fs.writeFileSync(path.join(mirror, `2026-03-01T00-00-00-000Z_${ids.windows}.jsonl`), chat(ids.windows, "C:\\srv\\app", "c:\\srv\\App"));
    fs.writeFileSync(path.join(mirror, `2026-03-01T00-00-00-000Z_${ids.posix}.jsonl`), chat(ids.posix, "/srv/App", "/srv/app"));
    expect((await listMirroredSessions(mirror, "", "win32")).map((row) => row.id)).toContain(ids.windows);
    expect((await listMirroredSessions(mirror, "", "linux")).map((row) => row.id)).not.toContain(ids.posix);
  });

  // pi's session directory name is a lossy encoding of the folder, so the host's /srv/a-b and /srv/a/b share one, which both
  // projects' mirror folders copy whole.
  it("lists from a project's own folder only the chats its header or worktree entry gives the project, not a colliding folder's", async () => {
    const chat = (id: string, cwd: string, entryProject?: string): string => [
      { type: "session", version: 3, id, timestamp: "2026-03-01T00:00:00.000Z", cwd },
      ...(entryProject !== undefined ? [{ type: "custom", customType: "damocles.worktree", id: "w1", parentId: null, timestamp: "2026-03-01T00:00:00.000Z", data: { worktreeId: "live0001", projectPath: entryProject, place: "worktree" } }] : []),
      { type: "message", id: "u1", parentId: entryProject !== undefined ? "w1" : null, timestamp: "2026-03-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: id }], timestamp: Date.parse("2026-03-02T10:00:00.000Z") } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const ids = { own: "77777777-8888-4999-8aaa-000000000031", colliding: "77777777-8888-4999-8aaa-000000000032", collidingHandedOff: "77777777-8888-4999-8aaa-000000000033", ownHandedOff: "77777777-8888-4999-8aaa-000000000034", stopped: "77777777-8888-4999-8aaa-000000000035" };
    const write = (id: string, text: string): void => fs.writeFileSync(path.join(mirror, `2026-03-01T00-00-00-000Z_${id}.jsonl`), text);
    write(ids.own, chat(ids.own, "/srv/a-b"));
    write(ids.ownHandedOff, chat(ids.ownHandedOff, "/srv/a-b", "/srv/a-b"));
    write(ids.colliding, chat(ids.colliding, "/srv/a/b"));
    write(ids.collidingHandedOff, chat(ids.collidingHandedOff, "/srv/a/b", "/srv/a/b"));
    // moved here by a relocation whose moves do not count yet: its header's folder has another session directory
    write(ids.stopped, chat(ids.stopped, "/srv/old"));
    const sorted = (rows: ReadonlyArray<{ id: string }>): string[] => rows.map((row) => row.id).sort();

    expect(sorted(await listMirroredSessions(mirror, "", "linux", undefined, "/srv/a-b"))).toEqual([ids.own, ids.ownHandedOff, ids.stopped].sort());
    expect(sorted(await listMirroredSessions(mirror, "", "linux", undefined, "/srv/a/b"))).toEqual([ids.colliding, ids.collidingHandedOff, ids.stopped].sort());
    // a moved project's chats name its old folder, which the host's relocation maps to the project
    expect(sorted(await listMirroredSessions(mirror, "", "linux", (folder) => (folder === "/srv/a/b" ? "/srv/a-b" : folder), "/srv/a-b"))).toEqual(Object.values(ids).sort());
    // a caller that names no project gets every chat of the folder, as before projects were named
    expect(sorted(await listMirroredSessions(mirror, "", "linux"))).toEqual(Object.values(ids).sort());
  });

  it("tells colliding folders apart by the host's path rules", async () => {
    const chat = (id: string, cwd: string): string => [
      { type: "session", version: 3, id, timestamp: "2026-03-01T00:00:00.000Z", cwd },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-03-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: id }], timestamp: Date.parse("2026-03-02T10:00:00.000Z") } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const ids = { own: "77777777-8888-4999-8aaa-000000000041", colliding: "77777777-8888-4999-8aaa-000000000042" };
    fs.writeFileSync(path.join(mirror, `2026-03-01T00-00-00-000Z_${ids.own}.jsonl`), chat(ids.own, "C:\\Work\\a-b"));
    fs.writeFileSync(path.join(mirror, `2026-03-01T00-00-00-000Z_${ids.colliding}.jsonl`), chat(ids.colliding, "C:\\Work\\a\\b"));

    expect((await listMirroredSessions(mirror, "", "win32", undefined, "c:\\work\\A-B")).map((row) => row.id)).toEqual([ids.own]);
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
