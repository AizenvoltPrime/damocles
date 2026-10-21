import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../../__mocks__/fake-platform";
import { loadManifest, MANIFEST_RELATIVE_PATH } from "../manifest";
import { modelIdsLoadedBy, voiceModelsAt } from "../provision";

const ASR = "parakeet_tdt_0_6b_v2";
const VAD = "silero_vad";
const TTS = "vibevoice_realtime_0_5b";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function entry(version: string, files: Record<string, string>) {
  return {
    version,
    description: "",
    license: "MIT",
    license_url: "https://opensource.org/licenses/MIT",
    huggingface_repo: "x/y",
    files: Object.entries(files).map(([filename, body]) => ({ filename, url: `https://example.test/${filename}`, sha256: sha256(body), bytes: body.length })),
    gated: false,
  };
}

const WAKE_MODEL = {
  id: "kws",
  description: "",
  license: "Apache-2.0",
  license_url: "https://www.apache.org/licenses/LICENSE-2.0",
  source: "https://example.test/kws",
  archive: { url: "https://example.test/kws.tar.bz2", sha256: "a".repeat(64), bytes: 1 },
  files: [{ filename: "tokens.txt", archive_path: "kws/tokens.txt", sha256: "b".repeat(64), bytes: 1 }],
};

describe("voiceModelsAt", () => {
  let tmp: string;
  let unpacked: string;
  let modelsDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "damocles-provision-"));
    unpacked = join(tmp, "app");
    modelsDir = join(tmp, "models");
    await mkdir(join(unpacked, MANIFEST_RELATIVE_PATH, ".."), { recursive: true });
    await writeManifest({
      [ASR]: entry("2.0.0", { "asr.nemo": "asr" }),
      [VAD]: entry("5.1", { "vad.onnx": "vad" }),
      [TTS]: entry("1.0.0", { "model.safetensors": "weights-", "config.json": "config" }),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeManifest(models: Record<string, ReturnType<typeof entry>>): Promise<void> {
    await writeFile(join(unpacked, MANIFEST_RELATIVE_PATH), JSON.stringify({ $schema_version: 1, manifest_status: "production", models, wake_model: WAKE_MODEL }));
  }

  async function install(id: string, version: string, ...files: string[]): Promise<void> {
    await mkdir(join(modelsDir, id, `v${version}`), { recursive: true });
    for (const file of files) await writeFile(join(modelsDir, id, `v${version}`, file), "x");
  }

  function modelsFor(settings: Record<string, unknown>) {
    return voiceModelsAt(unpacked, modelsDir, installFakePlatform({ settings: { user: settings } }).settings);
  }

  const ids = async (models: ReturnType<typeof modelsFor>): Promise<string[]> => (await models.missing()).map((m) => m.id).sort();

  it("needs the wake, VAD and ASR models in wake-word mode, and only VibeVoice for spoken replies, as the sidecar loads them", async () => {
    expect(await ids(modelsFor({ "damocles.voice.mode": "wake-word", "damocles.voice.tts.enabled": false }))).toEqual([ASR, VAD]);
    expect(await ids(modelsFor({ "damocles.voice.mode": "push-to-talk", "damocles.voice.tts.enabled": true }))).toEqual([TTS]);
    expect(await ids(modelsFor({ "damocles.voice.mode": "wake-word", "damocles.voice.tts.enabled": true }))).toEqual([ASR, VAD, TTS]);
    expect(await ids(modelsFor({ "damocles.voice.mode": "off", "damocles.voice.tts.enabled": false }))).toEqual([]);
  });

  it("counts a model whose manifest version is not on disk as missing, an older version on disk included", async () => {
    await install(ASR, "1.0.0", "asr.nemo");
    await install(VAD, "5.1", "vad.onnx");

    const missing = await modelsFor({ "damocles.voice.mode": "wake-word" }).missing();

    expect(missing.map((m) => [m.id, m.version])).toEqual([[ASR, "2.0.0"]]);
  });

  it("counts a model with a file absent from its version folder as missing", async () => {
    await install(TTS, "1.0.0", "model.safetensors");

    expect(await ids(modelsFor({ "damocles.voice.tts.enabled": true }))).toEqual([TTS]);
  });

  it("downloads every file of a model into its manifest version folder, reporting the bytes across its files", async () => {
    const bodies: Record<string, string> = { "model.safetensors": "weights-", "config.json": "config" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const name = String(input).split("/").pop()!;
      return new Response(bodies[name], { status: 200, headers: { "content-length": String(bodies[name]!.length) } });
    });
    const models = modelsFor({ "damocles.voice.tts.enabled": true });
    const [tts] = await models.missing();
    const reported: number[] = [];

    await models.download(tts!, undefined, (bytes) => reported.push(bytes));

    expect(reported.at(-1)).toBe("weights-".length + "config".length);
    expect(reported).toEqual([...reported].sort((a, b) => a - b));
    expect(await readFile(join(modelsDir, TTS, "v1.0.0", "config.json"), "utf8")).toBe("config");
    expect(await models.missing()).toEqual([]);
  });
});

describe("modelIdsLoadedBy", () => {
  it("covers every model the shipped manifest lists, so none is listed that no mode downloads", async () => {
    const manifest = await loadManifest(join(__dirname, "..", "..", "..", "..", ".."));
    const loaded = new Set([...modelIdsLoadedBy({ wakeWord: true, tts: false }), ...modelIdsLoadedBy({ wakeWord: false, tts: true })]);
    expect(manifest.models.map((m) => m.id).filter((id) => !loaded.has(id))).toEqual([]);
  });
});
