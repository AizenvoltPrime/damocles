export interface AnnotationEntryDisplay {
  entryId: number;
  filePath: string | null;
  entryType: string;
  description: string;
  tags: string[];
  confidence: number;
  semanticGroup: string;
  lowRelevance: boolean;
}

export interface AnnotationLinkDisplay {
  linkType: 'depends_on' | 'extends' | 'reverts' | 'related';
  sourceEntryId: number;
  sourceFilePath: string | null;
  targetEntryId: number;
  targetFilePath: string | null;
  targetDescription: string;
  targetPromptIndex: number;
}

export interface HaikuDisplayBlock {
  type: 'text' | 'thinking' | 'annotation_summary';
  content: string;
  annotationCount?: number;
  lowRelevanceCount?: number;
  linkCount?: number;
  summary?: string;
  groups?: string[];
  failedCount?: number;
  entries?: AnnotationEntryDisplay[];
  links?: AnnotationLinkDisplay[];
}

export interface HaikuPromptActivity {
  promptIndex: number;
  thinking: string;
  text: string;
  blocks: HaikuDisplayBlock[];
  contextSnapshot: string;
  timestamp: number;
  annotationResult?: {
    annotationCount: number;
    lowRelevanceCount: number;
    linkCount: number;
    failedCount: number;
    summary: string;
    groups: string[];
    entries?: AnnotationEntryDisplay[];
    links?: AnnotationLinkDisplay[];
  };
}
