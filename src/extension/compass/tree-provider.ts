import * as vscode from 'vscode';
import * as path from 'path';
import type { StoredNode, StoredEdge, IndexStatus } from './types';
import type { CompassService } from './index';

const KIND_ICON: Record<string, string> = {
	File: 'file',
	Class: 'symbol-class',
	Function: 'symbol-method',
	Type: 'symbol-interface',
	Test: 'testing-run-icon',
};

const KIND_CONTEXT: Record<string, string> = {
	File: 'node-file',
	Class: 'node-class',
	Function: 'node-function',
	Type: 'node-type',
	Test: 'node-test',
};

const OUTGOING_LABELS: Record<string, string> = {
	CALLS: 'calls',
	IMPORTS_FROM: 'imports',
	INHERITS: 'inherits from',
	IMPLEMENTS: 'implements',
	TESTED_BY: 'tested by',
	CONTAINS: 'contains',
	DEPENDS_ON: 'depends on',
};

const INCOMING_LABELS: Record<string, string> = {
	CALLS: 'called by',
	IMPORTS_FROM: 'imported by',
	INHERITS: 'inherited by',
	IMPLEMENTS: 'implemented by',
	TESTED_BY: 'tests',
	CONTAINS: 'contained in',
	DEPENDS_ON: 'depended on by',
};

const EDGE_ICON: Record<string, Record<string, string>> = {
	outgoing: {
		CALLS: 'arrow-right',
		IMPORTS_FROM: 'package',
		INHERITS: 'type-hierarchy',
		IMPLEMENTS: 'symbol-interface',
		TESTED_BY: 'testing-run-icon',
		CONTAINS: 'symbol-namespace',
		DEPENDS_ON: 'references',
	},
	incoming: {
		CALLS: 'arrow-left',
		IMPORTS_FROM: 'package',
		INHERITS: 'type-hierarchy',
		IMPLEMENTS: 'symbol-interface',
		TESTED_BY: 'testing-run-icon',
		CONTAINS: 'symbol-namespace',
		DEPENDS_ON: 'references',
	},
};

function shortName(qualifiedName: string): string {
	const colonIdx = qualifiedName.lastIndexOf('::');
	return colonIdx >= 0 ? qualifiedName.substring(colonIdx + 2) : path.basename(qualifiedName);
}

function symbolLabel(name: string, kind: string): string {
	return (kind === 'Function' || kind === 'Test') ? `${name}()` : name;
}

function symbolDescription(kind: string, lineStart: number, lineEnd: number): string {
	const k = kind.toLowerCase();
	return lineEnd !== lineStart ? `${k} · L${lineStart}–${lineEnd}` : `${k} · L${lineStart}`;
}

function openCommand(filePath: string, line: number): vscode.Command {
	const l = Math.max(0, line - 1);
	return {
		title: 'Go to Symbol',
		command: 'vscode.open',
		arguments: [
			vscode.Uri.file(filePath),
			{ selection: new vscode.Range(l, 0, l, 0) } as vscode.TextDocumentShowOptions,
		],
	};
}

class FileItem extends vscode.TreeItem {
	readonly filePath: string;
	constructor(filePath: string, workspaceRoot: string) {
		super(path.basename(filePath), vscode.TreeItemCollapsibleState.Collapsed);
		this.filePath = filePath;
		const rel = path.relative(workspaceRoot, filePath);
		this.description = rel !== path.basename(filePath) ? rel : '';
		this.iconPath = new vscode.ThemeIcon('file');
		this.contextValue = 'node-file';
		this.tooltip = filePath;
		this.command = { title: 'Open File', command: 'vscode.open', arguments: [vscode.Uri.file(filePath)] };
	}
}

class SymbolItem extends vscode.TreeItem {
	readonly qualifiedName: string;
	readonly filePath: string;
	readonly kind: string;
	constructor(node: StoredNode) {
		super(symbolLabel(node.name, node.kind), vscode.TreeItemCollapsibleState.Collapsed);
		this.qualifiedName = node.qualified_name;
		this.filePath = node.file_path;
		this.kind = node.kind;
		this.description = symbolDescription(node.kind, node.line_start, node.line_end);
		this.iconPath = new vscode.ThemeIcon(KIND_ICON[node.kind] ?? 'symbol-misc');
		this.contextValue = KIND_CONTEXT[node.kind] ?? 'node-function';
		this.tooltip = node.qualified_name;
		this.command = openCommand(node.file_path, node.line_start);
	}
}

class EdgeItem extends vscode.TreeItem {
	constructor(edge: StoredEdge, direction: 'outgoing' | 'incoming', targetNode: { file_path: string; line_start: number } | null) {
		const targetQn = direction === 'outgoing' ? edge.target_qualified : edge.source_qualified;
		const verb = direction === 'outgoing'
			? (OUTGOING_LABELS[edge.kind] ?? edge.kind.toLowerCase())
			: (INCOMING_LABELS[edge.kind] ?? edge.kind.toLowerCase());
		const arrow = direction === 'outgoing' ? '→' : '←';
		super(`${arrow} ${verb} ${shortName(targetQn)}`, vscode.TreeItemCollapsibleState.None);

		const iconMap = EDGE_ICON[direction] ?? {};
		this.iconPath = new vscode.ThemeIcon(iconMap[edge.kind] ?? 'arrow-right');
		this.contextValue = 'edge';
		this.tooltip = `${arrow} ${verb} ${targetQn}`;

		const targetFile = targetNode?.file_path ?? edge.file_path;
		const targetLine = targetNode?.line_start ?? edge.line;
		this.command = openCommand(targetFile, targetLine);
	}
}

class GroupItem extends vscode.TreeItem {
	readonly groupKind: 'changed' | 'impacted';
	constructor(groupKind: 'changed' | 'impacted', count: number) {
		super(
			groupKind === 'changed' ? `Changed (${count})` : `Impacted (${count})`,
			vscode.TreeItemCollapsibleState.Expanded,
		);
		this.groupKind = groupKind;
		this.iconPath = new vscode.ThemeIcon(groupKind === 'changed' ? 'flame' : 'broadcast');
		this.contextValue = `blast-radius-${groupKind}`;
		this.tooltip = groupKind === 'changed'
			? `${count} directly changed node(s)`
			: `${count} transitively impacted node(s)`;
	}
}

export class CompassTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null> = this._onDidChange.event;
	private readonly compassService: CompassService;
	private readonly workspaceRoot: string;

	constructor(compassService: CompassService, workspaceRoot: string) {
		this.compassService = compassService;
		this.workspaceRoot = workspaceRoot;
	}

	refresh(): void {
		this._onDidChange.fire(undefined);
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
		const status = this.compassService.getStatus();
		if (status.state !== 'ready') return [];

		if (!element) {
			const files = await this.compassService.treeGetFiles();
			return files
				.sort((a, b) => a.localeCompare(b))
				.map(f => new FileItem(f, this.workspaceRoot));
		}

		if (element instanceof FileItem) {
			const nodes = await this.compassService.treeGetNodesByFile(element.filePath) as StoredNode[];
			return nodes
				.filter(n => n.kind !== 'File')
				.sort((a, b) => a.line_start - b.line_start)
				.map(n => new SymbolItem(n));
		}

		if (element instanceof SymbolItem) {
			const data = await this.compassService.treeGetEdgesForSymbol(element.qualifiedName) as {
				outgoing: Array<{ edge: StoredEdge; target: { file_path: string; line_start: number } | null }>;
				incoming: Array<{ edge: StoredEdge; source: { file_path: string; line_start: number } | null }>;
			};
			const items: vscode.TreeItem[] = [];
			for (const { edge, target } of data.outgoing) {
				if (edge.kind === 'CONTAINS') continue;
				items.push(new EdgeItem(edge, 'outgoing', target));
			}
			for (const { edge, source } of data.incoming) {
				if (edge.kind === 'CONTAINS') continue;
				items.push(new EdgeItem(edge, 'incoming', source));
			}
			return items;
		}

		return [];
	}
}

export class BlastRadiusTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null> = this._onDidChange.event;

	private changedNodes: StoredNode[] = [];
	private impactedNodes: StoredNode[] = [];

	setResults(changed: StoredNode[], impacted: StoredNode[]): void {
		this.changedNodes = changed;
		this.impactedNodes = impacted;
		this._onDidChange.fire(undefined);
	}

	clear(): void {
		this.changedNodes = [];
		this.impactedNodes = [];
		this._onDidChange.fire(undefined);
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
		if (!element) {
			if (this.changedNodes.length === 0 && this.impactedNodes.length === 0) return [];
			const groups: vscode.TreeItem[] = [];
			if (this.changedNodes.length > 0) groups.push(new GroupItem('changed', this.changedNodes.length));
			if (this.impactedNodes.length > 0) groups.push(new GroupItem('impacted', this.impactedNodes.length));
			return groups;
		}

		if (element instanceof GroupItem) {
			const nodes = element.groupKind === 'changed' ? this.changedNodes : this.impactedNodes;
			return nodes.map(n => new SymbolItem(n));
		}

		return [];
	}
}

const ONE_HOUR_MS = 3_600_000;

export class CompassStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this.item.command = 'damocles.compass.rebuild';
	}

	update(status: IndexStatus): void {
		if (status.state !== 'ready') {
			this.item.text = `$(warning) Compass: ${status.state === 'indexing' ? 'Indexing…' : 'Not built'}`;
			this.item.tooltip = status.state === 'error' ? `Error: ${status.error}` : 'Click to build';
			return;
		}

		const lastIndexedAt = status.lastIndexedAt;
		const outdated = !lastIndexedAt || (Date.now() - lastIndexedAt > ONE_HOUR_MS);

		if (outdated) {
			this.item.text = '$(warning) Compass: Outdated';
			this.item.tooltip = `Compass: ${status.fileCount} files, ${status.edgeCount} edges`;
		} else {
			this.item.text = `$(database) ${status.nodeCount} nodes`;
			this.item.tooltip = `Compass: ${status.fileCount} files, ${status.edgeCount} edges`;
		}
	}

	show(): void { this.item.show(); }
	hide(): void { this.item.hide(); }
	dispose(): void { this.item.dispose(); }
}

export function registerBlastRadiusCommand(
	context: vscode.ExtensionContext,
	compassService: CompassService,
	blastRadiusProvider: BlastRadiusTreeProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('damocles.compass.showBlastRadius', async () => {
			const status = compassService.getStatus();
			if (status.state !== 'ready') {
				vscode.window.showWarningMessage('Compass: No graph database loaded.');
				return;
			}

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage('Open a file first');
				return;
			}

			const filePath = editor.document.uri.fsPath;
			const depth = vscode.workspace.getConfiguration('damocles.compass').get<number>('blastRadiusDepth', 2);
			const impact = await compassService.webviewBlastRadius(filePath, depth) as {
				changed_nodes: StoredNode[];
				impacted_nodes: StoredNode[];
				impacted_files: string[];
			};

			blastRadiusProvider.setResults(impact.changed_nodes, impact.impacted_nodes);
			vscode.commands.executeCommand('damocles.compass.blastRadius.focus');

			const impactedFileCount = new Set(impact.impacted_nodes.map(n => n.file_path)).size;
			vscode.window.showInformationMessage(
				`Blast radius: ${impact.impacted_nodes.length} nodes across ${impactedFileCount} files`,
			);
		}),
	);
}
