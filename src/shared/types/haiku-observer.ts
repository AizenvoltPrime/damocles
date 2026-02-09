export interface HaikuDisplayBlock {
  type: 'text' | 'thinking' | 'tool';
  content: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
}

export interface HaikuPromptActivity {
  promptIndex: number;
  thinking: string;
  text: string;
  blocks: HaikuDisplayBlock[];
  contextSnapshot: string;
  timestamp: number;
}
