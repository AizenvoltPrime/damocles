export interface ClipboardService {
  writeText(text: string): Promise<void>;
}
