import * as fs from "fs";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-memory-judge-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), fakeWorkspace: nodePath.join(root, "home", "workspace") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { ChatPanelProvider } from "../index";
import { installLogSink } from "../../logger";
import { installFakePlatform, type FakePlatform } from "../../../__mocks__/fake-platform";
import { PiRuntime } from "../../pi-session/pi-runtime";
import { CUSTOM_PROVIDER_DEFS, KEYED_PROVIDER_DEFS } from "../../pi-session/custom-providers";
import { ACCOUNT_PROVIDER_IDS } from "../../../shared/settings-sections";
import { MODEL_PICKER_SETTING } from "../../../shared/model-vendor";
import { republishAccountInfo } from "../message-router/handlers/account-info";
import { folderKey } from "../../workspace-folders/folder-key";
import { PI_AGENT_DIR } from "../../pi-session/agent-dir";
import { createFakeRemoteHost } from "../../../__mocks__/fake-remote-host";
import * as path from "path";
import type { Disposable } from "../../../platform/disposable";
import { VSCODE_HOST_CAPABILITIES, type ExtensionToWebviewMessage } from "../../../shared/types/messages";
import { asClient, bypassAllowed } from "../../client-snapshots";
import { SUBSCRIPTION_SOURCE } from "../../pi-session/subscription";
import { initPiLoader } from "../../pi-session/pi-loader";

// auth.json is written and deleted below, so the agent dir must be the temp home's before any test or hook runs
if (!PI_AGENT_DIR.startsWith(tmpRoot + path.sep)) throw new Error(`${PI_AGENT_DIR} is outside the test's temp home`);

type Posted = ExtensionToWebviewMessage;

let platform: FakePlatform;
let subscriptions: Disposable[];

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

function harness(): { posted: Posted[]; panels: Map<string, unknown>; provider: ChatPanelProvider } {
  const provider = new ChatPanelProvider(platform, {
    subscriptions,
    createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
  });
  const panels = (provider as unknown as { panelManager: { getPanels: () => Map<string, unknown> } }).panelManager.getPanels();
  return { posted: addPanel(panels, "p1"), panels, provider };
}

const judgeUpdates = (posted: Posted[]) =>
  posted.filter((m): m is Extract<Posted, { type: "memoryJudgeStatus" }> => m.type === "memoryJudgeStatus");
const keyStatuses = (posted: Posted[]) =>
  posted.filter((m): m is Extract<Posted, { type: "providerAuthStatusChanged" }> => m.type === "providerAuthStatusChanged");

beforeEach(() => {
  for (const name of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(name, "");
  fs.mkdirSync(fakeWorkspace, { recursive: true });
  platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }] });
  subscriptions = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const subscription of subscriptions) subscription.dispose();
  await PiRuntime.disposeInstance();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("memory judge status in open panels", () => {
  it("subscribes without creating the pi runtime", () => {
    harness();
    expect(PiRuntime.exists).toBe(false);
  });

  it("rebroadcasts when a judge input changes, before pi starts saying the sub-call model is not known yet", async () => {
    const { posted } = harness();
    PiRuntime.notifyMemoryJudgeChange();
    await vi.waitFor(() => expect(judgeUpdates(posted)).toHaveLength(1));
    expect(judgeUpdates(posted)[0]).toEqual({
      type: "memoryJudgeStatus",
      memoryJudge: { kind: "unknown" },
      classifierCredentials: { typesafe: "no-key", openrouter: "no-key", openai: "no-key" },
    });
  });

  it("rebroadcasts when a classifier key is stored, here or in another window", async () => {
    const { posted } = harness();
    await platform.secrets.store("damocles.openai.apiKey", "sk-key");
    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)?.memoryJudge).toEqual({ kind: "classifier", via: "openai" }));
    await platform.secrets.store("damocles.explore.apiKey.openrouter", "or-key");
    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)?.memoryJudge).toEqual({ kind: "classifier", via: "openrouter" }));
    await platform.secrets.store("damocles.typesafe.apiKey", "ts-key");
    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)).toMatchObject({ memoryJudge: { kind: "classifier", via: "typesafe" } }));
  });

  it("rebroadcasts when the Memory judge setting changes, before pi starts", async () => {
    const { posted } = harness();
    await platform.settings.update("damocles.memory.judge", "jev-typesafe", "user");
    await vi.waitFor(() =>
      expect(judgeUpdates(posted).at(-1)?.memoryJudge).toEqual({ kind: "none", forced: { choice: "jev-typesafe", reason: "no-key" } }),
    );
  });

  it("rebroadcasts the judge and the Anthropic row when auth.json changes before pi starts", async () => {
    const { posted } = harness();
    await platform.secrets.store("damocles.openai.apiKey", "sk-key");
    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)?.memoryJudge).toEqual({ kind: "classifier", via: "openai" }));

    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(PI_AGENT_DIR, "auth.json"), JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires: 9_999_999_999_999 } }));
    platform.fileWatchers.watcher(PI_AGENT_DIR, "auth.json").fireChange(path.join(PI_AGENT_DIR, "auth.json"));

    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)?.classifierCredentials.openai).toBe("chatgpt-active"));
    expect(posted.some((m) => m.type === "claudeAuthStatusChanged")).toBe(true);
    expect(PiRuntime.exists).toBe(false);
    fs.rmSync(path.join(PI_AGENT_DIR, "auth.json"), { force: true });
  });

  it("rebroadcasts when a Claude or OpenAI credential change republishes the account", async () => {
    const { posted, panels } = harness();
    republishAccountInfo(() => panels as never);
    await vi.waitFor(() => expect(judgeUpdates(posted)).toHaveLength(1));
  });

  it("logs a status read that fails instead of leaving the rejection unhandled", async () => {
    const { posted } = harness();
    const logged: string[] = [];
    installLogSink({ appendLine: (line) => void logged.push(line), show: () => undefined, dispose: () => undefined });
    vi.spyOn(platform.secrets, "get").mockRejectedValue(new Error("keyring locked"));

    PiRuntime.notifyMemoryJudgeChange();

    await vi.waitFor(() => expect(logged.join("\n")).toContain("reading the memory judge status failed: the secret store did not answer for"));
    expect(judgeUpdates(posted)).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

/** Lets every async read and post a change started settle, so a late second post would be counted. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

/** VS Code's SecretStorage reports a change after the write resolved; the fake, like the desktop core's proxy, reports it before. Call before anything listens. */
function reportSecretChangesAfterTheWrite(): void {
  const inner = platform.secrets;
  const listeners = new Set<(key: string) => void>();
  inner.onDidChange((key) => setTimeout(() => { for (const listener of [...listeners]) listener(key); }, 0));
  Object.assign(platform, { secrets: { ...inner, onDidChange: (listener: (key: string) => void): Disposable => {
    listeners.add(listener);
    return { dispose: () => void listeners.delete(listener) };
  } } });
}

const secretChangeOrders = [
  ["before the write resolves, as the desktop core hears it", false],
  ["after the write resolves, as VS Code reports it", true],
] as const;

type Router = { handleWebviewMessage: (message: unknown, panelId: string, view: undefined, viewKey?: string) => Promise<void> };
const routerOf = (provider: ChatPanelProvider): Router => (provider as unknown as { messageRouter: Router }).messageRouter;

describe("memory judge status for a classifier key change, by its one publisher", () => {
  it.each([
    ["Typesafe", "damocles.typesafe.apiKey"],
    ["OpenRouter", "damocles.explore.apiKey.openrouter"],
    ["OpenAI", "damocles.openai.apiKey"],
  ])("with the runtime observing secrets, storing the %s key posts the judge status once", async (_name, key) => {
    const { posted } = harness();
    await PiRuntime.get().init();
    expect(PiRuntime.observesSecrets).toBe(true);
    await settled();
    posted.length = 0;

    await platform.secrets.store(key, "the-key");
    await vi.waitFor(() => expect(judgeUpdates(posted).length).toBeGreaterThan(0));
    await settled();

    expect(judgeUpdates(posted).length, key).toBe(1);
  }, 60_000);

  // The runtime exists from its construction, but hears secrets only once init installed its listener.
  it("before the runtime observes secrets, the panel posts it", async () => {
    const { posted } = harness();
    PiRuntime.get();
    expect(PiRuntime.observesSecrets).toBe(false);

    await platform.secrets.store("damocles.typesafe.apiKey", "the-key");

    await vi.waitFor(() => expect(judgeUpdates(posted)).toHaveLength(1));
  });
});

describe("memory judge status for one account action", () => {
  /** VS Code's SecretStorage reports a change after the write resolved; the fake, like the desktop core's proxy, reports it before. */
  function reportChangesAfterTheWrite(): void {
    const inner = platform.secrets;
    const listeners = new Set<(key: string) => void>();
    inner.onDidChange((key) => setTimeout(() => { for (const listener of [...listeners]) listener(key); }, 0));
    const onDidChange = (listener: (key: string) => void): Disposable => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    };
    Object.assign(platform, { secrets: { ...inner, onDidChange } });
  }

  const orders = [
    ["before the write resolves, as the desktop core hears it", false],
    ["after the write resolves, as VS Code reports it", true],
  ] as const;

  /**
   * Runs one action and reports what it made: the judge statuses posted, the runtime's judge notices (each a read that two
   * paths in one tick would collapse into one post), the key syncs and each panel's account publishes.
   */
  function counter(posted: Posted[], panels: Map<string, unknown>) {
    const counts = { notices: 0, syncs: 0 };
    subscriptions.push({ dispose: PiRuntime.onMemoryJudgeChange(() => void counts.notices++) });
    subscriptions.push({ dispose: PiRuntime.onCustomProvidersSynced(() => void counts.syncs++) });
    const publishers = () => [...panels.values()].map((panel) => (panel as { session: { publishAccountInfo: ReturnType<typeof vi.fn> } }).session.publishAccountInfo);
    return async (act: () => Promise<unknown>) => {
      posted.length = 0;
      counts.notices = 0;
      counts.syncs = 0;
      for (const publish of publishers()) publish.mockClear();
      await act();
      await settled();
      return { judges: judgeUpdates(posted).map((m) => m.memoryJudge), notices: counts.notices, syncs: counts.syncs, publishes: publishers().map((publish) => publish.mock.calls.length) };
    };
  }

  /** A started chat's folder and first key sync, which make the judge status the runtime's own reading; it awaits no secret read. */
  async function startedRuntime(): Promise<PiRuntime> {
    const runtime = PiRuntime.get();
    await runtime.folder(fakeWorkspace);
    await runtime.syncCustomProviders((key) => platform.secrets.get(key));
    expect(runtime.memoryJudgeKnown).toBe(true);
    await settled();
    return runtime;
  }

  it.each(orders)("with the runtime observing secrets, a key save and clear in Settings each post the judge status once and sync the key once, the change reported %s", async (_order, late) => {
    if (late) reportChangesAfterTheWrite();
    const { posted, panels, provider } = harness();
    const runtime = await startedRuntime();
    const count = counter(posted, panels);
    const router = routerOf(provider);

    expect(await count(() => router.handleWebviewMessage({ type: "setProviderApiKey", provider: "typesafe", key: "ts-key", requestId: "save" }, "p1", undefined)))
      .toEqual({ judges: [{ kind: "classifier", via: "typesafe" }], notices: 1, syncs: 1, publishes: [1] });
    expect(posted).toContainEqual({ type: "setProviderApiKeyAck", provider: "typesafe", requestId: "save", ok: true });
    expect(runtime.modelRuntime?.hasConfiguredAuth("typesafe")).toBe(true);

    expect(await count(() => router.handleWebviewMessage({ type: "clearProviderApiKey", provider: "typesafe", requestId: "clear" }, "p1", undefined)))
      .toEqual({ judges: [{ kind: "none" }], notices: 1, syncs: 1, publishes: [1] });
    expect(posted).toContainEqual({ type: "clearProviderApiKeyAck", provider: "typesafe", requestId: "clear", ok: true });
    expect(runtime.modelRuntime?.hasConfiguredAuth("typesafe")).toBe(false);
  }, 60_000);

  it.each(orders)("before pi starts, a key save and clear in Settings each post the judge status once, the change reported %s", async (_order, late) => {
    if (late) reportChangesAfterTheWrite();
    const { posted, panels, provider } = harness();
    const count = counter(posted, panels);
    const router = routerOf(provider);

    expect(await count(() => router.handleWebviewMessage({ type: "setProviderApiKey", provider: "typesafe", key: "ts-key", requestId: "save" }, "p1", undefined)))
      .toEqual({ judges: [{ kind: "classifier", via: "typesafe" }], notices: 0, syncs: 0, publishes: [0] });
    expect(await count(() => router.handleWebviewMessage({ type: "clearProviderApiKey", provider: "typesafe", requestId: "clear" }, "p1", undefined)))
      .toEqual({ judges: [{ kind: "unknown" }], notices: 0, syncs: 0, publishes: [0] });
  });

  it.each(orders)("with the runtime observing secrets, an OpenAI key save and clear in Settings each post the judge status once, the change reported %s", async (_order, late) => {
    if (late) reportChangesAfterTheWrite();
    // the save's validation request to OpenAI
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const { posted, panels, provider } = harness();
    await startedRuntime();
    const count = counter(posted, panels);
    const router = routerOf(provider);
    const openai = (result: { judges: unknown[] }) => ({ ...result, judges: judgeUpdates(posted).map((m) => m.classifierCredentials.openai) });

    expect(openai(await count(() => router.handleWebviewMessage({ type: "setOpenAIApiKey", key: "sk-key", requestId: "save" }, "p1", undefined)))).toMatchObject({ judges: ["ok"], notices: 1 });
    expect(posted).toContainEqual(expect.objectContaining({ type: "setOpenAIApiKeyAck", requestId: "save", ok: true }));
    expect(openai(await count(() => router.handleWebviewMessage({ type: "clearOpenAIApiKey", requestId: "clear" }, "p1", undefined)))).toMatchObject({ judges: ["no-key"], notices: 1 });
    expect(posted).toContainEqual({ type: "clearOpenAIApiKeyAck", requestId: "clear", ok: true });
    vi.unstubAllGlobals();
  }, 60_000);

  it("a provider sign-in and its sign-out each post the judge status once and publish every panel's account state once", async () => {
    const { posted, panels, provider } = harness();
    addPanel(panels, "p2");
    const runtime = await startedRuntime();
    // pi's OAuth flow, here writing no auth.json; a sign-in that writes it is counted below with the watcher reporting the write
    vi.spyOn(runtime.modelRuntime!, "login").mockResolvedValue({ type: "oauth", access: "a", refresh: "r", expires: 9_999_999_999_999 });
    const count = counter(posted, panels);
    const router = routerOf(provider);

    expect(await count(() => router.handleWebviewMessage({ type: "providerSignIn", provider: "openrouter" }, "p1", undefined)))
      .toMatchObject({ judges: [expect.anything()], notices: 1, publishes: [1, 1] });
    expect(posted).toContainEqual({ type: "providerSignInState", provider: "openrouter", state: { phase: "idle" } });
    expect(await count(() => router.handleWebviewMessage({ type: "providerSignOut", provider: "openrouter" }, "p1", undefined)))
      .toMatchObject({ judges: [expect.anything()], notices: 1, syncs: 1, publishes: [1, 1] });
  }, 60_000);

  it("a Prefer API key toggle and a Memory judge setting change each post the judge status once", async () => {
    const { posted, panels, provider } = harness();
    await startedRuntime();
    const count = counter(posted, panels);

    expect(await count(() => routerOf(provider).handleWebviewMessage({ type: "setProviderPreferApiKey", provider: "openrouter", preferApiKey: true, requestId: "prefer" }, "p1", undefined)))
      .toMatchObject({ judges: [expect.anything()], notices: 1, syncs: 1 });
    expect(posted).toContainEqual({ type: "setProviderPreferApiKeyAck", provider: "openrouter", requestId: "prefer", ok: true });
    expect(await count(() => platform.settings.update("damocles.memory.judge", "jev-typesafe", "user")))
      .toEqual({ judges: [{ kind: "none", forced: { choice: "jev-typesafe", reason: "no-key" } }], notices: 0, syncs: 0, publishes: [0] });
  }, 60_000);

  it("an auth.json change once the runtime holds its watch posts the judge status once, from the key sync's end", async () => {
    const authPath = path.join(PI_AGENT_DIR, "auth.json");
    const { posted, panels } = harness();
    await startedRuntime();
    const count = counter(posted, panels);

    try {
      expect(await count(async () => {
        fs.writeFileSync(authPath, JSON.stringify({ openrouter: { type: "oauth", access: "a", refresh: "r", expires: 9_999_999_999_999 } }));
        platform.fileWatchers.watcher(PI_AGENT_DIR, "auth.json").fireChange(authPath);
        // the watch's debounce
        await new Promise((resolve) => setTimeout(resolve, 300));
      })).toMatchObject({ judges: [expect.anything()], notices: 1, syncs: 1, publishes: [1] });
    } finally {
      fs.rmSync(authPath, { force: true });
    }
  }, 60_000);
});

describe("account state for one change, by one publisher per audience and row", () => {
  const authPath = path.join(PI_AGENT_DIR, "auth.json");
  afterEach(() => {
    fs.rmSync(authPath, { force: true });
  });

  /** The shared auth.json watch: a report sets its debounce, and its handling of the report clears it. */
  const authWatch = () =>
    (PiRuntime as unknown as { _authFileWatches: WeakMap<object, Map<string, { debounce: unknown }>> })._authFileWatches.get(platform.fileWatchers)?.get(PI_AGENT_DIR);

  /**
   * As both hosts' watchers do, reports every real write of auth.json, this process's own included, to the shared watch.
   * `held` keeps the reports back until `deliverHeld`, as a watcher that reports late does.
   */
  function watchAuthFileWrites() {
    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    let reported = 0;
    let holding = false;
    let held = false;
    const report = (): void => {
      reported++;
      platform.fileWatchers.watcher(PI_AGENT_DIR, "auth.json").fireChange(authPath);
    };
    const watcher = fs.watch(PI_AGENT_DIR, (_event, name) => {
      if (name !== "auth.json") return;
      if (holding) held = true;
      else report();
    });
    subscriptions.push({ dispose: () => watcher.close() });
    /** Settles once a report made after `since` reports was handled and what its handling started settled. */
    const handledSince = async (since: number): Promise<void> => {
      await vi.waitFor(() => expect({ reported: reported > since, pending: authWatch()?.debounce != null }).toEqual({ reported: true, pending: false }), { timeout: 10_000 });
      await settled();
    };
    return {
      reports: () => reported,
      handledSince,
      hold: () => {
        holding = true;
      },
      /** Waits for the watcher to report a write while held, then delivers that report and waits for its handling. */
      deliverHeld: async (): Promise<void> => {
        await vi.waitFor(() => expect(held).toBe(true), { timeout: 10_000 });
        holding = false;
        held = false;
        const since = reported;
        report();
        await handledSince(since);
      },
    };
  }

  /** Lets the file events of the writes made so far arrive and their debounced handling run. */
  const writesSettled = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settled();
  };

  const writeAuthEntry = (provider: string, entry: Record<string, unknown>): void => {
    const current = fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown> : {};
    fs.writeFileSync(authPath, JSON.stringify({ ...current, [provider]: entry }, null, 2));
  };
  const oauthEntry = { type: "oauth", access: "a", refresh: "r", expires: 9_999_999_999_999 };

  const claudeRows = (posted: Posted[]) => posted.filter((m) => m.type === "claudeAuthStatusChanged");
  const openaiRows = (posted: Posted[]) => posted.filter((m) => m.type === "openaiAuthStatusChanged");
  const publishCounts = (panels: Map<string, unknown>) =>
    [...panels.values()].map((panel) => (panel as { session: { publishAccountInfo: ReturnType<typeof vi.fn> } }).session.publishAccountInfo.mock.calls.length);
  const clearPublishes = (panels: Map<string, unknown>) => {
    for (const panel of panels.values()) (panel as { session: { publishAccountInfo: ReturnType<typeof vi.fn> } }).session.publishAccountInfo.mockClear();
  };

  /** A started chat's folder and first key sync; with `held`, panel p1's session is one the runtime holds, as a started chat's is. */
  async function started(panels: Map<string, unknown>, held = false): Promise<PiRuntime> {
    const runtime = PiRuntime.get();
    await runtime.folder(fakeWorkspace);
    await runtime.syncCustomProviders((key) => platform.secrets.get(key));
    if (held) runtime.registerSessionMutator("held-session", (panels.get("p1") as { session: never }).session);
    await settled();
    return runtime;
  }

  /** Counts what one action made: each OpenAI runtime key sync calls pi exactly once for `openai`. */
  function counter(runtime: PiRuntime, posted: Posted[], panels: Map<string, unknown>) {
    const counts = { notices: 0, syncs: 0, openaiSyncs: 0, usageResets: 0 };
    subscriptions.push({ dispose: PiRuntime.onMemoryJudgeChange(() => void counts.notices++) });
    subscriptions.push({ dispose: PiRuntime.onCustomProvidersSynced(() => void counts.syncs++) });
    const credentialsChanged = runtime.usage.credentialsChanged.bind(runtime.usage);
    vi.spyOn(runtime.usage, "credentialsChanged").mockImplementation(() => {
      counts.usageResets++;
      credentialsChanged();
    });
    const modelRuntime = runtime.modelRuntime!;
    for (const method of ["setRuntimeApiKey", "removeRuntimeApiKey"] as const) {
      const original = modelRuntime[method].bind(modelRuntime) as (provider: string, ...rest: unknown[]) => Promise<void>;
      vi.spyOn(modelRuntime, method).mockImplementation(((provider: string, ...rest: unknown[]) => {
        if (provider === "openai") counts.openaiSyncs++;
        return original(provider, ...rest);
      }) as never);
    }
    return async (act: () => Promise<unknown>) => {
      posted.length = 0;
      Object.assign(counts, { notices: 0, syncs: 0, openaiSyncs: 0, usageResets: 0 });
      clearPublishes(panels);
      await act();
      await writesSettled();
      return {
        judges: judgeUpdates(posted).length,
        notices: counts.notices,
        syncs: counts.syncs,
        openaiSyncs: counts.openaiSyncs,
        usageResets: counts.usageResets,
        publishes: publishCounts(panels),
        keyRows: keyStatuses(posted).length,
        claudeRows: claudeRows(posted).length,
        openaiRows: openaiRows(posted).length,
      };
    };
  }

  const orders = [
    ["while the sign-in still runs", true],
    ["after the sign-in ended", false],
  ] as const;

  /** `slow`: the watcher handles the write while the change still holds its entry; else it reports the write only once the change ended. */
  async function ownWrite(writes: ReturnType<typeof watchAuthFileWrites>, slow: boolean, write: () => Promise<unknown> | unknown): Promise<void> {
    const since = writes.reports();
    await write();
    if (slow) await writes.handledSince(since);
  }

  /** Runs `act` with the watcher's reports held when not `slow`, and delivers them once `act` ended. */
  const actThenReport = (writes: ReturnType<typeof watchAuthFileWrites>, slow: boolean, act: () => Promise<unknown>) => async () => {
    if (!slow) writes.hold();
    await act();
    if (!slow) await writes.deliverHeld();
  };

  it.each(orders)("a provider sign-in writes auth.json, and the watcher handling that write %s publishes nothing more", async (_order, slow) => {
    const writes = watchAuthFileWrites();
    const { posted, panels, provider } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels);
    // pi's OAuth flow, which stores the sign-in before it resolves
    vi.spyOn(runtime.modelRuntime!, "login").mockImplementation(async () => {
      await ownWrite(writes, slow, () => writeAuthEntry("openrouter", oauthEntry));
      return oauthEntry as never;
    });
    const count = counter(runtime, posted, panels);

    expect(await count(actThenReport(writes, slow, () => routerOf(provider).handleWebviewMessage({ type: "providerSignIn", provider: "openrouter" }, "p1", undefined))))
      .toEqual({ judges: 1, notices: 1, syncs: 1, openaiSyncs: 0, usageResets: 1, publishes: [1, 1], keyRows: ACCOUNT_PROVIDER_IDS.length, claudeRows: 0, openaiRows: 0 });
    expect(keyStatuses(posted).find((status) => status.provider === "openrouter")).toMatchObject({ signedIn: true });
  }, 60_000);

  it.each(orders)("a Claude key set in Settings writes auth.json, and the watcher handling that write %s publishes nothing more", async (_order, slow) => {
    const writes = watchAuthFileWrites();
    const { posted, panels, provider } = harness();
    const runtime = await started(panels);
    const modelRuntime = runtime.modelRuntime!;
    const login = modelRuntime.login.bind(modelRuntime);
    // pi's own login, which writes auth.json
    vi.spyOn(modelRuntime, "login").mockImplementation(async (...args: Parameters<typeof login>) => {
      let stored: Awaited<ReturnType<typeof login>> | undefined;
      await ownWrite(writes, slow, async () => {
        stored = await login(...args);
      });
      return stored!;
    });
    const count = counter(runtime, posted, panels);

    expect(await count(actThenReport(writes, slow, () => routerOf(provider).handleWebviewMessage({ type: "claudeSetApiKey", key: "sk-ant-key" }, "p1", undefined))))
      .toEqual({ judges: 1, notices: 1, syncs: 0, openaiSyncs: 0, usageResets: 1, publishes: [1], keyRows: 0, claudeRows: 1, openaiRows: 0 });
    expect(claudeRows(posted)).toEqual([{ type: "claudeAuthStatusChanged", mode: "apikey" }]);
  }, 60_000);

  it.each(orders)("a ChatGPT sign-in writes auth.json, and the watcher handling that write %s publishes nothing more", async (_order, slow) => {
    const writes = watchAuthFileWrites();
    const { posted, panels, provider } = harness();
    const runtime = await started(panels);
    vi.spyOn(runtime.modelRuntime!, "login").mockImplementation(async () => {
      await ownWrite(writes, slow, () => writeAuthEntry("openai", oauthEntry));
      return oauthEntry as never;
    });
    const count = counter(runtime, posted, panels);

    expect(await count(actThenReport(writes, slow, () => routerOf(provider).handleWebviewMessage({ type: "startChatGPTOAuth" }, "p1", undefined))))
      .toEqual({ judges: 1, notices: 1, syncs: 0, openaiSyncs: 1, usageResets: 1, publishes: [1], keyRows: 0, claudeRows: 0, openaiRows: 1 });
    expect(openaiRows(posted)[0]).toMatchObject({ status: { chatgpt: { signedIn: true } } });
  }, 60_000);

  it("a ChatGPT sign-in right after auth.json could not be read publishes once, and the watcher reporting its write nothing more", async () => {
    const writes = watchAuthFileWrites();
    const { posted, panels, provider } = harness();
    const runtime = await started(panels);
    const count = counter(runtime, posted, panels);
    await count(async () => {
      const since = writes.reports();
      fs.writeFileSync(authPath, "{ \"anthropic\": ");
      await writes.handledSince(since);
    });
    vi.spyOn(runtime.modelRuntime!, "login").mockImplementation(async () => {
      // pi rewrites the whole file
      fs.writeFileSync(authPath, JSON.stringify({ openai: oauthEntry }, null, 2));
      return oauthEntry as never;
    });

    expect(await count(actThenReport(writes, false, () => routerOf(provider).handleWebviewMessage({ type: "startChatGPTOAuth" }, "p1", undefined))))
      .toEqual({ judges: 1, notices: 1, syncs: 0, openaiSyncs: 1, usageResets: 1, publishes: [1], keyRows: 0, claudeRows: 0, openaiRows: 1 });
  }, 60_000);

  it("two own changes holding the same entry at once, and another app's write between their ends, are each published once", async () => {
    const writes = watchAuthFileWrites();
    const { posted, panels } = harness();
    const runtime = await started(panels);
    const getPanels = () => panels as never;
    const count = counter(runtime, posted, panels);
    let endFirst!: () => void;
    const firstEnds = new Promise<void>((resolve) => {
      endFirst = resolve;
    });
    let endSecond!: () => void;
    const secondEnds = new Promise<void>((resolve) => {
      endSecond = resolve;
    });

    expect(await count(async () => {
      // each own change publishes once it settled, as its caller does
      const first = runtime.ownAuthFileChange(["openai"], true, () => firstEnds).then(() => republishAccountInfo(getPanels));
      const second = runtime.ownAuthFileChange(["openai"], true, () => secondEnds).then(() => republishAccountInfo(getPanels));
      endFirst();
      await first;
      // the second change still holds the entry it writes, so the watcher leaves that write to its publication
      await ownWrite(writes, true, () => writeAuthEntry("openai", oauthEntry));
      await ownWrite(writes, true, () => writeAuthEntry("anthropic", { type: "api_key", key: "sk-ant-cli" }));
      endSecond();
      await second;
    })).toEqual({ judges: 3, notices: 3, syncs: 1, openaiSyncs: 1, usageResets: 2, publishes: [3], keyRows: ACCOUNT_PROVIDER_IDS.length, claudeRows: 1, openaiRows: 1 });
  }, 60_000);

  it("publishes a sign-in another app makes while this app's own sign-in runs", async () => {
    const writes = watchAuthFileWrites();
    const { posted, panels, provider } = harness();
    const runtime = await started(panels);
    vi.spyOn(runtime.modelRuntime!, "login").mockImplementation(async () => {
      await ownWrite(writes, true, () => {
        writeAuthEntry("openrouter", oauthEntry);
        // a pi CLI login, landing between this app's write and the end of its sign-in
        writeAuthEntry("anthropic", { type: "api_key", key: "sk-ant-cli" });
      });
      return oauthEntry as never;
    });
    const count = counter(runtime, posted, panels);

    expect(await count(() => routerOf(provider).handleWebviewMessage({ type: "providerSignIn", provider: "openrouter" }, "p1", undefined)))
      .toMatchObject({ claudeRows: 1 });
    expect(claudeRows(posted)).toEqual([{ type: "claudeAuthStatusChanged", mode: "apikey" }]);
  }, 60_000);

  it("leaves a write a failed Claude key set made, which the handler does not publish, to the watcher", async () => {
    const writes = watchAuthFileWrites();
    const { posted, panels, provider } = harness();
    const runtime = await started(panels);
    const modelRuntime = runtime.modelRuntime!;
    const login = modelRuntime.login.bind(modelRuntime);
    vi.spyOn(modelRuntime, "login").mockImplementation(async (...args: Parameters<typeof login>) => {
      // the watcher handles the write while the change still holds the entry
      await ownWrite(writes, true, () => login(...args));
      throw new Error("the model snapshot refresh failed");
    });
    const count = counter(runtime, posted, panels);

    expect(await count(() => routerOf(provider).handleWebviewMessage({ type: "claudeSetApiKey", key: "sk-ant-key" }, "p1", undefined)))
      .toMatchObject({ judges: 1, claudeRows: 1 });
    expect(claudeRows(posted)).toEqual([{ type: "claudeAuthStatusChanged", mode: "apikey" }]);
    expect(posted).toContainEqual(expect.objectContaining({ type: "claudeAuthError" }));
  }, 60_000);

  it.each([
    ["before the write resolves, as the desktop core hears it", false],
    ["after the write resolves, as VS Code reports it", true],
  ] as const)("an OpenAI key save and clear each sync the key once and publish every panel once, the change reported %s", async (_order, late) => {
    if (late) {
      const inner = platform.secrets;
      const listeners = new Set<(key: string) => void>();
      inner.onDidChange((key) => setTimeout(() => { for (const listener of [...listeners]) listener(key); }, 0));
      Object.assign(platform, { secrets: { ...inner, onDidChange: (listener: (key: string) => void): Disposable => {
        listeners.add(listener);
        return { dispose: () => void listeners.delete(listener) };
      } } });
    }
    // the save's validation request to OpenAI
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const { posted, panels, provider } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels, true);
    const count = counter(runtime, posted, panels);
    const router = routerOf(provider);

    expect(await count(() => router.handleWebviewMessage({ type: "setOpenAIApiKey", key: "sk-key", requestId: "save" }, "p1", undefined)))
      .toMatchObject({ judges: 1, notices: 1, openaiSyncs: 1, publishes: [1, 1], openaiRows: 1, usageResets: 1 });
    expect(runtime.getOpenAIAuthStatus().apiKey).toBe(true);
    expect(await count(() => router.handleWebviewMessage({ type: "clearOpenAIApiKey", requestId: "clear" }, "p1", undefined)))
      .toMatchObject({ judges: 1, notices: 1, openaiSyncs: 1, publishes: [1, 1], openaiRows: 1, usageResets: 1 });
    expect(runtime.getOpenAIAuthStatus().apiKey).toBe(false);
    vi.unstubAllGlobals();
  }, 60_000);

  it("where the secret store is not persistent, an OpenAI key save lands in auth.json and still syncs and publishes once", async () => {
    platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }], secretsPersistent: false });
    watchAuthFileWrites();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const { posted, panels, provider } = harness();
    const runtime = await started(panels, true);
    const count = counter(runtime, posted, panels);

    expect(await count(() => routerOf(provider).handleWebviewMessage({ type: "setOpenAIApiKey", key: "sk-key", requestId: "save" }, "p1", undefined)))
      .toMatchObject({ judges: 1, notices: 1, openaiSyncs: 1, syncs: 0, publishes: [1], openaiRows: 1, usageResets: 1 });
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toMatchObject({ openai: { type: "api_key" } });
    vi.unstubAllGlobals();
  }, 60_000);

  it.each(secretChangeOrders)("an OpenAI key save that fails after its secret write is published once, by its handler, with the key as written, the change reported %s", async (_order, late) => {
    platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }], secretsPersistent: false, secrets: { "damocles.openai.apiKey": "sk-old" } });
    if (late) reportSecretChangesAfterTheWrite();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const { posted, panels, provider } = harness();
    const runtime = await started(panels, true);
    // on a host without a persistent store the save deletes the secret, then writes the key to auth.json
    vi.spyOn(runtime.modelRuntime!, "login").mockRejectedValueOnce(new Error("auth.json is locked"));
    const count = counter(runtime, posted, panels);

    expect(await count(() => routerOf(provider).handleWebviewMessage({ type: "setOpenAIApiKey", key: "sk-key", requestId: "save" }, "p1", undefined)))
      .toEqual({ judges: 1, notices: 1, syncs: 0, openaiSyncs: 1, usageResets: 1, publishes: [1], keyRows: 0, claudeRows: 0, openaiRows: 1 });
    expect(posted).toContainEqual(expect.objectContaining({ type: "setOpenAIApiKeyAck", requestId: "save", ok: false }));
    expect(openaiRows(posted)[0]).toMatchObject({ status: { apikey: { configured: false } } });
    vi.unstubAllGlobals();
  }, 60_000);

  it.each(secretChangeOrders)("an OpenAI key clear that fails after its secret delete is published once, by its handler, the change reported %s", async (_order, late) => {
    platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }], secretsPersistent: false, secrets: { "damocles.openai.apiKey": "sk-old" } });
    if (late) reportSecretChangesAfterTheWrite();
    // a host without a persistent store keeps the key in auth.json too, which the clear logs out after deleting the secret
    writeAuthEntry("openai", { type: "api_key", key: "sk-old" });
    const { posted, panels, provider } = harness();
    const runtime = await started(panels, true);
    vi.spyOn(runtime.modelRuntime!, "logout").mockRejectedValueOnce(new Error("auth.json is locked"));
    const count = counter(runtime, posted, panels);

    expect(await count(() => routerOf(provider).handleWebviewMessage({ type: "clearOpenAIApiKey", requestId: "clear" }, "p1", undefined)))
      .toEqual({ judges: 1, notices: 1, syncs: 0, openaiSyncs: 1, usageResets: 1, publishes: [1], keyRows: 0, claudeRows: 0, openaiRows: 1 });
    expect(posted).toContainEqual(expect.objectContaining({ type: "clearOpenAIApiKeyAck", requestId: "clear", ok: false }));
  }, 60_000);

  it("a key saved in Settings publishes a started chat's account state once, and a chat that has not started once", async () => {
    const { posted, panels, provider } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels, true);
    const count = counter(runtime, posted, panels);

    expect(await count(() => routerOf(provider).handleWebviewMessage({ type: "setProviderApiKey", provider: "typesafe", key: "ts-key", requestId: "save" }, "p1", undefined)))
      .toMatchObject({ judges: 1, syncs: 1, publishes: [1, 1] });
  }, 60_000);

  it("an auth.json change another app makes posts every account row and each panel's account state once", async () => {
    watchAuthFileWrites();
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels);
    const count = counter(runtime, posted, panels);

    expect(await count(async () => writeAuthEntry("github-copilot", oauthEntry)))
      .toMatchObject({ judges: 1, notices: 1, syncs: 1, publishes: [1, 1], keyRows: ACCOUNT_PROVIDER_IDS.length, claudeRows: 1, openaiRows: 1 });
  }, 60_000);

  it("an auth.json change another app makes publishes a started chat's account state once, as it does one that has not started", async () => {
    watchAuthFileWrites();
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels, true);
    const count = counter(runtime, posted, panels);

    expect(await count(async () => writeAuthEntry("github-copilot", oauthEntry)))
      .toMatchObject({ judges: 1, notices: 1, syncs: 1, openaiSyncs: 1, publishes: [1, 1], claudeRows: 1, openaiRows: 1 });
  }, 60_000);

  it("an auth.json change another app makes while a ChatGPT sign-in holds the credential chain shows in a started chat before the sign-in ends", async () => {
    watchAuthFileWrites();
    const { posted, panels, provider } = harness();
    const runtime = await started(panels, true);
    let finish!: () => void;
    const userFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(runtime.modelRuntime!, "login").mockImplementation(async () => {
      await userFinished;
      writeAuthEntry("openai", oauthEntry);
      return oauthEntry as never;
    });
    const count = counter(runtime, posted, panels);
    const signIn = routerOf(provider).handleWebviewMessage({ type: "startChatGPTOAuth" }, "p1", undefined);
    await vi.waitFor(() => expect(runtime.modelRuntime!.login).toHaveBeenCalled());

    expect(await count(async () => writeAuthEntry("github-copilot", oauthEntry)))
      .toMatchObject({ syncs: 0, publishes: [1], claudeRows: 0, openaiRows: 0 });

    clearPublishes(panels);
    finish();
    await signIn;
    await writesSettled();
    // the sign-in's own publication, and the end of the key sync the auth.json change ran once the chain was free
    expect(publishCounts(panels)).toEqual([2]);
    // with the sign-in over, nothing holds the chain
    expect(await count(async () => writeAuthEntry("anthropic", { type: "api_key", key: "sk-ant-cli" }))).toMatchObject({ syncs: 1, publishes: [1] });
  }, 60_000);

  it("an OpenAI key saved and cleared in another window publishes the OpenAI row, every chat's account state and the judge status once each, syncing once", async () => {
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels, true);
    const count = counter(runtime, posted, panels);
    const configured = () => openaiRows(posted).map((m) => (m as Extract<Posted, { type: "openaiAuthStatusChanged" }>).status.apikey.configured);

    // another window of the profile writes the shared secret; this window hears its change alone
    expect(await count(() => platform.secrets.store("damocles.openai.apiKey", "sk-other")))
      .toMatchObject({ judges: 1, notices: 1, syncs: 0, openaiSyncs: 1, usageResets: 1, publishes: [1, 1], keyRows: 0, claudeRows: 0, openaiRows: 1 });
    expect(configured()).toEqual([true]);
    expect(await count(() => platform.secrets.delete("damocles.openai.apiKey")))
      .toMatchObject({ judges: 1, notices: 1, syncs: 0, openaiSyncs: 1, usageResets: 1, publishes: [1, 1], keyRows: 0, claudeRows: 0, openaiRows: 1 });
    expect(configured()).toEqual([false]);
  }, 60_000);

  it("before pi starts, an OpenAI key saved in another window posts the OpenAI row and the judge status once", async () => {
    const { posted } = harness();

    await platform.secrets.store("damocles.openai.apiKey", "sk-other");
    await settled();

    expect([judgeUpdates(posted).length, openaiRows(posted).length]).toEqual([1, 1]);
    expect(openaiRows(posted)[0]).toMatchObject({ status: { apikey: { configured: true } } });
    expect(PiRuntime.exists).toBe(false);
  });

  it("an OpenAI key another window saved just before this window's runtime was created, reported only after it, is published once", async () => {
    reportSecretChangesAfterTheWrite();
    const { posted, panels } = harness();
    addPanel(panels, "p2");

    // VS Code reports the change after the write resolved, here only once the runtime's first read has recorded the new key
    await platform.secrets.store("damocles.openai.apiKey", "sk-other");
    const runtime = PiRuntime.get();
    await settled();

    expect({ judges: judgeUpdates(posted).length, openaiRows: openaiRows(posted).length, publishes: publishCounts(panels) }).toEqual({ judges: 1, openaiRows: 1, publishes: [1, 1] });
    expect(openaiRows(posted)[0]).toMatchObject({ status: { apikey: { configured: true } } });
    expect(runtime.getOpenAIAuthStatus().apiKey).toBe(true);
  });

  it.each(secretChangeOrders)("with the runtime created and not started, an OpenAI key saved in another window posts the OpenAI row, the judge status and every chat's account state once, the change reported %s", async (_order, late) => {
    if (late) reportSecretChangesAfterTheWrite();
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    const runtime = PiRuntime.get();
    await settled();
    posted.length = 0;
    clearPublishes(panels);

    await platform.secrets.store("damocles.openai.apiKey", "sk-other");
    await settled();

    expect({ judges: judgeUpdates(posted).length, openaiRows: openaiRows(posted).length, publishes: publishCounts(panels) }).toEqual({ judges: 1, openaiRows: 1, publishes: [1, 1] });
    expect(runtime.getOpenAIAuthStatus().apiKey).toBe(true);
    expect(runtime.modelRuntime).toBeNull();
  });

  it("the account state of a chat that has not started counts a saved OpenAI key before init, and init publishes nothing more for it", async () => {
    platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }], secrets: { "damocles.openai.apiKey": "sk-saved" } });
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    const runtime = PiRuntime.get();
    await settled();

    expect(runtime.getOpenAIAuthStatus().apiKey).toBe(true);
    posted.length = 0;
    clearPublishes(panels);
    await runtime.init();
    await writesSettled();
    expect({ judges: judgeUpdates(posted).length, openaiRows: openaiRows(posted).length, publishes: publishCounts(panels) }).toEqual({ judges: 0, openaiRows: 0, publishes: [0, 0] });
  }, 60_000);

  it("a saved OpenAI key the runtime's first read missed is published once, by init's key sync", async () => {
    platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }], secrets: { "damocles.openai.apiKey": "sk-saved" } });
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    await settled();
    // the next read is the runtime's first
    vi.spyOn(platform.secrets, "get").mockRejectedValueOnce(new Error("keyring locked"));
    const runtime = PiRuntime.get();
    await settled();
    expect(runtime.getOpenAIAuthStatus().apiKey).toBe(false);
    posted.length = 0;
    clearPublishes(panels);

    await runtime.init();
    await writesSettled();

    expect({ judges: judgeUpdates(posted).length, openaiRows: openaiRows(posted).length, publishes: publishCounts(panels) }).toEqual({ judges: 1, openaiRows: 1, publishes: [1, 1] });
    expect(runtime.getOpenAIAuthStatus().apiKey).toBe(true);
  }, 60_000);

  it("a Prefer API key change another window makes publishes the OpenAI row, every chat's account state and the judge status once each, syncing once", async () => {
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels, true);
    const count = counter(runtime, posted, panels);

    // VS Code reports no change another window makes to global state, so a read of the flag is where this window learns of it
    expect(await count(async () => {
      await platform.state.global.update("damocles.openai.preferApiKey", true);
      runtime.preferOpenAIApiKey();
    })).toMatchObject({ judges: 1, notices: 1, syncs: 0, openaiSyncs: 1, publishes: [1, 1], keyRows: 0, claudeRows: 0, openaiRows: 1 });
    expect(openaiRows(posted)[0]).toMatchObject({ preferApiKey: true });
  }, 60_000);

  /** VS Code's global state holds a new value before its write resolves, so an account read can land in between. */
  function readWhileWriting(read: () => void): void {
    const global = platform.state.global;
    const update = global.update.bind(global);
    vi.spyOn(global, "update").mockImplementation(async (key: string, value: unknown) => {
      const written = update(key, value);
      read();
      await written;
    });
  }

  it("this window's Prefer API key toggle publishes the OpenAI row, every chat's account state and the judge status once, though a read of the flag lands while it is written", async () => {
    const { posted, panels, provider } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels, true);
    readWhileWriting(() => runtime.preferOpenAIApiKey());
    const count = counter(runtime, posted, panels);

    expect(await count(() => routerOf(provider).handleWebviewMessage({ type: "setOpenAIPreferApiKey", preferApiKey: true, requestId: "prefer" }, "p1", undefined)))
      .toMatchObject({ judges: 1, notices: 1, openaiSyncs: 1, publishes: [1, 1], openaiRows: 1 });
    expect(posted).toContainEqual({ type: "setOpenAIPreferApiKeyAck", requestId: "prefer", ok: true });
  }, 60_000);

  /** An xAI key saved and an xAI sign-in stored, which outranks it until Prefer API key is on. */
  async function xaiKeyAndSignIn(): Promise<void> {
    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    writeAuthEntry("xai", oauthEntry);
    await platform.secrets.store("damocles.xai.apiKey", "xai-key");
  }

  it("a provider's Prefer API key change another window makes posts every key row, the judge status and every chat's account state once each", async () => {
    await xaiKeyAndSignIn();
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels, true);
    const count = counter(runtime, posted, panels);

    expect(await count(async () => {
      await platform.state.global.update("damocles.xai.preferApiKey", true);
      runtime.preferProviderApiKey("xai");
    })).toMatchObject({ judges: 1, notices: 1, syncs: 1, publishes: [1, 1], keyRows: ACCOUNT_PROVIDER_IDS.length, claudeRows: 0, openaiRows: 0 });
    expect(keyStatuses(posted).find((status) => status.provider === "xai")).toMatchObject({ preferApiKey: true, active: "apiKey" });
  }, 60_000);

  it("this window's provider Prefer API key toggle syncs once and posts every key row and the judge status once, though a read of the flag lands while it is written", async () => {
    await xaiKeyAndSignIn();
    const { posted, panels, provider } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels, true);
    readWhileWriting(() => runtime.preferProviderApiKey("xai"));
    const count = counter(runtime, posted, panels);

    expect(await count(() => routerOf(provider).handleWebviewMessage({ type: "setProviderPreferApiKey", provider: "xai", preferApiKey: true, requestId: "prefer" }, "p1", undefined)))
      .toMatchObject({ judges: 1, notices: 1, syncs: 1, publishes: [1, 1], keyRows: ACCOUNT_PROVIDER_IDS.length });
    expect(posted).toContainEqual({ type: "setProviderPreferApiKeyAck", provider: "xai", requestId: "prefer", ok: true });
  }, 60_000);

  it("counts an auth.json that does not parse as a change, never as the last content that did", async () => {
    watchAuthFileWrites();
    const { posted, panels } = harness();
    const runtime = await started(panels);
    const count = counter(runtime, posted, panels);
    await count(async () => writeAuthEntry("anthropic", { type: "api_key", key: "sk-ant" }));

    expect(await count(async () => fs.writeFileSync(authPath, "{ \"anthropic\": ")))
      .toMatchObject({ judges: 1, syncs: 1, claudeRows: 1 });
  }, 60_000);

  it("a model picker change republishes every panel's account state and leaves the memory judge status alone", async () => {
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels);
    const count = counter(runtime, posted, panels);

    expect(await count(() => platform.settings.update(MODEL_PICKER_SETTING, { openai: false }, "user")))
      .toMatchObject({ judges: 0, notices: 0, publishes: [1, 1] });
  }, 60_000);

  it("the model picker setter publishes every panel's account state once, the asking panel's before its ack", async () => {
    const { posted, panels, provider } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels);
    const count = counter(runtime, posted, panels);
    let ackedBeforePublish = false;
    (panels.get("p1") as { session: { publishAccountInfo: ReturnType<typeof vi.fn> } }).session.publishAccountInfo.mockImplementation(() => {
      ackedBeforePublish ||= posted.some((m) => m.type === "setModelPickerProviderAck");
    });

    expect(await count(() => routerOf(provider).handleWebviewMessage({ type: "setModelPickerProvider", provider: "deepseek", shown: true, requestId: "pick" }, "p1", undefined)))
      .toEqual({ judges: 0, notices: 0, syncs: 0, openaiSyncs: 0, usageResets: 0, publishes: [1, 1], keyRows: 0, claudeRows: 0, openaiRows: 0 });
    expect(posted).toContainEqual({ type: "setModelPickerProviderAck", provider: "deepseek", requestId: "pick", ok: true });
    expect(ackedBeforePublish).toBe(false);
  }, 60_000);

  it("a provider sign-in that ends before pi wrote anything publishes no account state", async () => {
    const { posted, panels, provider } = harness();
    addPanel(panels, "p2");
    const runtime = await started(panels);
    vi.spyOn(runtime.modelRuntime!, "login").mockRejectedValueOnce(new Error("Login cancelled"));
    const count = counter(runtime, posted, panels);

    // the sync the sign-in's end runs, for a key change it skipped meanwhile, posts every key row and the judge status, as each sync's end does
    expect(await count(() => routerOf(provider).handleWebviewMessage({ type: "providerSignIn", provider: "openrouter" }, "p1", undefined)))
      .toEqual({ judges: 1, notices: 1, syncs: 1, openaiSyncs: 0, usageResets: 0, publishes: [0, 0], keyRows: ACCOUNT_PROVIDER_IDS.length, claudeRows: 0, openaiRows: 0 });
  }, 60_000);
});

describe("key provider status in open panels", () => {
  it.each(KEYED_PROVIDER_DEFS)("broadcasts $provider's status when its secret is stored or deleted, here or in another window", async ({ provider, key: { secretKey } }) => {
    const { posted } = harness();
    await platform.secrets.store(secretKey, "the-key");
    const signedOut = { type: "providerAuthStatusChanged", provider, external: null, signedIn: false, preferApiKey: false };
    await vi.waitFor(() => expect(keyStatuses(posted)).toEqual([{ ...signedOut, configured: true, active: "apiKey" }]));
    await platform.secrets.delete(secretKey);
    await vi.waitFor(() => expect(keyStatuses(posted).at(-1)).toEqual({ ...signedOut, configured: false, active: "none" }));
    expect(keyStatuses(posted)).toHaveLength(2);
    expect(JSON.stringify(posted)).not.toContain("the-key");
  });

  it("broadcasts nothing for an unrelated secret", async () => {
    const { posted } = harness();
    await platform.secrets.store("damocles.openai.apiKey", "sk-key");
    await vi.waitFor(() => expect(judgeUpdates(posted)).toHaveLength(1));
    expect(keyStatuses(posted)).toEqual([]);
  });

  it("refreshes image generation and the Tools status in every panel after a key sync", async () => {
    const { posted, panels } = harness();
    const second = addPanel(panels, "p2");
    const runtime = PiRuntime.get();
    (runtime as unknown as { _modelRuntime: unknown })._modelRuntime = {
      getProviderAuthStatus: () => ({ configured: false }),
      hasConfiguredAuth: () => false,
      getModelsOfType: () => [],
    };

    await runtime.syncCustomProviders(() => Promise.resolve(undefined));

    for (const [id, messages] of [["p1", posted], ["p2", second]] as const) {
      expect(messages).toContainEqual({ type: "toolStatus", data: { panel: id } });
      expect(messages).toContainEqual(expect.objectContaining({ type: "imageGenerationSettings", settings: expect.objectContaining({ openRouterConfigured: false }) }));
    }
  });

  /** A model runtime that keeps the runtime keys applied to it and reports them first, as pi's does (model-runtime.js:424-450). */
  function keyedModelRuntime(environment: ReadonlySet<string> = new Set()) {
    const runtimeKeys = new Map<string, string>();
    return {
      getProviderAuthStatus: (provider: string) =>
        runtimeKeys.has(provider) ? { configured: true, source: "runtime" } : environment.has(provider) ? { configured: true, source: "environment" } : { configured: false },
      hasConfiguredAuth: (provider: string) => runtimeKeys.has(provider) || environment.has(provider),
      getModelsOfType: () => [],
      setRuntimeApiKey: async (provider: string, key: string) => void runtimeKeys.set(provider, key),
      removeRuntimeApiKey: async (provider: string) => void runtimeKeys.delete(provider),
      logout: async () => {},
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
  }

  it("broadcasts every key status after a sync, marking a credential pi holds that Damocles did not apply", async () => {
    const { posted } = harness();
    const runtime = PiRuntime.get();
    (runtime as unknown as { _modelRuntime: unknown })._modelRuntime = keyedModelRuntime(new Set(["minimax", "xai"]));
    await platform.secrets.store("damocles.xai.apiKey", "xai-key");
    await vi.waitFor(() => expect(keyStatuses(posted)).toHaveLength(1));
    posted.length = 0;

    await runtime.syncCustomProviders((key) => platform.secrets.get(key));

    await vi.waitFor(() => expect(keyStatuses(posted)).toHaveLength(CUSTOM_PROVIDER_DEFS.length));
    const byProvider = new Map(keyStatuses(posted).map((status) => [status.provider, status]));
    const signedOut = { type: "providerAuthStatusChanged", signedIn: false, preferApiKey: false };
    expect(byProvider.get("minimax")).toEqual({ ...signedOut, provider: "minimax", configured: false, external: 'environment', active: "external" });
    expect(byProvider.get("xai")).toEqual({ ...signedOut, provider: "xai", configured: true, external: null, active: "apiKey" });
    expect(byProvider.get("deepseek")).toEqual({ ...signedOut, provider: "deepseek", configured: false, external: null, active: "none" });
  });

  it("republishes the account state in every panel, one whose session has not started included, when a sync changes it", async () => {
    const { panels } = harness();
    addPanel(panels, "p2");
    const publishes = () => [...panels.values()].map((panel) => (panel as { session: { publishAccountInfo: ReturnType<typeof vi.fn> } }).session.publishAccountInfo.mock.calls.length);
    const runtime = PiRuntime.get();
    (runtime as unknown as { _modelRuntime: unknown })._modelRuntime = keyedModelRuntime();
    const secrets = (key: string) => Promise.resolve(key === "damocles.minimax.apiKey" ? "sk-cp-plan" : undefined);

    await runtime.syncCustomProviders(secrets);
    expect(publishes()).toEqual([1, 1]);

    await runtime.syncCustomProviders(secrets);
    expect(publishes()).toEqual([1, 1]);
  });
});

describe("account state in panels that have not started", () => {
  const publishes = (panels: Map<string, unknown>) =>
    [...panels.values()].map((panel) => (panel as { session: { publishAccountInfo: ReturnType<typeof vi.fn> } }).session.publishAccountInfo.mock.calls.length);
  const authPath = path.join(PI_AGENT_DIR, "auth.json");
  afterEach(() => {
    fs.rmSync(authPath, { force: true });
  });

  it("follows a sign-in made outside Damocles before pi starts: every account-provider status and every panel's account state", async () => {
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({ "github-copilot": { type: "oauth", access: "a", refresh: "r", expires: 9_000 } }));
    platform.fileWatchers.watcher(PI_AGENT_DIR, "auth.json").fireChange(authPath);

    await vi.waitFor(() => expect(keyStatuses(posted)).toHaveLength(CUSTOM_PROVIDER_DEFS.length));
    expect(keyStatuses(posted).find((status) => status.provider === "github-copilot")).toMatchObject({ signedIn: true, signedInExpiresAt: 9_000, active: "signIn" });
    expect(publishes(panels)).toEqual([1, 1]);
    expect(PiRuntime.exists).toBe(false);
  });

  it("follows a sign-in made outside Damocles once the runtime holds the watch, though the key sync changed nothing", async () => {
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    const runtime = PiRuntime.get();
    const internals = runtime as unknown as { _modelRuntime: unknown; _initPromise: Promise<void>; _customProvidersSynced: boolean; _authWatch: Disposable | null };
    internals._initPromise = Promise.resolve();
    // past its first sync, which republishes every panel on its own
    internals._customProvidersSynced = true;
    internals._modelRuntime = {
      getProviderAuthStatus: () => ({ configured: false }),
      hasConfiguredAuth: () => false,
      getModelsOfType: () => [],
      getAvailable: async () => [],
    };
    internals._authWatch = (PiRuntime as unknown as { _holdAuthFileWatch: (factory: unknown, dir: string) => Disposable })._holdAuthFileWatch(platform.fileWatchers, PI_AGENT_DIR);
    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({ "github-copilot": { type: "oauth", access: "a", refresh: "r", expires: 9_000 } }));
    platform.fileWatchers.watcher(PI_AGENT_DIR, "auth.json").fireChange(authPath);

    await vi.waitFor(() => expect(publishes(panels)).toEqual([1, 1]));
    await vi.waitFor(() => expect(keyStatuses(posted).find((status) => status.provider === "github-copilot")).toMatchObject({ signedIn: true }));
  });

  it("follows a new acting client on a daemon's core, whose credentials and prefer flags the panels read", async () => {
    const host = createFakeRemoteHost();
    Object.assign(platform, { remote: host.remote });
    host.set("clientAuth", "client-a", { providers: {} });
    host.set("clientAuth", "client-b", { providers: { xai: { type: "oauth", hasKey: false, keySaved: true, flatFee: false, expires: 5_000 } } });
    const { posted, panels } = harness();
    addPanel(panels, "p2");

    host.setActing("client-b");

    expect(publishes(panels)).toEqual([1, 1]);
    await vi.waitFor(() => expect(keyStatuses(posted)).toHaveLength(CUSTOM_PROVIDER_DEFS.length));
    await settled();
    expect(judgeUpdates(posted)).toHaveLength(1);
    expect(keyStatuses(posted).find((status) => status.provider === "xai")).toEqual({
      type: "providerAuthStatusChanged", provider: "xai", configured: true, external: null, signedIn: true, signedInExpiresAt: 5_000, preferApiKey: false,
    });
  });

  it("follows a new acting client on a daemon's core while the runtime winds down", async () => {
    const host = createFakeRemoteHost();
    Object.assign(platform, { remote: host.remote });
    host.set("clientAuth", "client-a", { providers: {} });
    host.set("clientAuth", "client-b", { providers: {} });
    host.setActing("client-a");
    const { panels } = harness();
    addPanel(panels, "p2");
    PiRuntime.get();
    const disposed = PiRuntime.disposeInstance();
    expect(PiRuntime.exists).toBe(true);

    host.setActing("client-b");
    await disposed;

    expect(publishes(panels)).toEqual([1, 1]);
  });

  it("shows the views of a client whose host policy changed the YOLO control that policy now allows, and no other client's views", async () => {
    const host = createFakeRemoteHost();
    Object.assign(platform, { remote: host.remote });
    Object.defineProperty(platform, "capabilities", { get: () => ({ ...VSCODE_HOST_CAPABILITIES, bypassPermissions: bypassAllowed(platform) }) });
    host.set("clientPolicy", "laptop", { voice: false, allowBypass: false });
    host.set("clientPolicy", "desktop", { voice: false, allowBypass: false });
    host.setActing("desktop");
    const { panels } = harness();
    const views = new Map<string, Posted[]>([["view-laptop", []], ["view-desktop", []]]);
    const entry = panels.get("p1") as { host: Record<string, unknown> };
    entry.host["views"] = () => [{ viewKey: "view-laptop", clientId: "laptop" }, { viewKey: "view-desktop", clientId: "desktop" }];
    entry.host["viewHost"] = (viewKey: string) => ({ postMessage: async (m: Posted) => { views.get(viewKey)!.push(m); return true; } });

    host.set("clientPolicy", "laptop", { voice: false, allowBypass: true });

    const capabilities = (posted: Posted[]) => posted.flatMap((m) => (m.type === "hostCapabilities" ? [m.capabilities.bypassPermissions] : []));
    expect(capabilities(views.get("view-laptop")!)).toEqual([true]);
    expect(capabilities(views.get("view-desktop")!)).toEqual([]);
  });

  // A sign-in on the client changes no key the daemon applies, so the key sync alone would not republish unstarted panels.
  it("follows the acting client's sign-in on a daemon's core, before pi starts", async () => {
    const host = createFakeRemoteHost();
    Object.assign(platform, { remote: host.remote });
    host.set("clientAuth", "client-a", { providers: {} });
    host.setActing("client-a");
    const { posted, panels } = harness();
    addPanel(panels, "p2");

    host.set("clientAuth", "client-a", { providers: { "github-copilot": { type: "oauth", hasKey: false, flatFee: false, expires: 7_000 } } });

    expect(publishes(panels)).toEqual([1, 1]);
    await vi.waitFor(() => expect(keyStatuses(posted).find((status) => status.provider === "github-copilot")).toMatchObject({ signedIn: true, signedInExpiresAt: 7_000 }));
    expect(PiRuntime.exists).toBe(false);
  });
});

describe("account state on a daemon's core chat two devices show", () => {
  /** Device-a holds an Anthropic and an OpenAI key and an xAI sign-in, device-b nothing; device-a acts. */
  function twoDevices() {
    const host = createFakeRemoteHost();
    Object.assign(platform, { remote: host.remote });
    host.set("clientAuth", "device-a", { providers: {
      anthropic: { type: "api_key", hasKey: true, flatFee: false },
      openai: { type: "api_key", hasKey: true, flatFee: false },
      xai: { type: "oauth", hasKey: false, flatFee: false, expires: 5_000 },
    } });
    host.set("clientAuth", "device-b", { providers: {} });
    host.setActing("device-a");
    const { posted, panels, provider } = harness();
    const views = new Map<string, Posted[]>([["view-a", []], ["view-b", []]]);
    const entry = panels.get("p1") as { host: Record<string, unknown> };
    entry.host["views"] = () => [{ viewKey: "view-a", clientId: "device-a" }, { viewKey: "view-b", clientId: "device-b" }];
    entry.host["viewHost"] = (viewKey: string) => ({ postMessage: async (m: Posted) => { views.get(viewKey)!.push(m); return true; } });
    // a post to the panel reaches every view
    entry.host["postMessage"] = async (m: Posted) => {
      posted.push(m);
      for (const shown of views.values()) shown.push(m);
      return true;
    };
    return { host, posted, provider, view: (key: string) => views.get(key)! };
  }

  it("gives each device's views the key, sign-in and Claude status of that device's own account", async () => {
    const { host, posted, view } = twoDevices();

    host.set("clientAuth", "device-b", { providers: {} });

    await vi.waitFor(() => expect(keyStatuses(view("view-b"))).toHaveLength(CUSTOM_PROVIDER_DEFS.length));
    await vi.waitFor(() => expect(keyStatuses(view("view-a"))).toHaveLength(CUSTOM_PROVIDER_DEFS.length));
    const xai = (key: string) => keyStatuses(view(key)).find((status) => status.provider === "xai");
    expect([xai("view-a")?.signedIn, xai("view-b")?.signedIn]).toEqual([true, false]);
    const claude = (key: string) => view(key).flatMap((m) => (m.type === "claudeAuthStatusChanged" ? [m.mode] : []));
    expect([claude("view-a"), claude("view-b")]).toEqual([["apikey"], ["none"]]);
    expect(posted.filter((m) => m.type === "providerAuthStatusChanged" || m.type === "claudeAuthStatusChanged")).toEqual([]);
  });

  it("gives each device's views the Claude billing its own sign-in chose, whatever subscription plugin the host's pi lists", async () => {
    const { host, view } = twoDevices();
    expect(PI_AGENT_DIR.startsWith(tmpRoot)).toBe(true);
    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(PI_AGENT_DIR, "settings.json"), JSON.stringify({ packages: [SUBSCRIPTION_SOURCE] }));
    host.set("clientAuth", "device-b", { providers: { anthropic: { type: "oauth", hasKey: false, flatFee: false, expires: 5_000 } } });
    host.set("clientAuth", "device-a", { providers: { anthropic: { type: "oauth", hasKey: false, flatFee: false, expires: 5_000, allowance: true } } });

    const claude = (key: string) => view(key).flatMap((m) => (m.type === "claudeAuthStatusChanged" ? [m.mode] : []));
    await vi.waitFor(() => expect([claude("view-a").at(-1), claude("view-b").at(-1)]).toEqual(["allowance", "extra"]));
    fs.rmSync(path.join(PI_AGENT_DIR, "settings.json"), { force: true });
  });

  it("gives each device's views the memory judge its own credentials choose, before pi starts", async () => {
    const { view } = twoDevices();

    PiRuntime.notifyMemoryJudgeChange();

    await vi.waitFor(() => expect([judgeUpdates(view("view-a")), judgeUpdates(view("view-b"))].map((m) => m.length)).toEqual([1, 1]));
    expect(judgeUpdates(view("view-a"))[0]?.memoryJudge).toEqual({ kind: "classifier", via: "openai" });
    expect(judgeUpdates(view("view-b"))[0]).toEqual({
      type: "memoryJudgeStatus",
      memoryJudge: { kind: "unknown" },
      classifierCredentials: { typesafe: "no-key", openrouter: "no-key", openai: "no-key" },
    });
  });

  it("refuses a key save or clear from a device's Settings to that device alone, posting no judge status and writing no secret", async () => {
    const { view, provider } = twoDevices();
    const router = routerOf(provider);

    await router.handleWebviewMessage({ type: "setProviderApiKey", provider: "typesafe", key: "ts-key", requestId: "save" }, "p1", undefined, "view-b");
    await router.handleWebviewMessage({ type: "clearProviderApiKey", provider: "typesafe", requestId: "clear" }, "p1", undefined, "view-b");
    await settled();

    const acks = (key: string) => view(key).filter((m) => m.type === "setProviderApiKeyAck" || m.type === "clearProviderApiKeyAck").map((m) => m.type);
    expect([acks("view-a"), acks("view-b")]).toEqual([[], ["setProviderApiKeyAck", "clearProviderApiKeyAck"]]);
    expect([judgeUpdates(view("view-a")), judgeUpdates(view("view-b"))].map((m) => m.length)).toEqual([0, 0]);
    expect(platform.secrets.entries.size).toBe(0);
  });

  // A key saved or cleared on a device's own computer reaches the daemon's core as that device's clientAuth.
  it("before pi starts, a device's key saved posts each device's judge status once, read as that device", async () => {
    const { host, view } = twoDevices();
    const deviceA = host.remote.clients.auth("device-a")!;

    host.set("clientAuth", "device-a", { providers: { ...deviceA.providers, typesafe: { type: "none", hasKey: true, keySaved: true, flatFee: false } } });
    await settled();

    expect([judgeUpdates(view("view-a")), judgeUpdates(view("view-b"))].map((posts) => posts.map((m) => m.memoryJudge)))
      .toEqual([[{ kind: "classifier", via: "typesafe" }], [{ kind: "unknown" }]]);
    expect(PiRuntime.exists).toBe(false);
  });

  it("with the runtime started, a device's key saved and then cleared posts each device's judge status once each, read as that device", async () => {
    const { host, view, provider } = twoDevices();
    await PiRuntime.get().init();
    await settled();
    let notices = 0;
    subscriptions.push({ dispose: PiRuntime.onMemoryJudgeChange(() => void notices++) });
    const panel = (provider as unknown as { panelManager: { getPanels: () => Map<string, { session: { publishAccountInfo: ReturnType<typeof vi.fn> } }> } }).panelManager.getPanels().get("p1")!;
    const clear = () => { view("view-a").length = 0; view("view-b").length = 0; notices = 0; panel.session.publishAccountInfo.mockClear(); };
    const judges = () => [judgeUpdates(view("view-a")).map((m) => m.memoryJudge), judgeUpdates(view("view-b")).map((m) => m.memoryJudge)];
    const deviceA = host.remote.clients.auth("device-a")!;
    clear();

    host.set("clientAuth", "device-a", { providers: { ...deviceA.providers, typesafe: { type: "none", hasKey: true, keySaved: true, flatFee: false } } });
    await settled();

    expect(judges()).toEqual([[{ kind: "classifier", via: "typesafe" }], [{ kind: "unknown" }]]);
    expect(notices).toBe(1);
    // each account row once per device and delta, read as that device
    expect([keyStatuses(view("view-a")).length, keyStatuses(view("view-b")).length]).toEqual([ACCOUNT_PROVIDER_IDS.length, ACCOUNT_PROVIDER_IDS.length]);
    expect(keyStatuses(view("view-a")).find((status) => status.provider === "typesafe")).toMatchObject({ configured: true });
    // a chat that has not started, whose account state the key sync's listener publishes
    expect(panel.session.publishAccountInfo).toHaveBeenCalledTimes(1);
    clear();

    host.set("clientAuth", "device-a", deviceA);
    await settled();

    expect(judges()).toEqual([[{ kind: "classifier", via: "openai" }], [{ kind: "unknown" }]]);
    expect(notices).toBe(1);
    expect([keyStatuses(view("view-a")).length, keyStatuses(view("view-b")).length]).toEqual([ACCOUNT_PROVIDER_IDS.length, ACCOUNT_PROVIDER_IDS.length]);
    expect(panel.session.publishAccountInfo).toHaveBeenCalledTimes(1);
  }, 60_000);

  type PanelEntry = { session: { publishAccountInfo: ReturnType<typeof vi.fn> } };
  const panelOf = (provider: ChatPanelProvider): PanelEntry =>
    (provider as unknown as { panelManager: { getPanels: () => Map<string, PanelEntry> } }).panelManager.getPanels().get("p1")!;
  const withTypesafeKey = (host: ReturnType<typeof createFakeRemoteHost>) =>
    ({ providers: { ...host.remote.clients.auth("device-a")!.providers, typesafe: { type: "none", hasKey: true, keySaved: true, flatFee: false } } }) as const;

  /** From now on, what each device's views got for a change (view-a's, then view-b's) and how often the panel published its account state. */
  function devicePosts(view: (key: string) => Posted[], panel: PanelEntry) {
    const clear = () => {
      view("view-a").length = 0;
      view("view-b").length = 0;
      panel.session.publishAccountInfo.mockClear();
    };
    clear();
    const perView = (count: (posted: Posted[]) => unknown) => ["view-a", "view-b"].map((key) => count(view(key)));
    return () => {
      const posts = {
        judges: perView((posted) => judgeUpdates(posted).map((m) => m.memoryJudge)),
        keyRows: perView((posted) => keyStatuses(posted).length),
        claudeRows: perView((posted) => posted.filter((m) => m.type === "claudeAuthStatusChanged").length),
        openaiRows: perView((posted) => posted.filter((m) => m.type === "openaiAuthStatusChanged").length),
        publishes: panel.session.publishAccountInfo.mock.calls.length,
      };
      clear();
      return posts;
    };
  }
  const oncePerDevice = (judgeA: unknown) => ({
    judges: [[judgeA], [{ kind: "unknown" }]],
    keyRows: [ACCOUNT_PROVIDER_IDS.length, ACCOUNT_PROVIDER_IDS.length],
    claudeRows: [1, 1],
    openaiRows: [1, 1],
    publishes: 1,
  });

  it("with the runtime started, a device's key saved publishes a started chat's account state once", async () => {
    const { host, provider } = twoDevices();
    const runtime = PiRuntime.get();
    await runtime.init();
    const panel = panelOf(provider);
    runtime.registerSessionMutator("held-session", panel.session as never);
    await settled();
    panel.session.publishAccountInfo.mockClear();

    host.set("clientAuth", "device-a", withTypesafeKey(host));
    await settled();

    expect(panel.session.publishAccountInfo).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("with the runtime started, a device's key saved whose availability refresh fails still posts each device's rows, judge status and account state once", async () => {
    const { host, view, provider } = twoDevices();
    const runtime = PiRuntime.get();
    await runtime.init();
    await settled();
    vi.spyOn(runtime.modelRuntime!, "refresh").mockRejectedValueOnce(new Error("models.json could not be read"));
    const posts = devicePosts(view, panelOf(provider));

    host.set("clientAuth", "device-a", withTypesafeKey(host));
    await settled();

    expect(posts()).toEqual(oncePerDevice({ kind: "classifier", via: "typesafe" }));
  }, 60_000);

  it("once the runtime is disposed, a device's key saved posts each device's rows, judge status and account state once", async () => {
    const { host, view, provider } = twoDevices();
    await PiRuntime.get().init();
    await PiRuntime.disposeInstance();
    expect(PiRuntime.observesClientAuth).toBe(false);
    const posts = devicePosts(view, panelOf(provider));

    host.set("clientAuth", "device-a", withTypesafeKey(host));
    await settled();

    expect(posts()).toEqual(oncePerDevice({ kind: "classifier", via: "typesafe" }));
  }, 60_000);

  it("with the runtime's init failed after its broker exists, each device's key saved or cleared posts each device's rows, judge status and account state once and starts no init; once a demand's init succeeds, the key sync posts them", async () => {
    const { host, view, provider } = twoDevices();
    const deviceA = host.remote.clients.auth("device-a")!;
    const pi = (await initPiLoader())!;
    const create = vi.spyOn(pi.ModelRuntime, "create").mockRejectedValue(new Error("models.json could not be read"));
    try {
      await expect(PiRuntime.get().init()).rejects.toThrow("models.json could not be read");
      expect(PiRuntime.observesClientAuth).toBe(true);
      await settled();
      const posts = devicePosts(view, panelOf(provider));

      host.set("clientAuth", "device-a", withTypesafeKey(host));
      await settled();

      expect(posts()).toEqual(oncePerDevice({ kind: "classifier", via: "typesafe" }));
      expect(create).toHaveBeenCalledTimes(1);

      // a credential cannot be what failed init, so even once init could succeed a delta does not retry it
      create.mockRestore();
      const created = vi.spyOn(pi.ModelRuntime, "create");
      host.set("clientAuth", "device-a", deviceA);
      await settled();

      expect(posts()).toEqual(oncePerDevice({ kind: "classifier", via: "openai" }));
      expect(created).not.toHaveBeenCalled();
      expect(PiRuntime.get().modelRuntime).toBeNull();

      // a chat's start is the demand that retries it
      await PiRuntime.get().init();
      await settled();
      posts();
      let notices = 0;
      subscriptions.push({ dispose: PiRuntime.onMemoryJudgeChange(() => void notices++) });

      host.set("clientAuth", "device-a", withTypesafeKey(host));
      await settled();

      expect(posts()).toEqual(oncePerDevice({ kind: "classifier", via: "typesafe" }));
      expect([created.mock.calls.length, notices]).toEqual([1, 1]);
    } finally {
      create.mockRestore();
    }
  }, 60_000);

  it.each([
    ["succeeds", true],
    ["fails", false],
  ] as const)("a device's key saved while the runtime's init runs, which then %s, posts each device's rows, judge status and account state once", async (_outcome, succeeds) => {
    const { host, view, provider } = twoDevices();
    const pi = (await initPiLoader())!;
    const createModelRuntime = pi.ModelRuntime.create.bind(pi.ModelRuntime);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = vi.spyOn(pi.ModelRuntime, "create").mockImplementation((async (...args: Parameters<typeof createModelRuntime>) => {
      await released;
      if (!succeeds) throw new Error("models.json could not be read");
      return createModelRuntime(...args);
    }) as never);
    try {
      const init = PiRuntime.get().init();
      await vi.waitFor(() => expect(create).toHaveBeenCalled());
      expect(PiRuntime.observesClientAuth).toBe(true);
      const posts = devicePosts(view, panelOf(provider));

      host.set("clientAuth", "device-a", withTypesafeKey(host));
      release();
      await init.catch(() => undefined);
      await settled();

      expect(posts()).toEqual(oncePerDevice({ kind: "classifier", via: "typesafe" }));
    } finally {
      create.mockRestore();
    }
  }, 60_000);

  it("deltas while the runtime's init runs wait for that one attempt, and its failure is reported once, never once per delta", async () => {
    const { host } = twoDevices();
    const logged: string[] = [];
    installLogSink({ appendLine: (line) => void logged.push(line), show: () => undefined, dispose: () => undefined });
    const pi = (await initPiLoader())!;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = vi.spyOn(pi.ModelRuntime, "create").mockImplementation((async () => {
      await released;
      throw new Error("models.json could not be read");
    }) as never);
    try {
      const init = PiRuntime.get().init();
      await vi.waitFor(() => expect(create).toHaveBeenCalled());
      const deviceA = host.remote.clients.auth("device-a")!;

      host.set("clientAuth", "device-a", withTypesafeKey(host));
      host.set("clientAuth", "device-a", deviceA);
      host.set("clientAuth", "device-b", { providers: { openai: { type: "api_key", hasKey: true, flatFee: false } } });
      release();
      await expect(init).rejects.toThrow("models.json could not be read");
      await settled();

      expect(create).toHaveBeenCalledTimes(1);
      // the attempt's own timing line, and nothing from the deltas that waited for it
      expect(logged.filter((line) => line.includes("runtime.init"))).toHaveLength(1);
      expect(logged.filter((line) => line.includes("models.json could not be read"))).toEqual([]);
    } finally {
      create.mockRestore();
    }
  }, 60_000);

  it("restates each device's own OpenAI status after one device's refused ChatGPT sign-out", async () => {
    const { view, provider } = twoDevices();
    const router = (provider as unknown as { messageRouter: { handleWebviewMessage: (message: unknown, panelId: string, view: undefined, viewKey: string) => Promise<void> } }).messageRouter;

    await router.handleWebviewMessage({ type: "signOutChatGPT" }, "p1", undefined, "view-b");

    const openai = (key: string) => view(key).flatMap((m) => (m.type === "openaiAuthStatusChanged" ? [m.status.apikey.configured] : []));
    expect([openai("view-a"), openai("view-b")]).toEqual([[true], [false]]);
  });

  it("device A's clientAuth gaining an OpenAI key posts A's OpenAI status to A's views and B's to B's views", async () => {
    const { host, posted, view } = twoDevices();
    host.set("clientAuth", "device-a", { providers: {} });
    const openai = (key: string) => view(key).flatMap((m) => (m.type === "openaiAuthStatusChanged" ? [m.status.apikey.configured] : []));
    await vi.waitFor(() => expect([openai("view-a").at(-1), openai("view-b").at(-1)]).toEqual([false, false]));

    host.set("clientAuth", "device-a", { providers: { openai: { type: "api_key", hasKey: true, flatFee: false } } });

    await vi.waitFor(() => expect([openai("view-a").at(-1), openai("view-b").at(-1)]).toEqual([true, false]));
    expect(posted.filter((m) => m.type === "openaiAuthStatusChanged")).toEqual([]);
  });

  it("before the runtime exists, a chat acting for device A reads A's prefer-API-key flag and one acting for B reads B's", () => {
    const { host, provider } = twoDevices();
    host.set("clientAuth", "device-a", { providers: { openai: { type: "api_key", hasKey: true, flatFee: false, preferApiKey: true } } });
    host.set("clientAuth", "device-b", { providers: { openai: { type: "api_key", hasKey: true, flatFee: false } } });
    // what the host's state holds is no device's flag
    void platform.state.global.update("damocles.openai.preferApiKey", true);
    const prefer = (provider as unknown as { sessionManager: { getPreferOpenAIApiKey: () => boolean } }).sessionManager;

    expect([asClient(host.remote, "device-a", () => prefer.getPreferOpenAIApiKey()), asClient(host.remote, "device-b", () => prefer.getPreferOpenAIApiKey())]).toEqual([true, false]);
    expect(PiRuntime.exists).toBe(false);
  });

  it("the OpenAI prefer-API-key writer on a daemon's core acks a refusal and writes no state", async () => {
    const { view, provider } = twoDevices();
    const router = (provider as unknown as { messageRouter: { handleWebviewMessage: (message: unknown, panelId: string, view: undefined, viewKey: string) => Promise<void> } }).messageRouter;

    await router.handleWebviewMessage({ type: "setOpenAIPreferApiKey", requestId: "r1", preferApiKey: true }, "p1", undefined, "view-b");

    expect(view("view-b").filter((m) => m.type === "setOpenAIPreferApiKeyAck")).toEqual([{ type: "setOpenAIPreferApiKeyAck", requestId: "r1", ok: false, error: { message: "Sign-ins change only in the User tab on your computer." } }]);
    expect(platform.state.global.get("damocles.openai.preferApiKey")).toBeUndefined();
    expect(PiRuntime.exists).toBe(false);
  });

  it("gives each device's views its own prefer-API-key choices, never the acting device's", async () => {
    const { host, view, provider } = twoDevices();
    const router = (provider as unknown as { messageRouter: { handleWebviewMessage: (message: unknown, panelId: string, view: undefined, viewKey: string) => Promise<void> } }).messageRouter;
    // the acting device's own flags, which the state mirror carries
    await platform.state.global.update("damocles.openai.preferApiKey", true);
    await platform.state.global.update("damocles.xai.preferApiKey", true);
    host.set("clientAuth", "device-a", { providers: {
      openai: { type: "api_key", hasKey: true, flatFee: false, preferApiKey: true },
      xai: { type: "none", hasKey: true, keySaved: true, flatFee: false, preferApiKey: true },
    } });
    host.set("clientAuth", "device-b", { providers: {
      openai: { type: "api_key", hasKey: true, flatFee: false },
      xai: { type: "none", hasKey: true, keySaved: true, flatFee: false },
    } });
    await router.handleWebviewMessage({ type: "signOutChatGPT" }, "p1", undefined, "view-b");

    const xai = (key: string) => keyStatuses(view(key)).filter((status) => status.provider === "xai").at(-1)?.preferApiKey;
    const openai = (key: string) => view(key).flatMap((m) => (m.type === "openaiAuthStatusChanged" ? [m.preferApiKey] : []));
    await vi.waitFor(() => expect([xai("view-a"), xai("view-b")]).toEqual([true, false]));
    // each clientAuth delta and the refused sign-out restate it, every post as its own device reads it
    expect([[...new Set(openai("view-a"))], [...new Set(openai("view-b"))]]).toEqual([[true], [false]]);
  });

  it("reads each device's classifier credentials from its own account once pi holds the acting device's", () => {
    const { host } = twoDevices();
    const runtime = PiRuntime.get();
    // pi's availability snapshot holds the acting device's credentials
    (runtime as unknown as { _modelRuntime: unknown })._modelRuntime = { hasConfiguredAuth: (provider: string) => provider === "openai" };

    const openai = (clientId: string) => asClient(host.remote, clientId, () => runtime.classifierCredentials().openai);

    expect([openai("device-a"), openai("device-b")]).toEqual(["ok", "no-key"]);
  });
});
