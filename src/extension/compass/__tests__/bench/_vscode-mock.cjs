module.exports = {
	window: {
		createOutputChannel: () => ({
			appendLine: () => {},
			show: () => {},
			dispose: () => {},
		}),
		showInformationMessage: () => Promise.resolve(undefined),
		showErrorMessage: () => Promise.resolve(undefined),
		showWarningMessage: () => Promise.resolve(undefined),
	},
	workspace: {
		getConfiguration: () => ({
			get: () => undefined,
			update: () => Promise.resolve(),
		}),
		workspaceFolders: [],
		onDidChangeConfiguration: () => ({ dispose: () => {} }),
	},
	Uri: {
		file: (p) => ({ fsPath: p, path: p, scheme: 'file' }),
	},
	EventEmitter: class {
		event() { return { dispose: () => {} }; }
		fire() {}
		dispose() {}
	},
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	commands: {
		registerCommand: () => ({ dispose: () => {} }),
		executeCommand: () => Promise.resolve(undefined),
	},
};
