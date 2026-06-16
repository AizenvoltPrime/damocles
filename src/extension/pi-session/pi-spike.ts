import * as vscode from 'vscode';
import type { Model, Api } from '@earendil-works/pi-ai';
import { log, showLog } from '../logger';
import { PiRuntime } from './pi-runtime';
import { PI_AGENT_DIR } from './agent-dir';
import { attachSpikeLogger } from './pi-stream-log';

/** Numeric id segments below this are version numbers; >= this are date suffixes (yyyymmdd) to ignore. */
const VERSION_SEGMENT_MAX = 100000;
/** Sort weights: generation (major) dominates tier, which dominates minor version. */
const MAJOR_WEIGHT = 100000;
const TIER_WEIGHT = 1000;

/** Standard Claude tier rank (opus > sonnet > haiku); 0 for non-standard models (e.g. Fable). */
function tierRank(id: string): number {
  return id.includes('opus') ? 3 : id.includes('sonnet') ? 2 : id.includes('haiku') ? 1 : 0;
}

/**
 * Rough "intelligence" score for a Claude model id, higher = smarter. Generation (major version)
 * dominates, then tier (opus > sonnet > haiku), then minor version. Date/-v suffixes are ignored.
 * e.g. claude-opus-4-8 > claude-sonnet-4-6 > claude-haiku-4-5 > claude-3-5-sonnet.
 */
function intelligenceScore(id: string): number {
  const nums = (id.match(/\d+/g) ?? []).map(Number).filter((n) => n < VERSION_SEGMENT_MAX);
  const major = nums[0] ?? 0;
  const minor = nums[1] ?? 0;
  return major * MAJOR_WEIGHT + tierRank(id) * TIER_WEIGHT + minor;
}

/**
 * Sort standard-tier models (opus/sonnet/haiku) smartest → least smart. Non-standard models such
 * as Fable are excluded — they are not available on the subscription tier (Anthropic returns 404
 * "Please use Opus 4.8").
 */
function sortBySmartest(models: Model<Api>[]): Model<Api>[] {
  return models
    .filter((m) => tierRank(m.id) > 0)
    .sort((a, b) => intelligenceScore(b.id) - intelligenceScore(a.id));
}

/**
 * Phase 0 foundation spike (US-001). Proves the pi embed end-to-end inside the live extension
 * host: dynamic-imported pi (B2), the single shared runtime (B1), the Damocles-owned agent dir
 * with compaction disabled (B3), and a streamed turn rendered to the OutputChannel.
 *
 * Requires auth to be configured for some provider (a subscription via the user-installed
 * pi-anthropic-oauth extension, or an API key in pi's auth store). With no auth, it reports that
 * no model is available rather than failing.
 */
export async function runPiSpike(): Promise<void> {
  showLog(true);
  log('[PiSpike] ===== pi foundation spike starting =====');

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const runtime = PiRuntime.get(cwd, PI_AGENT_DIR);

  try {
    await runtime.init();
  } catch (err) {
    log('[PiSpike] init FAILED: %O', err);
    vscode.window.showErrorMessage(`pi spike: init failed — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const services = runtime.services;
  if (!services) {
    log('[PiSpike] no services after init');
    return;
  }

  const available = services.modelRegistry.getAvailable();
  log('[PiSpike] %d model(s) available with configured auth', available.length);
  const anthropic = sortBySmartest(available.filter((m) => m.api === 'anthropic-messages'));
  log('[PiSpike] models smartest→least: %s', anthropic.map((m) => m.id).join(', '));
  const model = anthropic[0] ?? available[0];
  if (!model) {
    log('[PiSpike] No model available — configure a subscription (pi-anthropic-oauth) or an API key.');
    vscode.window.showWarningMessage('pi spike: no model/auth available. Enable a subscription or set an API key, then retry.');
    return;
  }
  log('[PiSpike] using model %s (api=%s, provider=%s)', model.id, model.api, model.provider);

  const session = await runtime.createSession({ model, ephemeral: true });
  log('[PiSpike] session created; autoCompactionEnabled=%s (expect false)', session.autoCompactionEnabled);

  const unsubscribe = attachSpikeLogger(session, (line) => log(line));
  try {
    await session.prompt('Reply with a short, friendly one-sentence greeting.');
    log('[PiSpike] prompt resolved; lastAssistantText=%j', session.getLastAssistantText());
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant && lastAssistant.role === 'assistant') {
      log(
        '[PiSpike] assistant stopReason=%s errorMessage=%s content=[%s]',
        lastAssistant.stopReason,
        lastAssistant.errorMessage ?? '(none)',
        lastAssistant.content.map((c) => c.type).join(','),
      );
      if (lastAssistant.diagnostics?.length) {
        log('[PiSpike] assistant diagnostics=%j', lastAssistant.diagnostics);
      }
    }
  } catch (err) {
    log('[PiSpike] prompt FAILED: %O', err);
    vscode.window.showErrorMessage(`pi spike: prompt failed — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    unsubscribe();
    runtime.forgetSession(session);
    log('[PiSpike] ===== pi foundation spike finished =====');
  }
}

/** Register the `damocles.piSpike` developer command. */
export function registerPiSpikeCommand(context: vscode.ExtensionContext): vscode.Disposable {
  const disposable = vscode.commands.registerCommand('damocles.piSpike', () => {
    runPiSpike().catch((err) => log('[PiSpike] uncaught: %O', err));
  });
  context.subscriptions.push(disposable);
  return disposable;
}
