import * as vscode from 'vscode';
import { log } from '../logger';
import type { AutoCompactConfig, ContextWarningLevel } from '../../shared/types/settings';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';

const DEFAULT_AUTO_COMPACT_CONFIG: AutoCompactConfig = {
  enabled: false,
  warningThreshold: 60,
  softThreshold: 70,
  hardThreshold: 75,
};

export interface ContextMonitorState {
  inputTokens: number;
  contextWindowSize: number;
  percentUsed: number;
  currentLevel: ContextWarningLevel;
  autoCompactTriggered: boolean;
}

export interface ContextMonitorCallbacks {
  onWarningLevelChange: (message: ExtensionToWebviewMessage) => void;
  onAutoCompactTrigger: () => void;
}

function getAutoCompactConfig(): AutoCompactConfig {
  const config = vscode.workspace.getConfiguration('damocles');
  return config.get<AutoCompactConfig>('autoCompact', DEFAULT_AUTO_COMPACT_CONFIG);
}

function calculateWarningLevel(percentUsed: number, config: AutoCompactConfig): ContextWarningLevel {
  if (percentUsed >= config.hardThreshold) return 'critical';
  if (percentUsed >= config.softThreshold) return 'soft';
  if (percentUsed >= config.warningThreshold) return 'warning';
  return 'none';
}

export class ContextMonitor {
  private state: ContextMonitorState;
  private callbacks: ContextMonitorCallbacks;
  private autoCompactInProgress = false;

  constructor(callbacks: ContextMonitorCallbacks, contextWindowSize: number) {
    this.callbacks = callbacks;
    this.state = {
      inputTokens: 0,
      contextWindowSize,
      percentUsed: 0,
      currentLevel: 'none',
      autoCompactTriggered: false,
    };
  }

  get currentState(): ContextMonitorState {
    return { ...this.state };
  }

  get percentUsed(): number {
    return this.state.percentUsed;
  }

  updateTokenUsage(inputTokens: number): void {
    const config = getAutoCompactConfig();
    const contextWindow = this.state.contextWindowSize;

    this.state.inputTokens = inputTokens;
    this.state.percentUsed = contextWindow > 0
      ? (inputTokens / contextWindow) * 100
      : 0;

    const newLevel = calculateWarningLevel(this.state.percentUsed, config);
    const previousLevel = this.state.currentLevel;

    if (newLevel !== previousLevel) {
      this.state.currentLevel = newLevel;
      this.notifyWarningLevelChange();

      if (newLevel === 'none') {
        this.resetFlags();
      }
    }

    if (config.enabled && newLevel === 'critical' && !this.state.autoCompactTriggered && !this.autoCompactInProgress) {
      this.triggerAutoCompact();
    }
  }

  private notifyWarningLevelChange(): void {
    this.callbacks.onWarningLevelChange({
      type: 'contextWarning',
      level: this.state.currentLevel,
    });
  }

  private triggerAutoCompact(): void {
    if (this.autoCompactInProgress) return;

    this.autoCompactInProgress = true;
    this.state.autoCompactTriggered = true;

    log('[ContextMonitor] Triggering auto-compact at %s%% context usage', this.state.percentUsed.toFixed(1));

    this.callbacks.onWarningLevelChange({
      type: 'autoCompactTriggering',
      percentUsed: this.state.percentUsed,
    });

    this.callbacks.onAutoCompactTrigger();
    this.autoCompactInProgress = false;
  }

  private resetFlags(): void {
    this.state.autoCompactTriggered = false;
    this.autoCompactInProgress = false;
  }

  onCompactComplete(): void {
    this.resetFlags();
    this.state.currentLevel = 'none';
    this.callbacks.onWarningLevelChange({
      type: 'contextWarning',
      level: 'none',
    });
  }

  setContextWindowSize(size: number): void {
    this.state.contextWindowSize = size;
  }

  reset(contextWindowSize: number): void {
    this.state = {
      inputTokens: 0,
      contextWindowSize,
      percentUsed: 0,
      currentLevel: 'none',
      autoCompactTriggered: false,
    };
    this.autoCompactInProgress = false;
  }
}
