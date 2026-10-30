// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- killChildSync: VS Code's deactivate does not await, so its kill cannot go through the launcher
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import WebSocket from "ws";
import type { RawData } from "ws";
import { log } from "../../logger";
import { processLauncher, withSpawnLock, type LaunchedProcess, type OutputStream, type ProcessExit } from "../../process-launcher";
import { windowsSystemTool } from "../../system-tools";
import { HealthMonitor } from "./health";
import { acquireSidecarLock } from "./lockfile";
import type { AcquireResult, LockContents } from "./lockfile";
import { appendSidecarLine, getVoiceOutputChannel } from "./output-channel";
import {
  encodeInbound,
  ErrorCode,
  parseOutbound,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
} from "./protocol";
import type {
  ErrorCodeValue,
  SidecarInbound,
  SidecarOutbound,
  TtsAudioChunkHeader,
} from "./protocol";
import { spawnSidecar } from "./spawn";
import { errorTextOf, l, verbatim } from "../../l10n";
import type { LocalizedText } from "../../../shared/localized-text";
import type { SpawnOptions, SpawnResult } from "./spawn";

const DEFAULT_LOCK_DIR = join(homedir(), ".damocles", "voice", "sidecar.lock");
const SHUTDOWN_GRACE_MS = 5_000;
const TERM_TIMEOUT_MS = 1_000;
/** How long after the force kill `stop()` still waits for an exit before it stops waiting. */
const KILL_SETTLE_MS = 2_000;
const ATTACHED_CLIENT_GRACE_MS = 30_000;
const COLD_START_TIMEOUT_MS = 60_000;
const PORT_PROBE_INTERVAL_MS = 250;
const PORT_PROBE_CONNECT_TIMEOUT_MS = 1_000;
const STDERR_RETAIN_LINES = 64;
const RESTART_WINDOW_MS = 60_000;
const RESTART_MAX_ATTEMPTS = 2;
const OOM_RESTART_EXIT_CODE = 7;

// Anchored to actual fatal phrasings emitted by torch / CUDA. The
// previous /driver/i term matched any benign stderr line containing the
// substring "driver" (model loading, NeMo logging, third-party trace
// noise) and incorrectly suppressed the entire restart ladder.
const FATAL_STDERR_PATTERNS: { name: ErrorCodeValue; re: RegExp }[] = [
  {
    name: ErrorCode.CudaUnavailable,
    re: /CUDA error|no kernel image is available|CUDA driver version is insufficient|no CUDA-capable device/i,
  },
  { name: ErrorCode.ModelLoadFailed, re: /ImportError|ModuleNotFoundError/ },
];

/**
 * Ask the sidecar to stop, or on the force path kill it and everything it started.
 *
 * On Windows the force path terminates the job object the launcher started the sidecar in: a root-only kill is
 * TerminateProcess of the wrapper, and the python interpreter and any NeMo or torch workers would survive, holding their
 * VRAM and reattaching to the next restart. The graceful path there is `taskkill /T` without `/F`, which must not fall back,
 * since every other kill on Windows is the force path. On POSIX the graceful path signals the sidecar itself, and the
 * force path its process group.
 */
function killChildTree(child: LaunchedProcess, pid: number, force: boolean): void {
  if (force) {
    child.kill({ tree: true, signal: "SIGKILL" });
    return;
  }
  if (process.platform !== "win32") {
    child.kill({ signal: "SIGTERM" });
    return;
  }
  const sweep = processLauncher().launch({ file: windowsSystemTool("taskkill"), args: ["/T", "/PID", String(pid)], stdio: ["ignore", "ignore", "ignore"] });
  sweep.exited.then(
    ({ code }) => {
      if (code !== 0) log("[VoiceSidecar] taskkill exited with code %s for pid %d", code, pid);
    },
    (err: unknown) => log("[VoiceSidecar] taskkill could not start:", err),
  );
}

/** Calls onLine with each line of one output stream of child, the last one included. */
function readLines(child: LaunchedProcess, stream: OutputStream, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  child.onData(stream, (chunk) => {
    const lines = (pending + decoder.write(chunk)).split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
  const flush = (): void => {
    const last = pending + decoder.end();
    if (last) onLine(last);
  };
  child.closed.then(flush, flush);
}

export type SidecarManagerStatus =
  | { kind: "stopped" }
  | { kind: "loading"; message: LocalizedText }
  | { kind: "ready"; device: "cuda" | "cpu"; vramMbFree: number; modelsLoaded: string[]; cpuFallbackActive: boolean }
  | { kind: "restarting"; attempt: number }
  | { kind: "error"; code: ErrorCodeValue | "fatal" | "unsupported-platform"; message: LocalizedText }
  | { kind: "cpu-fallback"; reason: CpuFallbackReason };

export type CpuFallbackReason = "no-cuda" | "low-vram" | "user-pref" | "cuda-oom-fallback";
export type CpuFallbackEvent = { reason: CpuFallbackReason };
export type TtsUnloadedEvent = { reason: "low-vram" };

export type ManagerConfig = {
  pythonExe: string;
  pythonSourceDir: string;
  modelsDir: string;
  runtimeMode: "cuda" | "cpu" | "auto";
  diagnostics: boolean;
  /** The normalized wake phrase; null when wake detection is off. */
  wakePhrase: string | null;
  initPayload: {
    wakeSensitivity: number;
    endOfTurnSilenceMs: number;
    maxUtteranceMs: number;
    ttsEnabled: boolean;
    ttsVoice: string;
  };
  lockDir?: string;
};

export type IncomingTtsChunk = {
  request_id: string;
  sample_rate: number;
  pcm: Buffer;
};

type ManagerEvents = {
  status: [SidecarManagerStatus];
  message: [SidecarOutbound];
  ttsChunk: [IncomingTtsChunk];
  error: [{ code: ErrorCodeValue | "fatal"; message: string; stderrTail: string }];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
  cpuFallback: [CpuFallbackEvent];
  ttsUnloaded: [TtsUnloadedEvent];
};

export class VoiceSidecarManager extends EventEmitter<ManagerEvents> {
  private cfg: ManagerConfig;
  private child: LaunchedProcess | null = null;
  private childPid = -1;
  private ws: WebSocket | null = null;
  private spawnInfo: SpawnResult | null = null;
  private lockHandle: AcquireResult | null = null;
  private status: SidecarManagerStatus = { kind: "stopped" };
  private health: HealthMonitor | null = null;
  private stderrTail: string[] = [];
  private restartTimestamps: number[] = [];
  private attachedClientCount = 0;
  private gracefulStopTimer: NodeJS.Timeout | null = null;
  private pendingTtsHeader: TtsAudioChunkHeader | null = null;
  private stopping = false;
  private cpuFallbackActive = false;
  private ttsUnloadedEmittedThisSession = false;
  private hasReachedReady = false;
  private childExitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(cfg: ManagerConfig) {
    super();
    this.cfg = cfg;
  }

  isCpuFallbackActive(): boolean {
    return this.cpuFallbackActive;
  }

  getStatus(): SidecarManagerStatus {
    return this.status;
  }

  isAlive(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.status.kind === "ready";
  }

  async start(): Promise<void> {
    if (this.status.kind === "ready" || this.status.kind === "loading") return;
    this.stopping = false;
    this.setStatus({ kind: "loading", message: l("Initializing voice mode...") });
    getVoiceOutputChannel();

    const lockDir = this.cfg.lockDir ?? DEFAULT_LOCK_DIR;
    const lock = await acquireSidecarLock(lockDir);
    this.lockHandle = lock;

    if (lock.kind === "attached") {
      try {
        await this.connectExisting(lock.existing);
      } catch (err) {
        lock.detach();
        this.lockHandle = null;
        throw err;
      }
      return;
    }

    try {
      await this.startOwned();
      await lock.commit(this.makeLockContents());
    } catch (err) {
      await lock.release();
      this.lockHandle = null;
      throw err;
    }
  }

  /** Two concurrent stops would both reach `lockHandle.release()`, the second on a freed handle. */
  async stop(timeoutMs: number = SHUTDOWN_GRACE_MS): Promise<void> {
    this.stopPromise ??= this.runStop(timeoutMs).finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async runStop(timeoutMs: number): Promise<void> {
    this.stopping = true;
    this.cancelGracefulStop();
    if (this.health !== null) {
      this.health.stop();
      this.health = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.send(JSON.stringify({ type: "shutdown" }));
      } catch {
        /* swallowed */
      }
      try {
        this.ws.close();
      } catch {
        /* swallowed */
      }
      this.ws = null;
    }
    if (this.child !== null) {
      const child = this.child;
      const pid = this.childPid;
      let exitedFlag = false;
      const settle = (): void => {
        exitedFlag = true;
      };
      const exited = child.exited.then(settle, settle);
      const termAfter = setTimeout(() => {
        if (!exitedFlag) killChildTree(child, pid, false);
      }, TERM_TIMEOUT_MS);
      const killAfter = setTimeout(() => {
        if (!exitedFlag) killChildTree(child, pid, true);
      }, timeoutMs);
      // A kill the OS refuses leaves nothing to wait for, and an unbounded wait here holds the lock
      // handle and never lets dispose finish.
      let settleAfter: NodeJS.Timeout | undefined;
      const abandoned = new Promise<void>((resolve) => {
        settleAfter = setTimeout(() => {
          log("[VoiceSidecar] pid %s survived the force kill; giving up the wait after %dms", pid, KILL_SETTLE_MS);
          resolve();
        }, timeoutMs + KILL_SETTLE_MS);
      });
      await Promise.race([exited, abandoned]);
      clearTimeout(termAfter);
      clearTimeout(killAfter);
      clearTimeout(settleAfter);
      this.child = null;
    }
    if (this.lockHandle?.kind === "owned") await this.lockHandle.release();
    else this.lockHandle?.detach();
    this.lockHandle = null;
    this.spawnInfo = null;
    this.setStatus({ kind: "stopped" });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Synchronously force-kill the child process tree. Use from disposal
   * paths where the extension host is about to unload and there's no
   * time to await the graceful stop() — without this, the async stop
   * is fire-and-forget and the Python sidecar (plus NeMo workers and
   * VRAM allocations) survives as an orphan past extension reload.
   */
  killChildSync(): void {
    const child = this.child;
    if (child === null) return;
    const pid = this.childPid;
    // The launcher worker terminates the sidecar's job while this thread runs the synchronous kill, if the process lives on.
    child.kill({ tree: true, signal: "SIGKILL" });
    if (process.platform === "win32") {
      try {
        // spawnSync reports a missing taskkill through `error` and a failed one through `status`, so
        // a catch alone sees neither.
        // eslint-disable-next-line damocles/no-sync -- VS Code's deactivate does not await, so an async kill never runs
        const result = withSpawnLock(() => spawnSync(windowsSystemTool("taskkill"), ["/F", "/T", "/PID", String(pid)], {
          stdio: ["ignore", "ignore", "pipe"],
          encoding: "utf8",
          windowsHide: true,
        }));
        if (result.error === undefined && result.status === 0) return;
        log(
          "[VoiceSidecar] killChildSync taskkill failed for pid %d: error=%O status=%s stderr=%s",
          pid,
          result.error,
          result.status,
          (result.stderr ?? "").trim(),
        );
      } catch (err) {
        log("[VoiceSidecar] killChildSync taskkill failed:", err);
      }
    }
    try {
      // On POSIX the sidecar leads its own process group (spawn.ts), so the negative pid reaches its workers too.
      process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch (err) {
      log("[VoiceSidecar] killChildSync SIGKILL failed:", err);
    }
  }

  send(msg: SidecarInbound): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeInbound(msg));
  }

  attachClient(): () => void {
    this.attachedClientCount += 1;
    this.cancelGracefulStop();
    return () => this.detachClient();
  }

  private detachClient(): void {
    this.attachedClientCount = Math.max(0, this.attachedClientCount - 1);
    if (this.attachedClientCount === 0 && this.lockHandle?.kind === "owned") {
      this.gracefulStopTimer = setTimeout(() => {
        this.stop().catch((err) => log("[VoiceSidecar] graceful stop failed:", err));
      }, ATTACHED_CLIENT_GRACE_MS);
    }
  }

  private cancelGracefulStop(): void {
    if (this.gracefulStopTimer !== null) {
      clearTimeout(this.gracefulStopTimer);
      this.gracefulStopTimer = null;
    }
  }

  private setStatus(next: SidecarManagerStatus): void {
    this.status = next;
    this.emit("status", next);
  }

  private makeLockContents(): LockContents {
    if (this.spawnInfo === null) {
      throw new Error("makeLockContents called before spawn");
    }
    return {
      pid: this.spawnInfo.pid,
      port: this.spawnInfo.port,
      token: this.spawnInfo.token,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: Date.now(),
    };
  }

  private async startOwned(): Promise<void> {
    this.hasReachedReady = false;
    this.childExitInfo = null;
    const opts: SpawnOptions = {
      pythonExe: this.cfg.pythonExe,
      pythonSourceDir: this.cfg.pythonSourceDir,
      modelsDir: this.cfg.modelsDir,
      runtimeMode: this.cfg.runtimeMode,
      diagnostics: this.cfg.diagnostics,
      wakePhrase: this.cfg.wakePhrase,
      ttsEnabled: this.cfg.initPayload.ttsEnabled,
    };
    let spawn: SpawnResult;
    try {
      spawn = await spawnSidecar(opts);
    } catch (err) {
      this.setStatus({
        kind: "error",
        code: "fatal",
        message: l("The voice helper process could not start: {0}", errorTextOf(err)),
      });
      throw err;
    }
    this.spawnInfo = spawn;
    this.child = spawn.child;
    this.childPid = spawn.pid;
    this.attachStdio(spawn.child);
    this.attachExitHandler(spawn.child);

    try {
      await this.waitForReady(spawn.port, spawn.token);
    } catch (err) {
      this.setStatus({
        kind: "error",
        code: "fatal",
        message: l("The voice helper process did not become ready: {0}", errorTextOf(err)),
      });
      await this.stop();
      throw err;
    }
  }

  private attachStdio(child: LaunchedProcess): void {
    readLines(child, "stderr", (line) => {
      appendSidecarLine(line, this.cfg.diagnostics);
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_RETAIN_LINES) this.stderrTail.shift();
    });
    readLines(child, "stdout", (line) => appendSidecarLine(line, this.cfg.diagnostics));
  }

  private attachExitHandler(child: LaunchedProcess): void {
    // A launcher worker that died took no exit code with it; the pool kills what it left running.
    const exited = child.exited.catch((err: unknown): ProcessExit => {
      log("[VoiceSidecar] the sidecar process failed:", err);
      return { code: null, signal: null };
    });
    void exited.then(({ code, signal }) => {
      this.childExitInfo = { code, signal };
      // A dead child must not be waited on again: stop() would wait for an exit that already happened.
      if (this.child === child) this.child = null;
      this.emit("exit", { code, signal });
      if (this.stopping) return;
      if (this.health !== null) {
        this.health.stop();
        this.health = null;
      }
      if (this.ws !== null) {
        try {
          this.ws.close();
        } catch {
          /* swallowed */
        }
        this.ws = null;
      }
      if (!this.hasReachedReady && code !== OOM_RESTART_EXIT_CODE) {
        return;
      }
      this.handleUnexpectedExit(code);
    });
  }

  private handleUnexpectedExit(exitCode: number | null): void {
    if (exitCode === OOM_RESTART_EXIT_CODE) {
      this.handleCudaOomFallback();
      return;
    }
    const tail = this.stderrTail.join("\n");
    for (const { name, re } of FATAL_STDERR_PATTERNS) {
      if (re.test(tail)) {
        this.setStatus({ kind: "error", code: name, message: verbatim(tail.split("\n").slice(-3).join(" | ")) });
        this.emit("error", { code: name, message: tail.split("\n").slice(-3).join(" | "), stderrTail: tail });
        return;
      }
    }
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((ts) => now - ts < RESTART_WINDOW_MS);
    if (this.restartTimestamps.length >= RESTART_MAX_ATTEMPTS) {
      this.setStatus({ kind: "error", code: ErrorCode.CrashLoop, message: l("The voice helper process stopped unexpectedly too many times, so Damocles no longer restarts it.") });
      this.emit("error", {
        code: ErrorCode.CrashLoop,
        message: "sidecar crashed too often; giving up",
        stderrTail: tail,
      });
      return;
    }
    this.restartTimestamps.push(now);
    this.setStatus({ kind: "restarting", attempt: this.restartTimestamps.length });
    this.start().catch((err) => log("[VoiceSidecar] restart failed:", err));
  }

  private handleCudaOomFallback(): void {
    // Recursion guard: if a CPU-mode sidecar also exits with code 7,
    // the runtime can't recover by switching mode (we're already in
    // cpu). Escalate to fatal instead of relooping into another
    // start() that lands back here.
    if (this.cpuFallbackActive) {
      this.setStatus({ kind: "error", code: ErrorCode.CudaOom, message: l("The voice helper process ran out of memory on the GPU and then on the CPU too, so voice cannot run.") });
      this.emit("error", { code: ErrorCode.CudaOom, message: "CPU-mode sidecar also OOM'd; voice runtime cannot recover.", stderrTail: this.stderrTail.join("\n") });
      return;
    }
    this.cpuFallbackActive = true;
    this.ttsUnloadedEmittedThisSession = false;
    this.cfg = { ...this.cfg, runtimeMode: "cpu" };
    this.setStatus({ kind: "cpu-fallback", reason: "cuda-oom-fallback" });
    this.emit("cpuFallback", { reason: "cuda-oom-fallback" });
    const handle = this.lockHandle;
    this.lockHandle = null;
    this.spawnInfo = null;
    this.child = null;
    void (async () => {
      try {
        if (handle?.kind === "owned") await handle.release();
        else handle?.detach();
        await this.start();
      } catch (err) {
        log("[VoiceSidecar] cpu-fallback restart failed:", err);
      }
    })();
  }

  private async waitForReady(port: number, token: string): Promise<void> {
    const deadline = Date.now() + COLD_START_TIMEOUT_MS;
    try {
      await this.waitForPortListening(port, deadline);
      await this.completeReadyHandshake(port, token, deadline);
      this.hasReachedReady = true;
    } catch (err) {
      throw this.decorateStartupError(err);
    }
  }

  private async waitForPortListening(port: number, deadline: number): Promise<void> {
    while (true) {
      if (this.childExitInfo !== null) {
        throw new Error(
          `sidecar exited before binding port (code=${this.childExitInfo.code}, signal=${this.childExitInfo.signal ?? "none"})`,
        );
      }
      if (await canConnect(port)) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `sidecar did not start listening on 127.0.0.1:${port} within ${COLD_START_TIMEOUT_MS}ms`,
        );
      }
      await sleep(PORT_PROBE_INTERVAL_MS);
    }
  }

  private async completeReadyHandshake(port: number, token: string, deadline: number): Promise<void> {
    return this.awaitReadyHandshake(port, token, deadline, { sendInit: true });
  }

  private async awaitReadyHandshake(
    port: number,
    token: string,
    deadline: number,
    opts: { sendInit: boolean },
  ): Promise<void> {
    const url = `ws://127.0.0.1:${port}`;
    const ws = new WebSocket(url, [SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${token}` },
    });
    this.ws = ws;
    let settled = false;
    let onReady: ((msg: SidecarOutbound) => void) | null = null;
    return new Promise<void>((resolve, reject) => {
      const finish = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (onReady !== null) this.off("message", onReady);
        if (err === null) {
          resolve();
        } else {
          try {
            ws.close();
          } catch {
            /* swallowed */
          }
          if (this.ws === ws) this.ws = null;
          reject(err);
        }
      };

      const remaining = Math.max(0, deadline - Date.now());
      const timeout = setTimeout(() => {
        finish(new Error(`sidecar did not send 'ready' message within ${COLD_START_TIMEOUT_MS}ms`));
      }, remaining);

      ws.once("open", () => {
        this.installSocketHandlers(ws);
        if (opts.sendInit) {
          this.send({
            type: "init",
            protocol_version: PROTOCOL_VERSION,
            wake_sensitivity: this.cfg.initPayload.wakeSensitivity,
            end_of_turn_silence_ms: this.cfg.initPayload.endOfTurnSilenceMs,
            max_utterance_ms: this.cfg.initPayload.maxUtteranceMs,
            tts_enabled: this.cfg.initPayload.ttsEnabled,
            tts_voice: this.cfg.initPayload.ttsVoice,
            diagnostics: this.cfg.diagnostics,
          });
        }
      });
      ws.once("error", (err: Error) => finish(err));

      onReady = (msg: SidecarOutbound): void => {
        if (msg.type !== "ready") return;
        if (msg.protocol_version !== PROTOCOL_VERSION) {
          finish(new Error(`protocol version mismatch (got ${msg.protocol_version}, expected ${PROTOCOL_VERSION})`));
          return;
        }
        if (msg.auto_fallback_reason !== undefined && !this.cpuFallbackActive) {
          this.cpuFallbackActive = true;
          this.emit("cpuFallback", { reason: msg.auto_fallback_reason });
        }
        // Reset the per-session ttsUnloaded dedup on every fresh ready
        // so a second OOM-recovered event in the same logical session
        // (after restart, attach, or hot-swap) actually notifies the
        // webview instead of being silently swallowed by the dedup.
        this.ttsUnloadedEmittedThisSession = false;
        this.setStatus({
          kind: "ready",
          device: msg.device,
          vramMbFree: msg.vram_mb_free,
          modelsLoaded: msg.models_loaded,
          cpuFallbackActive: this.cpuFallbackActive,
        });
        this.startHealthMonitor();
        finish(null);
      };
      this.on("message", onReady);
    });
  }

  private decorateStartupError(err: unknown): Error {
    const base = err instanceof Error ? err.message : String(err);
    const tail = this.stderrTail.slice(-25).join("\n");
    if (tail.length === 0) return new Error(base);
    return new Error(`${base}\n--- sidecar stderr ---\n${tail}`);
  }

  private async connectExisting(existing: LockContents): Promise<void> {
    // The existing sidecar already booted and emits a fresh "ready" to
    // every new client connection (server.py:_serve_connection sends
    // ready on each handler entry). awaitReadyHandshake hangs on that
    // ready and transitions to kind=ready — without this, the second
    // window's isAlive() stays false forever and any send() from this
    // manager silently drops.
    this.setStatus({ kind: "loading", message: l("Attaching to existing voice sidecar...") });
    const deadline = Date.now() + COLD_START_TIMEOUT_MS;
    await this.awaitReadyHandshake(existing.port, existing.token, deadline, { sendInit: false });
  }

  private installSocketHandlers(ws: WebSocket): void {
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary && this.pendingTtsHeader !== null) {
        const header = this.pendingTtsHeader;
        this.pendingTtsHeader = null;
        const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        log(`[VoiceSidecar] tts binary frame: req=${header.request_id} bytes=${pcm.byteLength} sr=${header.sample_rate}`);
        this.emit("ttsChunk", {
          request_id: header.request_id,
          sample_rate: header.sample_rate,
          pcm,
        });
        return;
      }
      const msg = parseOutbound(data.toString());
      if (msg === null) return;
      if (msg.type === "tts_audio_chunk") {
        log(`[VoiceSidecar] tts header: req=${msg.request_id} sr=${msg.sample_rate}`);
        this.pendingTtsHeader = msg;
      }
      if (msg.type === "tts_done") {
        log(`[VoiceSidecar] tts_done: req=${msg.request_id}`);
      }
      if (msg.type === "error") {
        log(`[VoiceSidecar] sidecar error: code=${msg.code} message=${msg.message}`);
      }
      if (msg.type === "pong" && this.health !== null) {
        this.health.recordPong(msg.nonce);
      }
      if (msg.type === "error" && msg.code === ErrorCode.CudaOomRecovered && !this.ttsUnloadedEmittedThisSession) {
        this.ttsUnloadedEmittedThisSession = true;
        this.emit("ttsUnloaded", { reason: "low-vram" });
      }
      this.emit("message", msg);
    });
    ws.on("close", () => {
      if (this.health !== null) {
        this.health.stop();
        this.health = null;
      }
    });
    ws.on("error", (err: Error) => {
      log("[VoiceSidecar] websocket error post-handshake: %s", err.message);
      if (this.health !== null) {
        this.health.stop();
        this.health = null;
      }
      try {
        ws.close();
      } catch {
        /* swallowed */
      }
      if (this.ws === ws) this.ws = null;
    });
  }

  private startHealthMonitor(): void {
    this.health = new HealthMonitor({
      sendPing: (nonce) => this.send({ type: "ping", nonce }),
      onEvent: (event) => {
        if (event === "unhealthy") {
          this.restart().catch((err) => log("[VoiceSidecar] restart on unhealthy failed:", err));
        }
      },
    });
    this.health.start();
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(false);
    }, PORT_PROBE_CONNECT_TIMEOUT_MS);
    sock.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
