import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { CompassViews } from '../compass-views';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';

let views: CompassViews | null;
let fake: FakePlatform;

beforeEach(() => {
	views = null;
	fake = createFakePlatform({
		settings: { user: { 'damocles.compass.enabled': true } },
		folders: [{ fsPath: '/ws', name: '/ws' }],
	});
});

afterEach(() => {
	views?.dispose();
	vi.restoreAllMocks();
});

describe('CompassViews workspace trust', () => {
	it('registers no views, status bar, or commands in an untrusted workspace', () => {
		fake.trust.setTrusted(false);
		const createTree = vi.spyOn(vscode.window, 'createTreeView');
		const registerCommand = vi.spyOn(vscode.commands, 'registerCommand');
		const createStatusBar = vi.spyOn(vscode.window, 'createStatusBarItem');

		views = new CompassViews(fake, { viewsFolder: () => '/ws' });
		views.register();

		expect(createTree).not.toHaveBeenCalled();
		expect(registerCommand).not.toHaveBeenCalled();
		expect(createStatusBar).not.toHaveBeenCalled();
	});

	it('registers the views deferred by the untrusted start when trust is granted', () => {
		fake.trust.setTrusted(false);
		views = new CompassViews(fake, { viewsFolder: () => '/ws' });
		views.register();

		const registerCommand = vi.spyOn(vscode.commands, 'registerCommand');
		fake.trust.grantTrust();

		expect(registerCommand.mock.calls.map(c => c[0])).toContain('damocles.compass.rebuild');
	});

	it('registers the views once when trust is granted after a trusted start', () => {
		const registerCommand = vi.spyOn(vscode.commands, 'registerCommand');
		views = new CompassViews(fake, { viewsFolder: () => '/ws' });
		views.register();
		const afterFirst = registerCommand.mock.calls.length;
		expect(afterFirst).toBeGreaterThan(0);

		fake.trust.grantTrust();

		expect(registerCommand.mock.calls).toHaveLength(afterFirst);
	});
});
