import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ContextMonitor } from '../context-monitor';
import type { AutoCompactConfig } from '../../../shared/types/settings';

const CONTEXT_WINDOW = 400_000;
const CRITICAL_TOKENS = 320_000;

const DEFAULT_CONFIG: AutoCompactConfig = {
  enabled: false,
  warningThreshold: 60,
  softThreshold: 70,
  hardThreshold: 75,
};

function mockAutoCompactConfig(overrides: Partial<AutoCompactConfig> = {}): void {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: () => config,
  } as unknown as vscode.WorkspaceConfiguration);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContextMonitor — auto-compaction is user-gated', () => {
  it('does not trigger at critical when the user has not enabled autoCompact', () => {
    mockAutoCompactConfig({ enabled: false });
    const onAutoCompactTrigger = vi.fn();
    const monitor = new ContextMonitor(
      { onWarningLevelChange: () => {}, onAutoCompactTrigger },
      CONTEXT_WINDOW,
    );

    monitor.updateTokenUsage(CRITICAL_TOKENS);

    expect(monitor.currentState.currentLevel).toBe('critical');
    expect(onAutoCompactTrigger).not.toHaveBeenCalled();
  });

  it('triggers at critical when the user enabled autoCompact', () => {
    mockAutoCompactConfig({ enabled: true });
    const onAutoCompactTrigger = vi.fn();
    const monitor = new ContextMonitor(
      { onWarningLevelChange: () => {}, onAutoCompactTrigger },
      CONTEXT_WINDOW,
    );

    monitor.updateTokenUsage(CRITICAL_TOKENS);

    expect(monitor.currentState.currentLevel).toBe('critical');
    expect(onAutoCompactTrigger).toHaveBeenCalledTimes(1);
  });

  it('re-arms after onCompactComplete and fires again, but never twice within one cycle', () => {
    mockAutoCompactConfig({ enabled: true });
    const onAutoCompactTrigger = vi.fn();
    const monitor = new ContextMonitor(
      { onWarningLevelChange: () => {}, onAutoCompactTrigger },
      CONTEXT_WINDOW,
    );

    monitor.updateTokenUsage(CRITICAL_TOKENS);
    monitor.updateTokenUsage(CRITICAL_TOKENS);
    expect(onAutoCompactTrigger).toHaveBeenCalledTimes(1);

    monitor.onCompactComplete();
    monitor.updateTokenUsage(CRITICAL_TOKENS);
    expect(onAutoCompactTrigger).toHaveBeenCalledTimes(2);
  });
});
