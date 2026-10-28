import { describe, expect, it } from "vitest";
import { partialStreamKey } from "../partial-stream";

describe("partialStreamKey", () => {
  it("keys a partial by its stream and field set, and nothing else, a null or primitive post included", () => {
    const key = partialStreamKey({ type: "partial", data: { messageId: "m1", streamingText: "a" } });
    expect(key).toBe(partialStreamKey({ type: "partial", data: { streamingText: "ab", messageId: "m1" } }));
    expect(partialStreamKey({ type: "partial", data: { messageId: "m2", streamingText: "a" } })).not.toBe(key);
    for (const message of [null, undefined, "partial", 7, { type: "toolStatus" }, { type: "partial", data: null }]) {
      expect(partialStreamKey(message)).toBeUndefined();
    }
  });
});
