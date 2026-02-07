export interface HaikuIteration {
  iteration: number;
  thinking: string;
  text: string;
  timestamp: number;
}

export interface HaikuPromptActivity {
  promptIndex: number;
  thinking: string;
  text: string;
  contextSnapshot: string;
  timestamp: number;
  iterations: HaikuIteration[];
}

export interface HaikuLogEvent {
  event: 'iteration_start' | 'iteration_complete';
  iteration: number;
  thinking?: string;
  text?: string;
  isFinal?: boolean;
  contextSnapshot?: string;
  timestamp: number;
}
