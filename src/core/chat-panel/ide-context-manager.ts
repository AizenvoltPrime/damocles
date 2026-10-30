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

/**
 * The IDE context a chat attaches to a send, per device: on a daemon's core each device (client id) has its own editor, and a
 * local host's one editor is the undefined key.
 */
export class IdeContextManager {
  private readonly contexts = new Map<string | undefined, FullIdeContext | null>([[undefined, null]]);
  private readonly disposables: Disposable[] = [];
  private readonly onContextChange: (info: IdeContextDisplayInfo | null, clientId: string | undefined) => void;

  private readonly accepts: (filePath: string) => boolean;
  private readonly editor: EditorService;

  /** `accepts` filters the files whose context reaches the chat; a refused file reads as no context. */
  constructor(editor: EditorService, onContextChange: (info: IdeContextDisplayInfo | null, clientId: string | undefined) => void, accepts: (filePath: string) => boolean = () => true) {
    this.onContextChange = onContextChange;
    this.accepts = accepts;
    this.editor = editor;
    this.disposables.push(editor.onDidChangeActiveContext((context, clientId) => this.handleEditorChange(context, clientId)));
    // a detached device's views are gone, and its next one reads its editor afresh
    const detach = editor.onDidDetachClient?.((clientId) => this.contexts.delete(clientId));
    if (detach) this.disposables.push(detach);
    this.handleEditorChange(editor.getActiveContext(), undefined);
  }

  /** What `accepts` answers changed (the chat moved to another folder): each device's editor context is filtered again. */
  refresh(): void {
    for (const [clientId, current] of [...this.contexts]) {
      const context = this.editor.getActiveContext(clientId);
      if (context) this.handleEditorChange(context, clientId);
      else if (current && !this.accepts(current.filePath)) this.setContext(null, clientId);
    }
  }

  /** undefined (no editor, or one the host ignores) keeps the device's current context. */
  private handleEditorChange(context: ActiveEditorContext | undefined, clientId: string | undefined): void {
    if (context) this.setContext(this.filtered(context), clientId);
  }

  private filtered(context: ActiveEditorContext): FullIdeContext | null {
    if (context.filePath === undefined || !this.accepts(context.filePath)) return null;
    const fileName = path.basename(context.filePath);
    if (context.selection) {
      return {
        type: "selection",
        filePath: context.filePath,
        fileName,
        content: context.selection.text,
        startLine: context.selection.startLine,
        endLine: context.selection.endLine,
      };
    }
    return { type: "opened_file", filePath: context.filePath, fileName, content: "" };
  }

  /** A device this chat heard no change from has the context its editor reports now. */
  private contextOf(clientId: string | undefined): FullIdeContext | null {
    if (!this.contexts.has(clientId)) {
      const context = this.editor.getActiveContext(clientId);
      this.contexts.set(clientId, context ? this.filtered(context) : null);
    }
    return this.contexts.get(clientId) ?? null;
  }

  private setContext(context: FullIdeContext | null, clientId: string | undefined): void {
    const changed = hasContextChanged(this.contexts.get(clientId) ?? null, context);
    this.contexts.set(clientId, context);

    if (changed) {
      this.onContextChange(displayInfo(context), clientId);
    }
  }

  /** clientId: the device whose editor's context it reads (the sending device's), undefined on a host with one editor. */
  getDisplayInfo(clientId: string | undefined): IdeContextDisplayInfo | null {
    return displayInfo(this.contextOf(clientId));
  }

  buildContentBlocks(message: string, clientId: string | undefined): string | ContentBlock[];
  buildContentBlocks(message: UserContentBlock[], clientId: string | undefined): ContentBlock[];
  buildContentBlocks(message: string | UserContentBlock[], clientId: string | undefined): string | ContentBlock[];
  buildContentBlocks(message: string | UserContentBlock[], clientId: string | undefined): string | ContentBlock[] {
    const context = this.contextOf(clientId);
    const contextBlock = context ? formatIdeContextBlock(context) : null;

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

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

function hasContextChanged(current: FullIdeContext | null, next: FullIdeContext | null): boolean {
  if (current === null && next === null) return false;
  if (current === null || next === null) return true;
  if (current.type !== next.type) return true;
  if (current.filePath !== next.filePath) return true;

  if (current.type === "selection" && next.type === "selection") {
    return current.startLine !== next.startLine || current.endLine !== next.endLine;
  }

  return false;
}

function displayInfo(context: FullIdeContext | null): IdeContextDisplayInfo | null {
  if (!context) return null;

  const { type, filePath, fileName } = context;

  if (type === "selection") {
    return {
      type: "selection",
      filePath,
      fileName,
      lineCount: context.endLine - context.startLine + 1,
    };
  }

  return {
    type: "opened_file",
    filePath,
    fileName,
  };
}
