import * as fs from "fs";
import * as path from "path";
import { log } from "../logger";

let cachedLibc: "glibc" | "musl" | null = null;

export function resolveBundledClaudeBinary(): string | null {
  const platform = process.platform;
  const arch = process.arch;
  const libc = detectLibc();

  const pkgName = platform === "linux"
    ? `@anthropic-ai/claude-agent-sdk-linux-${arch}${libc === "musl" ? "-musl" : ""}`
    : `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;

  const binaryName = platform === "win32" ? "claude.exe" : "claude";

  try {
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
    const binPath = path.join(path.dirname(pkgJsonPath), binaryName);
    if (fs.existsSync(binPath)) return binPath;
    log("[auth] resolved %s but %s is missing", pkgName, binPath);
    return null;
  } catch (err) {
    log("[auth] failed to resolve bundled SDK sidecar %s: %O", pkgName, err);
    return null;
  }
}

function detectLibc(): "glibc" | "musl" {
  if (cachedLibc) return cachedLibc;
  if (process.platform !== "linux") {
    cachedLibc = "glibc";
    return cachedLibc;
  }
  const report = tryGetProcessReport();
  if (!report) {
    cachedLibc = "glibc";
    return cachedLibc;
  }
  cachedLibc = report.header?.glibcVersionRuntime ? "glibc" : "musl";
  return cachedLibc;
}

function tryGetProcessReport(): { header?: { glibcVersionRuntime?: string } } | null {
  try {
    return (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined) ?? null;
  } catch {
    return null;
  }
}
