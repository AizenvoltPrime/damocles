import { describe, it, expect, vi } from "vitest";

vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import { createHistoryHandlers } from "../history-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";
import type { SkippedFile } from "../../../../../shared/types/session";

const FILES: SkippedFile[] = [{ path: "renders/raw.rgba", bytes: 1024, reason: "size" }];

function setup(read: () => Promise<{ ok: true; value: SkippedFile[] } | { ok: false; error: string }>) {
  const posted: ExtensionToWebviewMessage[] = [];
  const readSkippedFiles = vi.fn(read);
  const deps = {
    postMessage: vi.fn((_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); }),
    historyManager: { readSkippedFiles },
  } as unknown as HandlerDependencies;
  const ctx = { host: {}, session: { currentSessionId: "sess-1" }, folder: { fsPath: "/ws" } } as unknown as HandlerContext;
  const handler = createHistoryHandlers(deps).requestSkippedFiles!;
  const send = (target: unknown) => handler({ type: "requestSkippedFiles", target } as never, ctx);
  return { send, posted, readSkippedFiles };
}

describe("requestSkippedFiles", () => {
  it("reads the list for a checkpoint and echoes its target", async () => {
    const { send, posted, readSkippedFiles } = setup(async () => ({ ok: true, value: FILES }));
    await send({ kind: "turn", userEntryId: "u1" });
    expect(readSkippedFiles).toHaveBeenCalledWith("/ws", "sess-1", { kind: "turn", userEntryId: "u1" });
    expect(posted).toEqual([{ type: "skippedFiles", target: { kind: "turn", userEntryId: "u1" }, files: FILES }]);
  });

  it("answers a failed read with no list, so the view shows its error instead of loading forever", async () => {
    const { send, posted } = setup(async () => ({ ok: false, error: "no checkpoint" }));
    await send({ kind: "restore-point", id: "rw1" });
    expect(posted).toEqual([{ type: "skippedFiles", target: { kind: "restore-point", id: "rw1" }, files: null }]);
  });

  it("answers an id that is not a checkpoint id with no list and never reads", async () => {
    const { send, posted, readSkippedFiles } = setup(async () => ({ ok: true, value: FILES }));
    await send({ kind: "turn", userEntryId: "../other" });
    expect(readSkippedFiles).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "skippedFiles", target: { kind: "turn", userEntryId: "../other" }, files: null }]);
  });

  it("drops a target it cannot echo", async () => {
    const { send, posted, readSkippedFiles } = setup(async () => ({ ok: true, value: FILES }));
    await send({ kind: "disk", id: "x" });
    await send(null);
    expect(readSkippedFiles).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });
});
