export interface ContextInjectionDisplay {
  promptIndex: number;
  bm25Context: string | null;
  rerankedContext: string | null;
  injectedContext: string;
  entryCount: number;
  rerankingEnabled: boolean;
  tokenBudget: number;
  planFilePath: string | null;
  decompositionFacets: string[] | null;
  createdAt: number;
}
