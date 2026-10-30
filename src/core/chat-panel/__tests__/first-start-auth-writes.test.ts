import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const { tmpRoot, fakeHome, fakeWorkspace, sweep } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-first-start-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), fakeWorkspace: nodePath.join(root, "home", "workspace"), sweep: { test: 0 } };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

// The legacy key sweep runs once per process and marker path, so each test sweeps under its own marker.
vi.mock("../../paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../paths")>();
  return {
    ...actual,
    get PROVIDER_KEY_SWEEP_MARKER_PATH() {
      return path.join(actual.DAMOCLES_HOME_DIR, `provider-key-sweep-${sweep.test}.json`);
    },
  };
});

import { ChatPanelProvider } from "../index";
import { installFakePlatform, type FakePlatform } from "../../../__mocks__/fake-platform";
import { PiRuntime } from "../../pi-session/pi-runtime";
import { ACCOUNT_PROVIDER_IDS } from "../../../shared/settings-sections";
import { folderKey } from "../../workspace-folders/folder-key";
import { PI_AGENT_DIR } from "../../pi-session/agent-dir";
import { PROVIDER_KEY_SWEEP_MARKER_PATH } from "../../paths";
import { initPiLoader } from "../../pi-session/pi-loader";
import type { Disposable } from "../../../platform/disposable";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";

// auth.json is written and deleted below, so the agent dir must be the temp home's before any test or hook runs
if (!PI_AGENT_DIR.startsWith(tmpRoot + path.sep)) throw new Error(`${PI_AGENT_DIR} is outside the test's temp home`);

type Posted = ExtensionToWebviewMessage;

let platform: FakePlatform;
let subscriptions: Disposable[];
const authPath = path.join(PI_AGENT_DIR, "auth.json");

function addPanel(panels: Map<string, unknown>, id: string): Posted[] {
  const posted: Posted[] = [];
  panels.set(id, {
    host: { postMessage: async (m: Posted) => { posted.push(m); return true; } },
    session: { publishAccountInfo: vi.fn(), publishAvailableModels: vi.fn(), getToolStatus: () => ({ panel: id }), openaiSignInEnded: vi.fn(async () => undefined) },
    folder: { key: folderKey(fakeWorkspace), fsPath: fakeWorkspace, name: "workspace", label: "workspace", projectScope: true },
    permissionHandler: {},
    ideContextManager: {},
    disposables: [],
  });
  return posted;
}

function harness(): { posted: Posted[]; panels: Map<string, unknown> } {
  const provider = new ChatPanelProvider(platform, {
    subscriptions,
    createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
  });
  const panels = (provider as unknown as { panelManager: { getPanels: () => Map<string, unknown> } }).panelManager.getPanels();
  return { posted: addPanel(panels, "p1"), panels };
}

/** The shared auth.json watch: a report sets its debounce, and its handling of the report clears it. */
const authWatch = () =>
  (PiRuntime as unknown as { _authFileWatches: WeakMap<object, Map<string, { debounce: unknown }>> })._authFileWatches.get(platform.fileWatchers)?.get(PI_AGENT_DIR);

/** As both hosts' watchers do, reports every real write of auth.json, this process's own included, to the shared watch; returns the reports so far. */
function watchAuthFileWrites(): () => number {
  let reported = 0;
  const watcher = fs.watch(PI_AGENT_DIR, (_event, name) => {
    if (name !== "auth.json") return;
    reported++;
    platform.fileWatchers.watcher(PI_AGENT_DIR, "auth.json").fireChange(authPath);
  });
  subscriptions.push({ dispose: () => watcher.close() });
  return () => reported;
}

/** Runs one action, which writes auth.json, waits for the watch to handle the report of that write, and reports what it posted and published. */
async function count(posted: Posted[], panels: Map<string, unknown>, reports: () => number, act: () => Promise<unknown>) {
  const publishers = [...panels.values()].map((panel) => (panel as { session: { publishAccountInfo: ReturnType<typeof vi.fn> } }).session.publishAccountInfo);
  posted.length = 0;
  for (const publish of publishers) publish.mockClear();
  const since = reports();
  await act();
  await vi.waitFor(() => expect({ reported: reports() > since, pending: authWatch()?.debounce != null }).toEqual({ reported: true, pending: false }), { timeout: 10_000 });
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  return {
    judges: posted.filter((m) => m.type === "memoryJudgeStatus").length,
    keyRows: posted.filter((m) => m.type === "providerAuthStatusChanged").length,
    claudeRows: posted.filter((m) => m.type === "claudeAuthStatusChanged").length,
    openaiRows: posted.filter((m) => m.type === "openaiAuthStatusChanged").length,
    publishes: publishers.map((publish) => publish.mock.calls.length),
  };
}

beforeEach(() => {
  sweep.test++;
  for (const name of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"]) vi.stubEnv(name, "");
  fs.mkdirSync(fakeWorkspace, { recursive: true });
  fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
  platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }] });
  subscriptions = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const subscription of subscriptions) subscription.dispose();
  await PiRuntime.disposeInstance();
  fs.rmSync(authPath, { force: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("the one-time auth.json writes of the first start after an upgrade", () => {
  it("a sweep whose logout failed before pi committed it leaves another app's write meanwhile to the watcher", async () => {
    expect(fs.existsSync(PROVIDER_KEY_SWEEP_MARKER_PATH)).toBe(false);
    fs.writeFileSync(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "sk-plain-deepseek" } }));
    const reports = watchAuthFileWrites();
    const { posted, panels } = harness();
    const runtime = PiRuntime.get();
    await runtime.init();
    vi.spyOn(runtime.modelRuntime!, "logout").mockImplementation(async () => {
      // a pi CLI login of the same provider landing while the sweep runs, whose own logout then fails
      fs.writeFileSync(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "sk-cli-deepseek" } }));
      throw new Error("auth.json is locked");
    });

    // the runtime's first key sync publishes, and the watcher publishes the CLI's write, the Claude and OpenAI rows included
    expect(await count(posted, panels, reports, () => runtime.syncCustomProviders((key) => platform.secrets.get(key))))
      .toEqual({ judges: 2, keyRows: 2 * ACCOUNT_PROVIDER_IDS.length, claudeRows: 1, openaiRows: 1, publishes: [2] });
    expect(fs.existsSync(PROVIDER_KEY_SWEEP_MARKER_PATH)).toBe(false);
  }, 60_000);

  it("the first key sync sweeps a plain-text key an older version stored, and its end alone publishes that", async () => {
    expect(fs.existsSync(PROVIDER_KEY_SWEEP_MARKER_PATH)).toBe(false);
    fs.writeFileSync(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "sk-plain-deepseek" } }));
    const reports = watchAuthFileWrites();
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    const runtime = PiRuntime.get();
    await runtime.init();
    runtime.registerSessionMutator("held-session", (panels.get("p1") as { session: never }).session);

    expect(await count(posted, panels, reports, () => runtime.syncCustomProviders((key) => platform.secrets.get(key))))
      .toEqual({ judges: 1, keyRows: ACCOUNT_PROVIDER_IDS.length, claudeRows: 0, openaiRows: 0, publishes: [1, 1] });
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual({});
    expect(fs.existsSync(PROVIDER_KEY_SWEEP_MARKER_PATH)).toBe(true);
    expect(posted.find((m) => m.type === "providerAuthStatusChanged" && m.provider === "deepseek")).toMatchObject({ configured: false, external: null });
  }, 60_000);

  it("init moves an auth.json OpenAI key into the secret and publishes that once, the OpenAI row and every chat's account state included, and the watcher nothing", async () => {
    fs.writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "sk-plain" } }));
    const reports = watchAuthFileWrites();
    const { posted, panels } = harness();
    addPanel(panels, "p2");

    expect(await count(posted, panels, reports, () => PiRuntime.get().init()))
      .toEqual({ judges: 1, keyRows: 0, claudeRows: 0, openaiRows: 1, publishes: [1, 1] });
    expect(platform.secrets.entries.get("damocles.openai.apiKey")).toBe("sk-plain");
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual({});
    expect(posted.find((m) => m.type === "openaiAuthStatusChanged")).toMatchObject({ status: { apikey: { configured: true } } });
  }, 60_000);

  it("a key migration whose delete failed before pi committed it leaves another app's write meanwhile to the watcher", async () => {
    fs.writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "sk-plain" } }));
    const reports = watchAuthFileWrites();
    const { posted, panels } = harness();
    const pi = (await initPiLoader())!;
    const logout = vi.spyOn(pi.ModelRuntime.prototype, "logout").mockImplementation(async () => {
      // a pi CLI login of the same provider landing while the key moves, whose own delete then fails
      fs.writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "sk-cli" } }));
      throw new Error("auth.json is locked");
    });
    try {
      // only the watcher's handling publishes the CLI's write, the Claude row included
      expect(await count(posted, panels, reports, () => PiRuntime.get().init()))
        .toEqual({ judges: 1, keyRows: ACCOUNT_PROVIDER_IDS.length, claudeRows: 1, openaiRows: 1, publishes: [1] });
    } finally {
      logout.mockRestore();
    }
  }, 60_000);
});
