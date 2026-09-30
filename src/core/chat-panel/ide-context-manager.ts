import * as path from "path";
import type { Disposable } from "../../platform/disposable";
import type { ActiveEditorContext, EditorService } from "../../platform/editor-service";
import type { IdeContextDisplayInfo } from "../../shared/types/session";
import type { UserContentBlock } from "../../shared/types/content";
import { formatIdeContextBlock } from "@shared/ide-context";

interface SelectionContext {
  type: "selection";
  filePath: string;
  fileName: string;
  content: string;
  startLine: number;
  endLine: number;
}

interface OpenedFileContext {
  type: "opened_file";
  filePath: string;
  fileName: string;
  content: string;
}

type FullIdeContext = SelectionContext | OpenedFileContext;

type TextBlock = { type: "text"; text: string };
type ContentBlock = TextBlock | UserContentBlock;

export class IdeContextManager {
  private currentContext: FullIdeContext | null = null;
  private readonly disposables: Disposable[] = [];
  private readonly onContextChange: (info: IdeContextDisplayInfo | null) => void;

  constructor(editor: EditorService, onContextChange: (info: IdeContextDisplayInfo | null) => void) {
    this.onContextChange = onContextChange;
    this.disposables.push(editor.onDidChangeActiveContext((context) => this.handleEditorChange(context)));
    this.handleEditorChange(editor.getActiveContext());
  }

  /** undefined (no editor, or one the host ignores) keeps the current context. */
  private handleEditorChange(context: ActiveEditorContext | undefined): void {
    if (!context) return;

    if (context.filePath === undefined) {
      this.setContext(null);
      return;
    }

    const fileName = path.basename(context.filePath);
    if (context.selection) {
      this.setContext({
        type: "selection",
        filePath: context.filePath,
        fileName,
        content: context.selection.text,
        startLine: context.selection.startLine,
        endLine: context.selection.endLine,
      });
    } else {
      this.setContext({
        type: "opened_file",
        filePath: context.filePath,
        fileName,
        content: "",
      });
    }
  }

  private setContext(context: FullIdeContext | null): void {
    const changed = this.hasContextChanged(context);
    this.currentContext = context;

    if (changed) {
      this.onContextChange(this.getDisplayInfo());
    }
  }

  private hasContextChanged(newContext: FullIdeContext | null): boolean {
    if (this.currentContext === null && newContext === null) return false;
    if (this.currentContext === null || newContext === null) return true;
    if (this.currentContext.type !== newContext.type) return true;
    if (this.currentContext.filePath !== newContext.filePath) return true;

    if (this.currentContext.type === "selection" && newContext.type === "selection") {
      return (
        this.currentContext.startLine !== newContext.startLine ||
        this.currentContext.endLine !== newContext.endLine
      );
    }

    return false;
  }

  getDisplayInfo(): IdeContextDisplayInfo | null {
    if (!this.currentContext) return null;

    const { type, filePath, fileName } = this.currentContext;

    if (type === "selection") {
      const { startLine, endLine } = this.currentContext;
      return {
        type: "selection",
        filePath,
        fileName,
        lineCount: endLine - startLine + 1,
      };
    }

    return {
      type: "opened_file",
      filePath,
      fileName,
    };
  }

  buildContentBlocks(message: string): string | ContentBlock[];
  buildContentBlocks(message: UserContentBlock[]): ContentBlock[];
  buildContentBlocks(message: string | UserContentBlock[]): string | ContentBlock[];
  buildContentBlocks(message: string | UserContentBlock[]): string | ContentBlock[] {
    const contextBlock = this.formatContextBlock();

    if (typeof message === "string") {
      if (!contextBlock) return message;
      return [
        { type: "text", text: contextBlock },
        { type: "text", text: message },
      ];
    }

    if (!contextBlock) return message;
    return [
      { type: "text", text: contextBlock },
      ...message,
    ];
  }

  private formatContextBlock(): string | null {
    return this.currentContext ? formatIdeContextBlock(this.currentContext) : null;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
