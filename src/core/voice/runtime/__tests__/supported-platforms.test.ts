import { beforeEach, describe, expect, it } from "vitest";
import { installFakePlatform } from "../../../../__mocks__/fake-platform";
import tarballChecksums from "../tarball-checksums.json";
import {
  UnsupportedPlatformError,
  VOICE_RUNTIME_PLATFORMS,
  requireVoiceRuntimePlatform,
  unsupportedVoicePlatformMessage,
} from "../supported-platforms";

const REFUSED = [
  ["darwin", "x64", "macOS x64"],
  ["win32", "arm64", "Windows arm64"],
  ["linux", "arm64", "Linux arm64"],
] as const;

describe("voice runtime platform matrix", () => {
  beforeEach(() => {
    installFakePlatform();
  });

  it("supports exactly Windows x64, Linux x64 and macOS arm64", () => {
    expect(VOICE_RUNTIME_PLATFORMS.map(({ platform, arch }) => `${platform}/${arch}`)).toEqual(["win32/x64", "linux/x64", "darwin/arm64"]);
  });

  it.each(VOICE_RUNTIME_PLATFORMS.map((entry) => [entry.platform, entry.arch] as const))("resolves %s %s", (platform, arch) => {
    expect(requireVoiceRuntimePlatform(platform, arch).platform).toBe(platform);
    expect(unsupportedVoicePlatformMessage(platform, arch)).toBeNull();
  });

  it.each(REFUSED)("refuses %s %s, naming it and the supported platforms", (platform, arch, name) => {
    expect(() => requireVoiceRuntimePlatform(platform, arch)).toThrow(UnsupportedPlatformError);
    expect(unsupportedVoicePlatformMessage(platform, arch)).toBe(
      `Jarvis voice mode (wake word and spoken replies) is not available on ${name}. Its local speech runtime supports only Windows x64, Linux x64, macOS arm64. Push-to-talk with cloud speech-to-text (Whisper, Deepgram or Google) still works.`,
    );
  });

  it("has a python-build-standalone checksum for every supported triple and none for any other", () => {
    const triples = VOICE_RUNTIME_PLATFORMS.map((entry) => entry.pbsTriple).sort();
    expect(tarballChecksums.releases.length).toBeGreaterThan(0);
    for (const release of tarballChecksums.releases) {
      expect(Object.keys(release.checksums).sort(), release.release).toEqual(triples);
    }
  });
});
