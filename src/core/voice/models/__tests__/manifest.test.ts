import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupOldVersions,
  compareInstalled,
  loadManifest,
  parseManifest,
  type VoiceModelManifest,
} from "../manifest";

const VALID_MANIFEST = {
  $schema_version: 1,
  manifest_status: "production",
  models: {
    parakeet: {
      version: "2.0.0",
      description: "Parakeet ASR",
      license: "CC-BY-4.0",
      license_url: "https://creativecommons.org/licenses/by/4.0/",
      huggingface_repo: "nvidia/parakeet-tdt-0.6b-v2",
      files: [
        {
          filename: "model.nemo",
          url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2/resolve/main/parakeet-tdt-0.6b-v2.nemo",
          sha256: "ab".repeat(32),
          bytes: 645000000,
        },
      ],
      gated: false,
    },
  },
  wake_model: {
    id: "kws",
    description: "Keyword spotter",
    license: "Apache-2.0",
    license_url: "https://www.apache.org/licenses/LICENSE-2.0",
    source: "https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models",
    archive: {
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/kws.tar.bz2",
      sha256: "cd".repeat(32),
      bytes: 1000,
    },
    files: [
      { filename: "tokens.txt", archive_path: "kws/tokens.txt", sha256: "ef".repeat(32), bytes: 10 },
      { filename: "encoder.int8.onnx", archive_path: "kws/encoder.int8.onnx", sha256: "01".repeat(32), bytes: 20 },
    ],
  },
};

describe("parseManifest", () => {
  it("parses a valid manifest", () => {
    const manifest = parseManifest(JSON.stringify(VALID_MANIFEST));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.status).toBe("production");
    expect(manifest.models).toHaveLength(1);
    expect(manifest.models[0]?.id).toBe("parakeet");
    expect(manifest.models[0]?.version).toBe("2.0.0");
    expect(manifest.wakeModel.archive.url).toBe(VALID_MANIFEST.wake_model.archive.url);
    expect(manifest.wakeModel.files.map((file) => file.filename)).toEqual(["tokens.txt", "encoder.int8.onnx"]);
  });

  it("parses the shipped manifest", async () => {
    const manifest = await loadManifest(join(__dirname, "..", "..", "..", "..", ".."));
    expect(manifest.wakeModel.license).toBe("Apache-2.0");
    expect(manifest.wakeModel.files.map((file) => file.filename).sort()).toEqual([
      "bpe.model",
      "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      "tokens.txt",
    ]);
  });

  it("rejects a wake file name that is a path, since files land directly in models/wake", () => {
    for (const filename of ["../escape.onnx", "sub/tokens.txt", "C:\\x.onnx", ""]) {
      const broken = JSON.parse(JSON.stringify(VALID_MANIFEST));
      broken.wake_model.files[0].filename = filename;
      expect(() => parseManifest(JSON.stringify(broken)), filename).toThrow();
    }
  });

  it("requires wake_model", () => {
    const broken = JSON.parse(JSON.stringify(VALID_MANIFEST));
    delete broken.wake_model;
    expect(() => parseManifest(JSON.stringify(broken))).toThrow();
  });

  it("defaults status to placeholder-checksums when omitted", () => {
    const noStatus = { ...VALID_MANIFEST };
    delete (noStatus as Record<string, unknown>)["manifest_status"];
    const manifest = parseManifest(JSON.stringify(noStatus));
    expect(manifest.status).toBe("placeholder-checksums");
  });

  it("rejects malformed manifest (missing required field)", () => {
    const broken = JSON.parse(JSON.stringify(VALID_MANIFEST));
    delete broken.models.parakeet.version;
    expect(() => parseManifest(JSON.stringify(broken))).toThrow();
  });

  it("rejects manifest with non-URL license_url", () => {
    const broken = JSON.parse(JSON.stringify(VALID_MANIFEST));
    broken.models.parakeet.license_url = "not-a-url";
    expect(() => parseManifest(JSON.stringify(broken))).toThrow();
  });

  it("rejects manifest with empty files array", () => {
    const broken = JSON.parse(JSON.stringify(VALID_MANIFEST));
    broken.models.parakeet.files = [];
    expect(() => parseManifest(JSON.stringify(broken))).toThrow();
  });
});

describe("compareInstalled", () => {
  let tmp: string;
  let manifest: VoiceModelManifest;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "damocles-models-"));
    manifest = parseManifest(JSON.stringify(VALID_MANIFEST));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("flags missing model when no install dir", async () => {
    const result = await compareInstalled(tmp, manifest);
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.outdated).toHaveLength(0);
  });

  it("flags outdated when only an older version is present", async () => {
    await mkdir(join(tmp, "parakeet", "v1.0.0"), { recursive: true });
    await writeFile(join(tmp, "parakeet", "v1.0.0", "model.nemo"), "old");
    const result = await compareInstalled(tmp, manifest);
    expect(result.outdated).toHaveLength(1);
    expect(result.outdated[0]?.installedVersion).toBe("1.0.0");
    expect(result.missing).toHaveLength(0);
  });

  it("picks the newest installed version when multiple older are present", async () => {
    await mkdir(join(tmp, "parakeet", "v1.0.0"), { recursive: true });
    await writeFile(join(tmp, "parakeet", "v1.0.0", "model.nemo"), "old1");
    await mkdir(join(tmp, "parakeet", "v1.5.0"), { recursive: true });
    await writeFile(join(tmp, "parakeet", "v1.5.0", "model.nemo"), "old2");
    const result = await compareInstalled(tmp, manifest);
    expect(result.outdated).toHaveLength(1);
    expect(result.outdated[0]?.installedVersion).toBe("1.5.0");
  });

  it("reports ok when current version + all files present", async () => {
    await mkdir(join(tmp, "parakeet", "v2.0.0"), { recursive: true });
    await writeFile(join(tmp, "parakeet", "v2.0.0", "model.nemo"), "new");
    const result = await compareInstalled(tmp, manifest);
    expect(result.ok).toBe(true);
  });

  it("flags missing when version dir present but a required file is absent", async () => {
    await mkdir(join(tmp, "parakeet", "v2.0.0"), { recursive: true });
    const result = await compareInstalled(tmp, manifest);
    expect(result.missing).toHaveLength(1);
  });
});

describe("cleanupOldVersions", () => {
  let tmp: string;
  let manifest: VoiceModelManifest;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "damocles-cleanup-"));
    manifest = parseManifest(JSON.stringify(VALID_MANIFEST));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("removes older version directories and reports bytes freed", async () => {
    await mkdir(join(tmp, "parakeet", "v1.0.0"), { recursive: true });
    await writeFile(join(tmp, "parakeet", "v1.0.0", "model.nemo"), "x".repeat(1000));
    await mkdir(join(tmp, "parakeet", "v2.0.0"), { recursive: true });
    await writeFile(join(tmp, "parakeet", "v2.0.0", "model.nemo"), "y");
    const result = await cleanupOldVersions(tmp, manifest);
    expect(result.removed).toContain("parakeet/v1.0.0");
    expect(result.bytesFreed).toBeGreaterThanOrEqual(1000);
  });

  it("does not remove the manifest's current version", async () => {
    await mkdir(join(tmp, "parakeet", "v2.0.0"), { recursive: true });
    await writeFile(join(tmp, "parakeet", "v2.0.0", "model.nemo"), "current");
    const result = await cleanupOldVersions(tmp, manifest);
    expect(result.removed).toHaveLength(0);
  });
});
