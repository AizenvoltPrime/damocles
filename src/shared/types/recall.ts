export interface SubcallRecord {
  prompt: string;
  model: string;
  response: string;
  durationMs: number;
}

export interface RecallIteration {
  index: number;
  modelResponse: string;
  codeBlock: string | null;
  replOutput: string | null;
  subcalls: SubcallRecord[];
  durationMs: number;
}

export interface RecallTrajectory {
  promptIndex: number;
  userPrompt: string;
  iterations: RecallIteration[];
  finalContext: string | null;
  totalDurationMs: number;
  shortCircuited: boolean;
  forcedAnswer: boolean;
  timedOut: boolean;
  turnCount: number;
  historyChars: number;
}
