import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type ModelFileEntry = {
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
};

export type ModelEntryRaw = {
  version: string;
  description: string;
  license: string;
  license_url: string;
  huggingface_repo: string;
  files: ModelFileEntry[];
  gated: boolean;
};

export type ModelEntry = ModelEntryRaw & { id: string };

export type WakeModelBundled = {
  id: string;
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
  license: string;
};

export type ManifestStatus = "placeholder-checksums" | "production";

export type VoiceModelManifest = {
  schemaVersion: number;
  status: ManifestStatus;
  models: ModelEntry[];
  wakeModelsBundled: WakeModelBundled[];
};

type RawManifest = {
  $schema_version: 1;
  manifest_status?: ManifestStatus | undefined;
  models: Record<string, ModelEntryRaw>;
  wake_models_bundled: WakeModelBundled[];
};

const fileEntrySchema: z.ZodType<ModelFileEntry> = z.object({
  filename: z.string().min(1),
  url: z.string().url(),
  sha256: z.string().min(8),
  bytes: z.number().int().nonnegative(),
});

const modelEntrySchema: z.ZodType<ModelEntryRaw> = z.object({
  version: z.string().min(1),
  description: z.string(),
  license: z.string(),
  license_url: z.string().url(),
  huggingface_repo: z.string().min(1),
  files: z.array(fileEntrySchema).min(1),
  gated: z.boolean(),
});

const wakeModelSchema: z.ZodType<WakeModelBundled> = z.object({
  id: z.string(),
  filename: z.string(),
  url: z.string().url(),
  sha256: z.string().length(64),
  bytes: z.number().int().nonnegative(),
  license: z.string(),
});

const manifestSchema: z.ZodType<RawManifest> = z.object({
  $schema_version: z.literal(1),
  manifest_status: z.enum(["placeholder-checksums", "production"]).optional(),
  models: z.record(z.string(), modelEntrySchema),
  wake_models_bundled: z.array(wakeModelSchema),
});

export const MANIFEST_RELATIVE_PATH: string = join(
  "python",
  "damocles_voice_sidecar",
  "damocles_voice_sidecar",
  "models",
  "MODEL_MANIFEST.json",
);

export async function loadManifest(extensionRoot: string): Promise<VoiceModelManifest> {
  const fullPath = join(extensionRoot, MANIFEST_RELATIVE_PATH);
  const text = await fs.readFile(fullPath, "utf8");
  return parseManifest(text);
}

export function parseManifest(text: string): VoiceModelManifest {
  const raw = JSON.parse(text) as unknown;
  const parsed = manifestSchema.parse(raw);
  const models: ModelEntry[] = Object.entries(parsed.models).map(([id, entry]) => ({ id, ...entry }));
  return {
    schemaVersion: parsed.$schema_version,
    status: parsed.manifest_status ?? "placeholder-checksums",
    models,
    wakeModelsBundled: parsed.wake_models_bundled,
  };
}

export type OutdatedModelEntry = ModelEntry & {
  installedVersion: string;
};

export type CompareResult = {
  ok: boolean;
  missing: ModelEntry[];
  outdated: OutdatedModelEntry[];
};

export type CompareOptions = {
  pinned?: Record<string, string>;
};

export function pickEffectiveEntry(entry: ModelEntry, pinned?: Record<string, string>): ModelEntry {
  const pin = pinned?.[entry.id];
  if (pin === undefined || pin === entry.version) return entry;
  return { ...entry, version: pin };
}

export async function compareInstalled(
  installedDir: string,
  manifest: VoiceModelManifest,
  options: CompareOptions = {},
): Promise<CompareResult> {
  const missing: ModelEntry[] = [];
  const outdated: OutdatedModelEntry[] = [];

  for (const rawEntry of manifest.models) {
    const entry = pickEffectiveEntry(rawEntry, options.pinned);
    const versionDir = join(installedDir, entry.id, `v${entry.version}`);
    let allFilesPresent = true;
    try {
      await fs.access(versionDir);
    } catch {
      const olderInstalled = await findInstalledVersions(join(installedDir, entry.id));
      const newest = pickNewestVersion(olderInstalled);
      if (newest !== null) outdated.push({ ...entry, installedVersion: newest });
      else missing.push(entry);
      continue;
    }
    for (const file of entry.files) {
      try {
        await fs.access(join(versionDir, file.filename));
      } catch {
        allFilesPresent = false;
        break;
      }
    }
    if (!allFilesPresent) missing.push(entry);
  }
  return { ok: missing.length === 0 && outdated.length === 0, missing, outdated };
}

function pickNewestVersion(versions: string[]): string | null {
  if (versions.length === 0) return null;
  const sorted = [...versions].sort(compareSemverLike);
  return sorted[sorted.length - 1] ?? null;
}

function compareSemverLike(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((s) => Number.parseInt(s, 10));
  const pb = b.split(/[.-]/).map((s) => Number.parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = Number.isNaN(pa[i] ?? NaN) ? 0 : pa[i] ?? 0;
    const bi = Number.isNaN(pb[i] ?? NaN) ? 0 : pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return a.localeCompare(b);
}

async function findInstalledVersions(modelDir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(modelDir);
    const result: string[] = [];
    for (const name of names) {
      if (!name.startsWith("v")) continue;
      const stat = await fs.stat(join(modelDir, name));
      if (stat.isDirectory()) result.push(name.slice(1));
    }
    return result;
  } catch {
    return [];
  }
}

export async function cleanupOldVersions(
  installedDir: string,
  manifest: VoiceModelManifest,
): Promise<{ removed: string[]; bytesFreed: number }> {
  const removed: string[] = [];
  let bytesFreed = 0;
  for (const entry of manifest.models) {
    const modelDir = join(installedDir, entry.id);
    let names: string[];
    try {
      names = await fs.readdir(modelDir);
    } catch {
      continue;
    }
    const currentVersionDir = `v${entry.version}`;
    for (const name of names) {
      if (!name.startsWith("v")) continue;
      if (name === currentVersionDir) continue;
      const fullPath = join(modelDir, name);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat === null || !stat.isDirectory()) continue;
      bytesFreed += await dirSize(fullPath);
      await fs.rm(fullPath, { recursive: true, force: true });
      removed.push(`${entry.id}/${name}`);
    }
  }
  return { removed, bytesFreed };
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const full = join(dir, name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat === null) continue;
    if (stat.isDirectory()) total += await dirSize(full);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

export async function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

export function modelVersionDir(installedDir: string, entry: ModelEntry): string {
  return join(installedDir, entry.id, `v${entry.version}`);
}
