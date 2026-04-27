import { describe, expect, it } from "vitest";
import {
  ensurePortAudio,
  getPortAudioInstallInstructions,
  MissingSystemLibraryError,
} from "../system-libs-check";

describe("getPortAudioInstallInstructions", () => {
  it("names libportaudio2/portaudio across linux distros", () => {
    const msg = getPortAudioInstallInstructions("linux");
    expect(msg).toContain("libportaudio2");
    expect(msg).toContain("portaudio");
    expect(msg).toContain("apt");
    expect(msg).toContain("dnf");
    expect(msg).toContain("pacman");
  });

  it("names brew install portaudio on darwin", () => {
    expect(getPortAudioInstallInstructions("darwin")).toContain("brew install portaudio");
  });
});

describe("ensurePortAudio", () => {
  it("is a no-op on Windows (sounddevice's win32 wheel bundles PortAudio)", async () => {
    let probeCalls = 0;
    await ensurePortAudio({
      platform: "win32",
      probe: async () => { probeCalls++; return false; },
    });
    expect(probeCalls).toBe(0);
  });

  it("returns silently on Linux when PortAudio is installed", async () => {
    await expect(
      ensurePortAudio({
        platform: "linux",
        probe: async () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws MissingSystemLibraryError on Linux when PortAudio is missing", async () => {
    await expect(
      ensurePortAudio({
        platform: "linux",
        probe: async () => false,
      }),
    ).rejects.toBeInstanceOf(MissingSystemLibraryError);
  });

  it("error message names libportaudio2 on Linux (the apt package, not the soname)", async () => {
    await expect(
      ensurePortAudio({
        platform: "linux",
        probe: async () => false,
      }),
    ).rejects.toThrow(/libportaudio2/);
  });

  it("error message names brew on macOS", async () => {
    await expect(
      ensurePortAudio({
        platform: "darwin",
        probe: async () => false,
      }),
    ).rejects.toThrow(/brew install portaudio/);
  });
});
