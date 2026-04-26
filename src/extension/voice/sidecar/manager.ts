import { spawn as spawnProcess, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import WebSocket from "ws";
import type { RawData } from "ws";
import { log } from "../../logger";
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
import type { SpawnOptions, SpawnResult } from "./spawn";

const DEFAULT_LOCK_DIR = join(homedir(), ".damocles", "voice", "sidecar.lock");
const SHUTDOWN_GRACE_MS = 5_000;
const TERM_TIMEOUT_MS = 1_000;
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

function killChildTree(child: ChildProcess, force: boolean): void {
  // child.kill() on Windows maps to TerminateProcess and only kills the
  // wrapper — the python interpreter and any NeMo/torch worker
  // subprocesses survive, leaking VRAM and reattaching to the next
  // restart. taskkill /T walks the process tree from the root pid;
  // /F sends a hard terminate (SIGKILL equivalent), without it the
  // taskkill is the graceful (SIGTERM-equivalent) path.
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const args = ["/T", "/PID", String(pid)];
    if (force) args.unshift("/F");
    try {
      const proc = spawnProcess("taskkill", args, { stdio: "ignore", windowsHide: true });
      proc.on("error", (err) => log("[VoiceSidecar] taskkill spawn error:", err));
    } catch (err) {
      log("[VoiceSidecar] taskkill failed:", err);
    }
    return;
  }
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch (err) {
    log("[VoiceSidecar] child.kill error:", err);
  }
}

export type SidecarManagerStatus =
  | { kind: "stopped" }
  | { kind: "loading"; message: string }
  | { kind: "ready"; device: "cuda" | "cpu"; vramMbFree: number; modelsLoaded: string[]; cpuFallbackActive: boolean }
  | { kind: "restarting"; attempt: number }
  | { kind: "error"; code: ErrorCodeValue | "fatal"; message: string }
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
  wakeWordEnabled: boolean;
  initPayload: {
    wakeWord: string;
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
  private child: ChildProcess | null = null;
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
    this.setStatus({ kind: "loading", message: "Initializing voice mode..." });
    getVoiceOutputChannel();

    const lockDir = this.cfg.lockDir ?? DEFAULT_LOCK_DIR;
    const lock = await acquireSidecarLock(lockDir);
    this.lockHandle = lock;

    if (lock.kind === "attached") {
      await this.connectExisting(lock.existing);
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

  async stop(timeoutMs: number = SHUTDOWN_GRACE_MS): Promise<void> {
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
      let exitedFlag = false;
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => {
          exitedFlag = true;
          resolve();
        });
      });
      const termAfter = setTimeout(() => {
        if (exitedFlag || child.killed) return;
        killChildTree(child, false);
      }, TERM_TIMEOUT_MS);
      const killAfter = setTimeout(() => {
        if (exitedFlag || child.killed) return;
        killChildTree(child, true);
      }, timeoutMs);
      await exited;
      clearTimeout(termAfter);
      clearTimeout(killAfter);
      this.child = null;
    }
    if (this.lockHandle !== null && this.lockHandle.kind === "owned") {
      await this.lockHandle.release();
    }
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
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch (err) {
        log("[VoiceSidecar] killChildSync taskkill failed:", err);
      }
      return;
    }
    try {
      child.kill("SIGKILL");
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
      pid: this.spawnInfo.child.pid ?? -1,
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
      wakeWordEnabled: this.cfg.wakeWordEnabled,
      ttsEnabled: this.cfg.initPayload.ttsEnabled,
    };
    let spawn: SpawnResult;
    try {
      spawn = await spawnSidecar(opts);
    } catch (err) {
      this.setStatus({
        kind: "error",
        code: "fatal",
        message: `failed to spawn sidecar: ${(err as Error).message}`,
      });
      throw err;
    }
    this.spawnInfo = spawn;
    this.child = spawn.child;
    this.attachStdio(spawn.child);
    this.attachExitHandler(spawn.child);

    try {
      await this.waitForReady(spawn.port, spawn.token);
    } catch (err) {
      this.setStatus({
        kind: "error",
        code: "fatal",
        message: `sidecar ready timeout: ${(err as Error).message}`,
      });
      await this.stop();
      throw err;
    }
  }

  private attachStdio(child: ChildProcess): void {
    if (child.stderr !== null) {
      const rl = readline.createInterface({ input: child.stderr });
      rl.on("line", (line) => {
        appendSidecarLine(line, this.cfg.diagnostics);
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_RETAIN_LINES) this.stderrTail.shift();
      });
    }
    if (child.stdout !== null) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => appendSidecarLine(line, this.cfg.diagnostics));
    }
  }

  private attachExitHandler(child: ChildProcess): void {
    child.once("exit", (code, signal) => {
      this.childExitInfo = { code, signal };
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
        this.setStatus({ kind: "error", code: name, message: tail.split("\n").slice(-3).join(" | ") });
        this.emit("error", { code: name, message: tail.split("\n").slice(-3).join(" | "), stderrTail: tail });
        return;
      }
    }
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((ts) => now - ts < RESTART_WINDOW_MS);
    if (this.restartTimestamps.length >= RESTART_MAX_ATTEMPTS) {
      this.setStatus({ kind: "error", code: ErrorCode.CrashLoop, message: "sidecar crashed too often; giving up" });
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
      const message = "CPU-mode sidecar also OOM'd; voice runtime cannot recover.";
      this.setStatus({ kind: "error", code: ErrorCode.CudaOom, message });
      this.emit("error", { code: ErrorCode.CudaOom, message, stderrTail: this.stderrTail.join("\n") });
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
        if (handle !== null && handle.kind === "owned") {
          await handle.release();
        }
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
            wake_word: this.cfg.initPayload.wakeWord,
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
    this.setStatus({ kind: "loading", message: "Attaching to existing voice sidecar..." });
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
