export function buildPlanImplementationMessage(
  planContent: string,
  transcriptPath: string | null
): string {
  let message = `Implement the following plan:\n\n${planContent}`;

  if (transcriptPath) {
    message += `\n\nIf you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`;
  }

  return message;
}
