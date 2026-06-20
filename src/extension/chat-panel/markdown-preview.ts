import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../logger';

function slugify(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document';
}

/**
 * Write `content` to a temp `.md` file and open VS Code's rendered markdown preview. Used to surface
 * read-only context documents (the live system prompt, an MCP tool's schema) as a readable preview.
 * A stable per-slug filename means re-opening the same document overwrites rather than piling up temps.
 */
export async function openMarkdownPreview(slug: string, content: string): Promise<void> {
  try {
    const file = path.join(os.tmpdir(), `damocles-${slugify(slug)}.md`);
    await fs.promises.writeFile(file, content, 'utf8');
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
  } catch (err) {
    log('[markdownPreview] failed to open preview for %s: %O', slug, err);
    void vscode.window.showErrorMessage('Damocles: could not open the document preview.');
  }
}
