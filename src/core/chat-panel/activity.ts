import type { Disposable } from "../../platform/disposable";
import type { ChatActivity, TurnOutcome } from "../pi-session/session-state";
import type { UsageThresholdCrossing } from "../pi-session/usage-thresholds";
import { log } from "../logger";

/** What a session reports to the panel that shows it. */
export interface ActivitySource {
  setActivityListener(listener: ((activity: ChatActivity) => void) | null): void;
  setTurnSettledListener(listener: ((outcome: TurnOutcome) => void) | null): void;
}

export type PanelActivityListener = (panelId: string, activity: ChatActivity) => void;
export type PanelTurnSettledListener = (panelId: string, outcome: TurnOutcome) => void;

export type UsageThresholdListener = (crossing: UsageThresholdCrossing) => void;

function subscribe<L>(listeners: Set<L>, listener: L): Disposable {
  listeners.add(listener);
  return { dispose: (): void => { listeners.delete(listener); } };
}

/** Forwards each panel's session activity and turn outcomes to listeners keyed by panel id. */
export class PanelActivity {
  private readonly activityListeners = new Set<PanelActivityListener>();
  private readonly settledListeners = new Set<PanelTurnSettledListener>();
  private readonly thresholdListeners = new Set<UsageThresholdListener>();

  onActivity(listener: PanelActivityListener): Disposable {
    return subscribe(this.activityListeners, listener);
  }

  onTurnSettled(listener: PanelTurnSettledListener): Disposable {
    return subscribe(this.settledListeners, listener);
  }

  onUsageThreshold(listener: UsageThresholdListener): Disposable {
    return subscribe(this.thresholdListeners, listener);
  }

  usageThresholdCrossed(crossing: UsageThresholdCrossing): void {
    for (const listener of [...this.thresholdListeners]) {
      try {
        listener(crossing);
      } catch (err) {
        log("[PanelActivity] usage threshold listener error: %O", err);
      }
    }
  }

  /** The session reports its current activity as soon as it is bound, so listeners hear every bind. */
  bind(panelId: string, session: ActivitySource): void {
    session.setTurnSettledListener((outcome) => {
      for (const listener of [...this.settledListeners]) {
        try {
          listener(panelId, outcome);
        } catch (err) {
          log("[PanelActivity] turn settled listener error: %O", err);
        }
      }
    });
    session.setActivityListener((activity) => {
      for (const listener of [...this.activityListeners]) {
        try {
          listener(panelId, activity);
        } catch (err) {
          log("[PanelActivity] activity listener error: %O", err);
        }
      }
    });
  }

  unbind(session: ActivitySource): void {
    session.setActivityListener(null);
    session.setTurnSettledListener(null);
  }
}
