/** Weights of the gated injection score, shared by the gate and the webview's score breakdown. */
export const SCORE_WEIGHTS = {
  relevance: 0.55,
  file: 0.15,
  recency: 0.15,
  retrieval: 0.1,
} as const;
