import { describe, expect, it } from "vitest";
import {
  encodeInbound,
  parseOutbound,
  parseOutboundLoose,
  PROTOCOL_VERSION,
} from "../protocol";

describe("protocol", () => {
  it("encodes and validates init", () => {
    const json = encodeInbound({
      type: "init",
      protocol_version: PROTOCOL_VERSION,
      wake_word: "hey_jarvis",
      wake_sensitivity: 0.5,
      end_of_turn_silence_ms: 800,
      max_utterance_ms: 30000,
      tts_enabled: false,
      tts_voice: "alloy",
      diagnostics: false,
    });
    const back = JSON.parse(json);
    expect(back.type).toBe("init");
    expect(back.wake_sensitivity).toBe(0.5);
  });

  it("rejects out-of-range sensitivity", () => {
    expect(() =>
      encodeInbound({
        type: "init",
        protocol_version: 1,
        wake_word: "hey_jarvis",
        wake_sensitivity: 1.5,
        end_of_turn_silence_ms: 800,
        max_utterance_ms: 30000,
        tts_enabled: false,
        tts_voice: "x",
        diagnostics: false,
      }),
    ).toThrow();
  });

  it("parses outbound transcript_final", () => {
    const msg = parseOutbound(
      JSON.stringify({ type: "transcript_final", text: "hello", duration_ms: 150 }),
    );
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("transcript_final");
    if (msg!.type === "transcript_final") {
      expect(msg!.text).toBe("hello");
      expect(msg!.duration_ms).toBe(150);
    }
  });

  it("rejects unknown outbound types", () => {
    expect(parseOutbound(JSON.stringify({ type: "unknown_event" }))).toBeNull();
  });

  it("round-trips ready message", () => {
    const ready = parseOutboundLoose({
      type: "ready",
      protocol_version: 1,
      device: "cpu",
      vram_mb_free: 0,
      models_loaded: ["wake", "vad", "asr"],
    });
    expect(ready.type).toBe("ready");
  });
});
