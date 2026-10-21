import { describe, expect, it } from "vitest";
import { installFakePlatform } from "../../../__mocks__/fake-platform";
import { disclosureFingerprint, voiceDownloadConsentIn } from "../consent";
import type { ModelEntry, VoiceModelManifest } from "../models/manifest";

function model(id: string, bytes: number, license = "MIT", version = "1.0.0"): ModelEntry {
  return { id, version, description: "", license, license_url: `https://licenses.test/${license}`, huggingface_repo: "", files: [{ filename: "m", url: "", sha256: "", bytes }], gated: false };
}

function manifest(...models: ModelEntry[]): VoiceModelManifest {
  return {
    schemaVersion: 1,
    status: "production",
    models,
    wakeModel: { id: "kws", description: "", license: "Apache-2.0", license_url: "https://licenses.test/apache", source: "", archive: { url: "", sha256: "", bytes: 1 }, files: [] },
  };
}

const SHIPPED = manifest(model("asr", 2_400_000_000, "CC-BY-4.0"), model("tts", 2_000_000_000));

describe("disclosureFingerprint", () => {
  it("asks again for a new model, a changed license or a download past the next gigabyte", () => {
    const base = disclosureFingerprint(SHIPPED);
    expect(disclosureFingerprint(manifest(...SHIPPED.models, model("vad", 2_000_000)))).not.toBe(base);
    expect(disclosureFingerprint(manifest(model("asr", 2_400_000_000, "CC-BY-NC-4.0"), model("tts", 2_000_000_000)))).not.toBe(base);
    expect(disclosureFingerprint(manifest(model("asr", 3_400_000_000, "CC-BY-4.0"), model("tts", 2_000_000_000)))).not.toBe(base);
  });

  it("keeps the consent for a new version of a model under the same license and size, in any order", () => {
    const base = disclosureFingerprint(SHIPPED);
    expect(disclosureFingerprint(manifest(model("tts", 2_000_000_000, "MIT", "1.1.0"), model("asr", 2_400_000_100, "CC-BY-4.0", "2.1.0")))).toBe(base);
  });
});

describe("voiceDownloadConsentIn", () => {
  it("is given once recorded, in host state, and not for a manifest that discloses more", async () => {
    const state = installFakePlatform().state.global;
    const consent = voiceDownloadConsentIn(state, async () => SHIPPED);
    expect(await consent.given()).toBe(false);

    await consent.record();

    expect(await consent.given()).toBe(true);
    expect(await voiceDownloadConsentIn(state, async () => SHIPPED).given()).toBe(true);
    expect(await voiceDownloadConsentIn(state, async () => manifest(...SHIPPED.models, model("vad", 2_000_000, "BSD-3-Clause"))).given()).toBe(false);
  });
});
