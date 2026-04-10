import * as vscode from 'vscode';
import type { GraphStore } from './database';
import type { StoredNode, ImpactResult } from './types';
import { computeBlastRadius } from './impact';

export class BlastRadiusDecorations implements vscode.Disposable {
	private _impact: ImpactResult | null = null;
	private _changedFiles = new Set<string>();
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _warningDecoration: vscode.TextEditorDecorationType;
	private readonly _infoDecoration: vscode.TextEditorDecorationType;

	constructor() {
		this._warningDecoration = vscode.window.createTextEditorDecorationType({
			overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
			backgroundColor: 'rgba(255, 100, 100, 0.08)',
			isWholeLine: true,
		});
		this._infoDecoration = vscode.window.createTextEditorDecorationType({
			overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
			backgroundColor: 'rgba(255, 200, 50, 0.06)',
			isWholeLine: true,
		});
		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => this._applyToVisibleEditors()),
			vscode.window.onDidChangeVisibleTextEditors(() => this._applyToVisibleEditors()),
		);
	}

	showForFile(store: GraphStore, filePath: string): ImpactResult {
		const depth = vscode.workspace.getConfiguration('damocles.compass').get<number>('blastRadiusDepth', 2);
		this._impact = computeBlastRadius(store, [filePath], depth);
		this._changedFiles = new Set([filePath]);
		this._applyToVisibleEditors();
		return this._impact;
	}

	showForResult(impact: ImpactResult, changedFiles: string[]): void {
		this._impact = impact;
		this._changedFiles = new Set(changedFiles);
		this._applyToVisibleEditors();
	}

	dismiss(): void {
		this._impact = null;
		this._changedFiles.clear();
		for (const editor of vscode.window.visibleTextEditors) {
			editor.setDecorations(this._warningDecoration, []);
			editor.setDecorations(this._infoDecoration, []);
		}
	}

	private _applyToVisibleEditors(): void {
		if (!this._impact) return;

		const impactedByFile = new Map<string, StoredNode[]>();
		for (const node of [...this._impact.changed_nodes, ...this._impact.impacted_nodes]) {
			const list = impactedByFile.get(node.file_path) ?? [];
			list.push(node);
			impactedByFile.set(node.file_path, list);
		}

		for (const editor of vscode.window.visibleTextEditors) {
			const fsPath = editor.document.uri.fsPath;
			const nodes = impactedByFile.get(fsPath);

			if (!nodes || nodes.length === 0) {
				editor.setDecorations(this._warningDecoration, []);
				editor.setDecorations(this._infoDecoration, []);
				continue;
			}

			const warningRanges: vscode.DecorationOptions[] = [];
			const infoRanges: vscode.DecorationOptions[] = [];

			for (const node of nodes) {
				const startLine = Math.max(0, node.line_start - 1);
				const endLine = Math.max(0, node.line_end - 1);
				const range = new vscode.Range(startLine, 0, endLine, 0);
				const hoverMessage = new vscode.MarkdownString(
					`**${node.kind}** \`${node.name}\`  \nBlast radius: ${this._changedFiles.has(fsPath) ? 'directly changed' : 'transitively impacted'}`,
				);

				if (this._changedFiles.has(fsPath)) {
					warningRanges.push({ range, hoverMessage });
				} else {
					infoRanges.push({ range, hoverMessage });
				}
			}

			editor.setDecorations(this._warningDecoration, warningRanges);
			editor.setDecorations(this._infoDecoration, infoRanges);
		}
	}

	dispose(): void {
		this.dismiss();
		for (const d of this._disposables) d.dispose();
		this._warningDecoration.dispose();
		this._infoDecoration.dispose();
	}
}
