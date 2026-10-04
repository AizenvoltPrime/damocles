import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

/** Compass in the provider: one index per targeted folder, status to that folder's panels, views on the focused panel's folder. */
const { tmpRoot, fakeHome, folderA, folderB } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-compass-folders-"));
  return {
    tmpRoot: root,
    fakeHome: nodePath.join(root, "home"),
    folderA: nodePath.join(root, "home", "A"),
    folderB: nodePath.join(root, "home", "B"),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

/** Records every Compass worker the provider starts, by the folder its `init` names. */
const startedWorkers = vi.hoisted(() => [] as string[]);
vi.mock("worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("worker_threads")>();
  class FakeWorker {
    private onMessage: ((msg: unknown) => void) | undefined;
    on(event: string, listener: (msg: unknown) => void): void {
      if (event === "message") this.onMessage = listener;
    }
    postMessage(message: { type: string; id: number; workspacePath?: string }): void {
      if (message.type === "init" && message.workspacePath) startedWorkers.push(message.workspacePath);
      this.onMessage?.({ type: "response", id: message.id, ok: true, data: { state: "ready" } });
    }
    terminate(): void {}
  }
  return { ...actual, Worker: FakeWorker };
});

import { ChatPanelProvider } from "../index";
import { installFakePlatform, type FakePlatform } from "../../../__mocks__/fake-platform";
import { PiRuntime } from "../../pi-session/pi-runtime";
import { folderKey } from "../../workspace-folders/folder-key";
import type { CompassRegistry } from "../../compass/compass-registry";
import type { CompassService } from "../../compass";
import type { CompassViewsHandle } from "../types";
import type { WorkspaceFolderRegistry } from "../../workspace-folders/folder-registry";
import type { MemoryService } from "../../memory";
import type { StorageManager } from "../storage-manager";
import type { WorkspaceManager } from "../workspace-manager";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";

type Posted = ExtensionToWebviewMessage;

/** What the provider last pointed the host's Compass views at. */
interface FakeCompassViews extends CompassViewsHandle {
  active: CompassService | null;
  description: string | undefined;
}

interface Internals {
  compassRegistry: CompassRegistry;
  compassViews: FakeCompassViews;
  folderRegistry: WorkspaceFolderRegistry;
  memoryService: MemoryService;
  storageManager: StorageManager;
  workspaceManager: WorkspaceManager;
  sessionManager: { createSessionForPanel: (...args: unknown[]) => Promise<unknown> };
  releaseFolder: (key: string) => Promise<void>;
  panelManager: {
    getPanels: () => Map<string, unknown>;
    setLastActivePanel: (panelId: string | null) => void;
  };
}

let platform: FakePlatform;
let provider: ChatPanelProvider | null;
function setFolders(paths: string[]): void {
  platform.workspaceFolders.setFolders(paths.map((p) => ({ fsPath: p, name: path.basename(p) })));
}

/** Replace the open folders, firing the folder change event. */
function changeFolders(paths: string[]): void {
  setFolders(paths);
}

function createProvider(): { provider: ChatPanelProvider; internals: Internals } {
  provider = new ChatPanelProvider(platform, {
    subscriptions: [],
    createCompassViews: () => {
      const views: FakeCompassViews = {
        active: null,
        description: undefined,
        register: () => {},
        setActive: (service, description) => {
          views.active = service;
          views.description = description;
        },
        dispose: () => {},
      };
      return views;
    },
  });
  return { provider, internals: provider as unknown as Internals };
}

function attachPanel(internals: Internals, panelId: string, fsPath: string, dispose: () => Promise<void> = async () => {}): Posted[] {
  const posted: Posted[] = [];
  internals.panelManager.getPanels().set(panelId, {
    host: { postMessage: async (m: Posted) => { posted.push(m); return true; }, close: () => {}, setFolderLabel: () => {} },
    session: { dispose, hasConversation: () => false, persistenceSessionId: null, setActivityListener: () => {}, setTurnSettledListener: () => {} },
    folder: { key: folderKey(fsPath), fsPath, name: path.basename(fsPath), label: path.basename(fsPath), projectScope: true },
    permissionHandler: { dispose: async () => {} },
    ideContextManager: { dispose: () => {} },
    disposables: [],
  });
  return posted;
}

function target(fsPath: string) {
  return { key: folderKey(fsPath), fsPath, name: path.basename(fsPath), label: path.basename(fsPath), projectScope: true };
}

beforeEach(() => {
  startedWorkers.length = 0;
  provider = null;
  fs.mkdirSync(folderA, { recursive: true });
  fs.mkdirSync(folderB, { recursive: true });
  platform = installFakePlatform({ settings: { user: { "damocles.compass.enabled": true } } });
});

afterEach(async () => {
  await provider?.dispose();
  vi.restoreAllMocks();
  setFolders([]);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("Compass per folder in the chat panel provider", () => {
  it("starts no worker in a multi-root window until a panel targets a folder (AC5.4)", () => {
    setFolders([folderA, folderB]);
    const { internals } = createProvider();

    expect(startedWorkers).toEqual([]);
    expect(internals.compassRegistry.keys()).toEqual([]);
  });

  it("indexes the only folder of a single-folder window at startup, as before (AC5.5)", async () => {
    setFolders([folderA]);
    createProvider();

    await vi.waitFor(() => expect(startedWorkers).toEqual([folderA]));
  });

  it("shows no folder name in the views of a single-folder window (AC5.5)", () => {
    setFolders([folderA]);
    const { internals } = createProvider();

    expect(internals.compassViews.description).toBeUndefined();
  });

  it("sends a folder's status only to that folder's panels", () => {
    setFolders([folderA, folderB]);
    const { internals } = createProvider();
    const postedA = attachPanel(internals, "p1", folderA);
    const postedB = attachPanel(internals, "p2", folderB);
    const serviceB = internals.compassRegistry.acquire(target(folderB))!;

    (serviceB as unknown as { _emitStatus: () => void })._emitStatus();

    expect(postedB.filter((m) => m.type === "compassStatusUpdate")).toHaveLength(1);
    expect(postedA.filter((m) => m.type === "compassStatusUpdate")).toHaveLength(0);
  });

  it("points the views at the focused panel's folder and names it (AC5.3)", () => {
    setFolders([folderA, folderB]);
    const { internals } = createProvider();
    attachPanel(internals, "p1", folderA);
    attachPanel(internals, "p2", folderB);
    const serviceA = internals.compassRegistry.acquire(target(folderA))!;
    const serviceB = internals.compassRegistry.acquire(target(folderB))!;

    internals.panelManager.setLastActivePanel("p2");
    expect(internals.compassViews.active).toBe(serviceB);
    expect(internals.compassViews.description).toBe("B");

    internals.panelManager.setLastActivePanel("p1");
    expect(internals.compassViews.active).toBe(serviceA);
    expect(internals.compassViews.description).toBe("A");
  });

  it("releases a removed folder's Compass only after the sessions running there are disposed", async () => {
    setFolders([folderA, folderB]);
    const { internals } = createProvider();
    internals.sessionManager.createSessionForPanel = async () => { throw new Error("no session in this test"); };
    let finishDispose!: () => void;
    const disposing = new Promise<void>((resolve) => { finishDispose = resolve; });
    const dispose = vi.fn(() => disposing);
    attachPanel(internals, "p1", folderB, dispose);
    const serviceB = internals.compassRegistry.start(target(folderB))!;
    await vi.waitFor(() => expect(startedWorkers).toEqual([folderB]));

    changeFolders([folderA]);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(internals.compassRegistry.get(folderKey(folderB))).toBe(serviceB);

    finishDispose();
    await vi.waitFor(() => expect(internals.compassRegistry.get(folderKey(folderB))).toBeUndefined());
  });

  it("runs every release step of a folder even when one of them fails", async () => {
    setFolders([folderA, folderB]);
    const { internals } = createProvider();
    const disposeFolder = vi.fn(async () => {});
    vi.spyOn(PiRuntime, "exists", "get").mockReturnValue(true);
    vi.spyOn(PiRuntime, "get").mockReturnValue({ disposeFolder } as never);
    vi.spyOn(internals.compassRegistry, "release").mockRejectedValue(new Error("compass dispose failed"));
    const workspaceDispose = vi.spyOn(internals.workspaceManager, "disposeFolder");

    await expect(internals.releaseFolder(folderKey(folderB))).resolves.toBeUndefined();

    expect(disposeFolder).toHaveBeenCalledWith(folderKey(folderB));
    expect(workspaceDispose).toHaveBeenCalledWith(folderKey(folderB));
  });

  it("re-lists sessions and memory roots on a folder change, but not when only the default folder changed", async () => {
    setFolders([folderA, folderB]);
    const { internals } = createProvider();
    const reload = vi.spyOn(internals.storageManager, "reloadFolders").mockResolvedValue();
    const roots = vi.spyOn(internals.memoryService, "setWorkspaceRoots");

    await internals.folderRegistry.setDefault(folderKey(folderB));
    expect(reload).not.toHaveBeenCalled();
    expect(roots).not.toHaveBeenCalled();

    changeFolders([folderA]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(roots).toHaveBeenCalledWith([folderA]);
  });
});
