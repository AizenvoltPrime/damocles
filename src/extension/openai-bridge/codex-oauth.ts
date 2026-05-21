import * as vscode from "vscode";
import * as http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OPENAI_BRIDGE_SECRET_KEYS } from "./types";
import { log } from "../logger";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_PORT = 1455;
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface CodexTokenBlob {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  chatgpt_account_id: string | null;
}

export interface CodexAuthResult {
  ok: boolean;
  accountId?: string;
  error?: string;
}

let refreshInFlight: Promise<CodexTokenBlob | null> | null = null;
let activeFlow: { cancel: () => void } | null = null;

function base64UrlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function suffix(value: string | null | undefined): string {
  if (!value) return "<none>";
  return value.length <= 4 ? "****" : `…${value.slice(-4)}`;
}

export interface CodexJwtClaims {
  email?: string;
  name?: string;
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
}

export function extractCodexJwtClaims(accessToken: string): CodexJwtClaims | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  const rawPayload = parts[1];
  if (!rawPayload) return null;
  try {
    const payloadB64 = rawPayload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
    const claims: CodexJwtClaims = {};
    if (typeof payload["email"] === "string") claims.email = payload["email"] as string;
    if (typeof payload["name"] === "string") claims.name = payload["name"] as string;
    const authNs = payload["https://api.openai.com/auth"];
    if (authNs && typeof authNs === "object") {
      const ns = authNs as Record<string, unknown>;
      if (typeof ns["chatgpt_account_id"] === "string") claims.chatgpt_account_id = ns["chatgpt_account_id"] as string;
      if (typeof ns["chatgpt_plan_type"] === "string") claims.chatgpt_plan_type = ns["chatgpt_plan_type"] as string;
    }
    return claims;
  } catch {
    return null;
  }
}

function extractChatGPTAccountId(accessToken: string): string | null {
  return extractCodexJwtClaims(accessToken)?.chatgpt_account_id ?? null;
}

async function readBlob(context: vscode.ExtensionContext): Promise<CodexTokenBlob | null> {
  try {
    const raw = await context.secrets.get(OPENAI_BRIDGE_SECRET_KEYS.codexAccessToken);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CodexTokenBlob>;
    if (
      typeof parsed?.access_token !== "string" ||
      typeof parsed?.refresh_token !== "string" ||
      typeof parsed?.expires_at !== "number"
    ) {
      return null;
    }
    return {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      expires_at: parsed.expires_at,
      chatgpt_account_id: typeof parsed.chatgpt_account_id === "string" ? parsed.chatgpt_account_id : null,
    };
  } catch (err) {
    log("[CodexOAuth] Failed to read blob:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function writeBlob(context: vscode.ExtensionContext, blob: CodexTokenBlob): Promise<void> {
  await context.secrets.store(OPENAI_BRIDGE_SECRET_KEYS.codexAccessToken, JSON.stringify(blob));
}

async function deleteBlob(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(OPENAI_BRIDGE_SECRET_KEYS.codexAccessToken);
}

async function postTokenRequest(body: URLSearchParams): Promise<Response> {
  if (!TOKEN_URL.startsWith("https://")) {
    throw new Error("Refusing non-HTTPS token endpoint");
  }
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

function buildBlobFromResponse(json: TokenResponse): CodexTokenBlob | null {
  if (
    typeof json?.access_token !== "string" ||
    typeof json?.refresh_token !== "string" ||
    typeof json?.expires_in !== "number"
  ) {
    return null;
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
    chatgpt_account_id: extractChatGPTAccountId(json.access_token),
  };
}

async function exchangeCodeForTokens(code: string, verifier: string): Promise<CodexTokenBlob | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });

  const response = await postTokenRequest(body);
  if (!response.ok) {
    log(`[CodexOAuth] Token exchange failed: status=${response.status}`);
    return null;
  }
  const json = (await response.json().catch(() => null)) as TokenResponse | null;
  if (!json) {
    log("[CodexOAuth] Token exchange returned invalid JSON");
    return null;
  }
  return buildBlobFromResponse(json);
}

async function refreshAccessToken(refreshToken: string): Promise<CodexTokenBlob | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  const response = await postTokenRequest(body);
  if (!response.ok) {
    log(`[CodexOAuth] Token refresh failed: status=${response.status}`);
    return null;
  }
  const json = (await response.json().catch(() => null)) as TokenResponse | null;
  if (!json) {
    log("[CodexOAuth] Token refresh returned invalid JSON");
    return null;
  }
  return buildBlobFromResponse(json);
}

function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

function renderResultPage(success: boolean, heading: string, body: string): string {
  const color = success ? "#10a37f" : "#dc2626";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Damocles — ChatGPT Sign-In</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0;">
<div style="text-align:center;max-width:480px;padding:24px;">
<h1 style="color:${color};margin-bottom:12px;">${heading}</h1>
<p>${body}</p>
</div></body></html>`;
}

export interface StartCodexOAuthDeps {
  context: vscode.ExtensionContext;
  onCompleted: (accountId: string | null) => void;
  onFailed: (error: string) => void;
}

export function isOAuthFlowInProgress(): boolean {
  return activeFlow !== null;
}

export function cancelActiveOAuthFlow(reason: string): void {
  activeFlow?.cancel();
  activeFlow = null;
  void reason;
}

export async function startCodexOAuth(deps: StartCodexOAuthDeps): Promise<CodexAuthResult> {
  if (activeFlow) {
    return { ok: false, error: "A sign-in flow is already in progress." };
  }

  const pkce = generatePkce();
  let verifier: string | null = pkce.verifier;
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(pkce.challenge, state);

  return new Promise<CodexAuthResult>((resolve) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const server = http.createServer((req, res) => {
      const method = req.method ?? "GET";
      const reqUrl = req.url ?? "";
      if (method !== "GET" || !reqUrl.startsWith("/auth/callback")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const callbackUrl = new URL(reqUrl, REDIRECT_URI);
      const code = callbackUrl.searchParams.get("code");
      const returnedState = callbackUrl.searchParams.get("state");
      const errorParam = callbackUrl.searchParams.get("error");

      if (errorParam) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderResultPage(false, "Sign-in cancelled", "You can close this window."));
        finish({ ok: false, error: `Provider returned error: ${errorParam}` });
        return;
      }

      if (!returnedState || !constantTimeEquals(returnedState, state)) {
        log("[CodexOAuth] State mismatch — refusing callback");
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderResultPage(false, "Sign-in failed", "State parameter mismatch."));
        finish({ ok: false, error: "OAuth state mismatch — possible CSRF. Sign-in aborted." });
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderResultPage(false, "Sign-in failed", "No authorization code returned."));
        finish({ ok: false, error: "No authorization code in callback." });
        return;
      }

      const currentVerifier = verifier;
      verifier = null;
      if (!currentVerifier) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(renderResultPage(false, "Sign-in failed", "Internal state lost."));
        finish({ ok: false, error: "Internal flow state lost." });
        return;
      }

      exchangeCodeForTokens(code, currentVerifier)
        .then(async (blob) => {
          if (!blob) {
            res.writeHead(502, { "Content-Type": "text/html" });
            res.end(renderResultPage(false, "Sign-in failed", "Token exchange failed."));
            finish({ ok: false, error: "Token exchange failed." });
            return;
          }
          try {
            await writeBlob(deps.context, blob);
          } catch (err) {
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(renderResultPage(false, "Sign-in failed", "Could not persist credentials."));
            log("[CodexOAuth] Failed to persist blob:", err instanceof Error ? err.message : err);
            finish({ ok: false, error: "Could not persist credentials securely." });
            return;
          }
          log(`[CodexOAuth] Sign-in completed accountId=${suffix(blob.chatgpt_account_id)}`);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(renderResultPage(true, "Signed in", "You can close this tab and return to VS Code."));
          finish(blob.chatgpt_account_id ? { ok: true, accountId: blob.chatgpt_account_id } : { ok: true });
        })
        .catch((err) => {
          log("[CodexOAuth] Token exchange error:", err instanceof Error ? err.message : err);
          try {
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(renderResultPage(false, "Sign-in failed", "Unexpected error during token exchange."));
          } catch {
            /* socket may already be closed */
          }
          finish({ ok: false, error: "Unexpected error during token exchange." });
        });
    });

    function finish(result: CodexAuthResult): void {
      if (settled) return;
      settled = true;
      verifier = null;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      try {
        server.close();
      } catch {
        /* server may already be closing */
      }
      activeFlow = null;
      if (result.ok) {
        deps.onCompleted(result.accountId ?? null);
      } else {
        deps.onFailed(result.error ?? "Sign-in failed.");
      }
      resolve(result);
    }

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        finish({
          ok: false,
          error: `Port ${LOOPBACK_PORT} in use — close any running Codex CLI login attempt and retry.`,
        });
        return;
      }
      log("[CodexOAuth] Loopback server error:", err.message);
      finish({ ok: false, error: `Loopback server error: ${err.message}` });
    });

    activeFlow = {
      cancel: () => {
        if (!settled) {
          finish({ ok: false, error: "Sign-in cancelled." });
        }
      },
    };

    server.listen(LOOPBACK_PORT, LOOPBACK_HOST, () => {
      timeoutHandle = setTimeout(() => {
        finish({ ok: false, error: "Sign-in timed out after 5 minutes." });
      }, FLOW_TIMEOUT_MS);

      log(`[CodexOAuth] Loopback listening on ${LOOPBACK_HOST}:${LOOPBACK_PORT}; opening browser`);
      void vscode.env.openExternal(vscode.Uri.parse(authorizeUrl)).then(
        (opened) => {
          if (!opened) {
            log("[CodexOAuth] openExternal returned false");
          }
        },
        (err) => {
          log("[CodexOAuth] openExternal threw:", err instanceof Error ? err.message : err);
          finish({ ok: false, error: "Could not open browser for sign-in." });
        }
      );
    });
  });
}

async function performRefresh(
  context: vscode.ExtensionContext,
  current: CodexTokenBlob,
  onExpired: () => void
): Promise<CodexTokenBlob | null> {
  const refreshed = await refreshAccessToken(current.refresh_token);
  if (!refreshed) {
    log(`[CodexOAuth] Refresh failed accountId=${suffix(current.chatgpt_account_id)} — clearing blob`);
    await deleteBlob(context);
    onExpired();
    return null;
  }
  await writeBlob(context, refreshed);
  log(`[CodexOAuth] Refreshed token accountId=${suffix(refreshed.chatgpt_account_id)}`);
  return refreshed;
}

export interface GetValidAccessTokenDeps {
  context: vscode.ExtensionContext;
  onExpired: () => void;
  forceRefresh?: boolean;
}

export async function getValidAccessToken(deps: GetValidAccessTokenDeps): Promise<CodexTokenBlob | null> {
  const current = await readBlob(deps.context);
  if (!current) return null;

  const needsRefresh = deps.forceRefresh === true || Date.now() >= current.expires_at - REFRESH_BUFFER_MS;
  if (!needsRefresh) return current;

  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const reread = await readBlob(deps.context);
      if (!reread) return null;
      const stillStale =
        deps.forceRefresh === true || Date.now() >= reread.expires_at - REFRESH_BUFFER_MS;
      if (!stillStale) return reread;
      return await performRefresh(deps.context, reread, deps.onExpired);
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function signOutCodex(context: vscode.ExtensionContext): Promise<void> {
  await deleteBlob(context);
  log("[CodexOAuth] Signed out — blob deleted");
}

export async function getCodexAuthSnapshot(
  context: vscode.ExtensionContext
): Promise<{ signedIn: boolean; accountId?: string; expiresAt?: number }> {
  const blob = await readBlob(context);
  if (!blob) return { signedIn: false };
  return blob.chatgpt_account_id
    ? { signedIn: true, accountId: blob.chatgpt_account_id, expiresAt: blob.expires_at }
    : { signedIn: true, expiresAt: blob.expires_at };
}
