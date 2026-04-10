import * as vscode from 'vscode';
import * as path from 'path';
import type { GraphStore } from './database';
import type { StoredNode, StoredEdge } from './types';
import { computeBlastRadius } from './impact';

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
	constructor(edge: StoredEdge, direction: 'outgoing' | 'incoming', targetNode: StoredNode | undefined) {
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
	private readonly getStore: () => GraphStore | undefined;
	private readonly workspaceRoot: string;

	constructor(getStore: () => GraphStore | undefined, workspaceRoot: string) {
		this.getStore = getStore;
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

	getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
		const store = this.getStore();
		if (!store?.isOpen) return [];

		if (!element) {
			return store.getAllFiles()
				.sort((a, b) => a.localeCompare(b))
				.map(f => new FileItem(f, this.workspaceRoot));
		}

		if (element instanceof FileItem) {
			return store.getNodesByFile(element.filePath)
				.filter(n => n.kind !== 'File')
				.sort((a, b) => a.line_start - b.line_start)
				.map(n => new SymbolItem(n));
		}

		if (element instanceof SymbolItem) {
			const items: vscode.TreeItem[] = [];
			for (const e of store.getEdgesBySource(element.qualifiedName)) {
				if (e.kind === 'CONTAINS') continue;
				items.push(new EdgeItem(e, 'outgoing', store.getNode(e.target_qualified)));
			}
			for (const e of store.getEdgesByTarget(element.qualifiedName)) {
				if (e.kind === 'CONTAINS') continue;
				items.push(new EdgeItem(e, 'incoming', store.getNode(e.source_qualified)));
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

	update(store: GraphStore | undefined): void {
		if (!store?.isOpen) {
			this.item.text = '$(warning) Compass: Not built';
			this.item.tooltip = 'Click to build';
			return;
		}

		const stats = store.getStats();
		const lastUpdated = stats.last_updated;
		const outdated = !lastUpdated || isNaN(new Date(lastUpdated).getTime()) || (Date.now() - new Date(lastUpdated).getTime() > ONE_HOUR_MS);

		if (outdated) {
			this.item.text = '$(warning) Compass: Outdated';
			this.item.tooltip = `Compass: ${stats.files_count} files, ${stats.total_edges} edges\nLast updated: ${lastUpdated ?? 'unknown'}`;
		} else {
			this.item.text = `$(database) ${stats.total_nodes} nodes`;
			this.item.tooltip = `Compass: ${stats.files_count} files, ${stats.total_edges} edges\nLast updated: ${lastUpdated}`;
		}
	}

	show(): void { this.item.show(); }
	hide(): void { this.item.hide(); }
	dispose(): void { this.item.dispose(); }
}

export function registerBlastRadiusCommand(
	context: vscode.ExtensionContext,
	getStore: () => GraphStore | undefined,
	blastRadiusProvider: BlastRadiusTreeProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('damocles.compass.showBlastRadius', () => {
			const store = getStore();
			if (!store?.isOpen) {
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
			const impact = computeBlastRadius(store, [filePath], depth);

			blastRadiusProvider.setResults(impact.changed_nodes, impact.impacted_nodes);
			vscode.commands.executeCommand('damocles.compass.blastRadius.focus');

			const impactedFileCount = new Set(impact.impacted_nodes.map(n => n.file_path)).size;
			vscode.window.showInformationMessage(
				`Blast radius: ${impact.impacted_nodes.length} nodes across ${impactedFileCount} files`,
			);
		}),
	);
}
