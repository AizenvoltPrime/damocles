export interface LogSink {
  appendLine(line: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface LogSinkFactory {
  create(name: string): LogSink;
}
