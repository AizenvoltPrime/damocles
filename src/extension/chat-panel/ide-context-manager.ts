import * as vscode from "vscode";
import * as path from "path";
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
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onContextChange: (info: IdeContextDisplayInfo | null) => void;

  constructor(excludeScheme: string, onContextChange: (info: IdeContextDisplayInfo | null) => void) {
    this.onContextChange = onContextChange;
    this.setupListeners(excludeScheme);
    this.updateContextFromActiveEditor(excludeScheme);
  }

  private setupListeners(excludeScheme: string): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.handleEditorChange(editor, excludeScheme);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.handleSelectionChange(event, excludeScheme);
      })
    );
  }

  private updateContextFromActiveEditor(excludeScheme: string): void {
    const editor = vscode.window.activeTextEditor;
    this.handleEditorChange(editor, excludeScheme);
  }

  private handleEditorChange(editor: vscode.TextEditor | undefined, excludeScheme: string): void {
    if (!editor || editor.document.uri.scheme === excludeScheme) {
      return;
    }

    if (editor.document.uri.scheme !== "file") {
      this.setContext(null);
      return;
    }

    const selection = editor.selection;
    if (!selection.isEmpty) {
      this.updateSelectionContext(editor);
    } else {
      this.updateOpenedFileContext(editor);
    }
  }

  private handleSelectionChange(event: vscode.TextEditorSelectionChangeEvent, excludeScheme: string): void {
    const editor = event.textEditor;

    if (editor.document.uri.scheme === excludeScheme) {
      return;
    }

    if (editor.document.uri.scheme !== "file") {
      this.setContext(null);
      return;
    }

    const selection = editor.selection;
    if (!selection.isEmpty) {
      this.updateSelectionContext(editor);
    } else {
      this.updateOpenedFileContext(editor);
    }
  }

  private updateSelectionContext(editor: vscode.TextEditor): void {
    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);

    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    this.setContext({
      type: "selection",
      filePath: editor.document.uri.fsPath,
      fileName: path.basename(editor.document.uri.fsPath),
      content: selectedText,
      startLine,
      endLine,
    });
  }

  private updateOpenedFileContext(editor: vscode.TextEditor): void {
    this.setContext({
      type: "opened_file",
      filePath: editor.document.uri.fsPath,
      fileName: path.basename(editor.document.uri.fsPath),
      content: "",
    });
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
