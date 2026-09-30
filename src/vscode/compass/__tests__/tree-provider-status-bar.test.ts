import { describe, it, expect, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { CompassStatusBar } from '../tree-provider';

describe('CompassStatusBar failed state', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('surfaces the terminal failed state with a rebuild hint', () => {
		const item = { text: '', tooltip: '', command: '', show: vi.fn(), hide: vi.fn(), dispose: vi.fn() };
		vi.spyOn(vscode.window, 'createStatusBarItem').mockReturnValue(item as unknown as ReturnType<typeof vscode.window.createStatusBarItem>);

		const bar = new CompassStatusBar();
		bar.update({ state: 'failed', fileCount: 0, nodeCount: 0, edgeCount: 0, communityCount: 0, flowCount: 0, lastIndexedAt: null, error: 'boom' });

		expect(item.text).toContain('Failed');
		expect(item.tooltip).toContain('Compass failed — run Rebuild to retry');
		expect(item.tooltip).toContain('boom');
		expect(item.command).toBe('damocles.compass.rebuild');
	});
});
