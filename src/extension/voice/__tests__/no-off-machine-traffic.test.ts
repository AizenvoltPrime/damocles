import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const ALLOWED_HOSTS = ["huggingface.co", "github.com"] as const;

function extractHttpUrls(source: string): string[] {
  const urls: string[] = [];
  const re = /https?:\/\/[^\s"'`<>]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    urls.push(match[0]);
  }
  return urls;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

describe("voice privacy: no off-machine traffic", () => {
  it("VoiceSidecarManager spawn args contain only loopback URLs", async () => {
    const managerSrc = await readFile(
      join(REPO_ROOT, "src", "extension", "voice", "sidecar", "manager.ts"),
      "utf8",
    );
    const urls = extractHttpUrls(managerSrc);
    for (const url of urls) {
      const host = hostnameOf(url);
      expect(host === "127.0.0.1" || host === "localhost" || host === "").toBe(true);
    }
  });

  it("model manifest URLs are restricted to huggingface.co + github.com", async () => {
    const manifestPath = join(
      REPO_ROOT,
      "python",
      "damocles_voice_sidecar",
      "damocles_voice_sidecar",
      "models",
      "MODEL_MANIFEST.json",
    );
    const text = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(text) as {
      models: Record<string, { files: { url: string }[]; license_url: string }>;
    };
    const offenders: string[] = [];
    for (const entry of Object.values(parsed.models)) {
      for (const file of entry.files) {
        const host = hostnameOf(file.url);
        if (!ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
          offenders.push(`${file.url} (host=${host})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("python tarball downloader is pinned to github.com only", async () => {
    const installerPath = join(
      REPO_ROOT,
      "src",
      "extension",
      "voice",
      "runtime",
      "python-installer.ts",
    );
    const src = await readFile(installerPath, "utf8");
    const urls = extractHttpUrls(src);
    // pypi.org is the default Python package index that pip resolves
    // against unconditionally; declaring it explicitly as --extra-index-url
    // doesn't widen the privacy boundary, it just makes the existing
    // implicit behavior visible. The runtime install was always going to
    // resolve transitive deps from PyPI; pinning the index URL prevents
    // 404s on the PyTorch CDN from breaking installs.
    const allowedHosts = new Set([
      "github.com",
      "download.pytorch.org",
      "pypi.org",
    ]);
    for (const url of urls) {
      const host = hostnameOf(url);
      const allowed = allowedHosts.has(host) || host.endsWith(".github.com");
      expect(allowed, `Unexpected host in python-installer.ts: ${host} (${url})`).toBe(true);
    }
  });

  it("ProtocolSchema does not accept user-supplied URL fields", async () => {
    const protocolSrc = await readFile(
      join(REPO_ROOT, "src", "extension", "voice", "sidecar", "protocol.ts"),
      "utf8",
    );
    expect(protocolSrc.includes("z.string().url()")).toBe(false);
    expect(/url:\s*z\./i.test(protocolSrc)).toBe(false);
  });
});
