import { log } from '../logger';

type SDKSessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  customTitle?: string;
  tag?: string;
  createdAt?: number;
};

type SessionMutationOptions = { dir?: string };
type GetSessionInfoOptions = { dir?: string };

type SDKSessionOps = {
  tagSession: (sessionId: string, tag: string | null, options?: SessionMutationOptions) => Promise<void>;
  getSessionInfo: (sessionId: string, options?: GetSessionInfoOptions) => Promise<SDKSessionInfo | undefined>;
};

let sdkSessionOpsPromise: Promise<SDKSessionOps> | undefined;

async function loadSDKSessionOps(): Promise<SDKSessionOps> {
  if (!sdkSessionOpsPromise) {
    sdkSessionOpsPromise = import("@anthropic-ai/claude-agent-sdk").then(sdk => ({
      tagSession: sdk.tagSession,
      getSessionInfo: sdk.getSessionInfo,
    }));
  }
  return sdkSessionOpsPromise;
}

export async function tagSessionViaSDK(
  sessionId: string,
  tag: string | null,
  dir?: string
): Promise<void> {
  const ops = await loadSDKSessionOps();
  await ops.tagSession(sessionId, tag, dir ? { dir } : undefined);
  log('[sdk-operations] Tagged session %s: %s', sessionId, tag ?? '(removed)');
}

export async function getSessionInfoFromSDK(
  sessionId: string,
  dir?: string
): Promise<SDKSessionInfo | undefined> {
  const ops = await loadSDKSessionOps();
  return ops.getSessionInfo(sessionId, dir ? { dir } : undefined);
}
