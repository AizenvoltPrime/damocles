export interface HaikuPromptActivity {
  promptIndex: number;
  thinking: string;
  text: string;
  contextSnapshot: string;
  timestamp: number;
}

export interface HaikuLogEvent {
  event: 'observation_start' | 'observation_complete';
  thinking?: string;
  text?: string;
  contextSnapshot?: string;
  timestamp: number;
}
