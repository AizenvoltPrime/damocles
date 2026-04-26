import { describe, it, expect } from "vitest";
import {
  buildSetModeMessage,
  buildSensitivityMessage,
  buildEndOfTurnMessage,
  buildMaxUtteranceMessage,
  buildGpuMessage,
  formatVoiceFilesBytes,
} from "../jarvis-settings-logic";

describe("JarvisSettings message builders", () => {
  it("set mode -> setVoiceMode wake-word", () => {
    expect(buildSetModeMessage("wake-word")).toEqual({ type: "setVoiceMode", mode: "wake-word" });
  });

  it("set mode -> setVoiceMode push-to-talk", () => {
    expect(buildSetModeMessage("push-to-talk")).toEqual({ type: "setVoiceMode", mode: "push-to-talk" });
  });

  it("set mode -> setVoiceMode off disables voice entirely", () => {
    expect(buildSetModeMessage("off")).toEqual({ type: "setVoiceMode", mode: "off" });
  });

  it("sensitivity slider passes through float value", () => {
    const msg = buildSensitivityMessage(0.42);
    expect(msg).toEqual({ type: "setVoiceWakeWordSensitivity", sensitivity: 0.42 });
  });

  it("end-of-turn message rounds non-integer ms to integer", () => {
    const msg = buildEndOfTurnMessage(799.6);
    expect(msg).toEqual({ type: "setVoiceEndOfTurnSilenceMs", ms: 800 });
  });

  it("max utterance message rounds non-integer ms to integer", () => {
    const msg = buildMaxUtteranceMessage(29999.9);
    expect(msg).toEqual({ type: "setVoiceMaxUtteranceMs", ms: 30000 });
  });

  it("gpu message preserves preference value", () => {
    expect(buildGpuMessage("auto")).toEqual({ type: "setVoiceLocalGpu", preference: "auto" });
    expect(buildGpuMessage("cuda")).toEqual({ type: "setVoiceLocalGpu", preference: "cuda" });
    expect(buildGpuMessage("cpu")).toEqual({ type: "setVoiceLocalGpu", preference: "cpu" });
  });
});

describe("formatVoiceFilesBytes", () => {
  it("returns null when there's nothing on disk", () => {
    expect(formatVoiceFilesBytes(0)).toBeNull();
    expect(formatVoiceFilesBytes(-1)).toBeNull();
  });

  it("formats bytes >= 1 GB as GB with one decimal", () => {
    expect(formatVoiceFilesBytes(8_400_000_000)).toBe("8.4 GB");
  });

  it("formats bytes between 1 MB and 1 GB as MB", () => {
    expect(formatVoiceFilesBytes(250_000_000)).toBe("250 MB");
  });

  it("formats sub-1MB bytes as 0 MB", () => {
    expect(formatVoiceFilesBytes(1)).toBe("0 MB");
  });
});
