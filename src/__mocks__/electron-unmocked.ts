// The desktop project resolves `electron` here. Outside Electron the real package downloads its binary on require, so a
// suite that forgot to mock it would pass or fail on the network.
throw new Error("A desktop test loaded electron without mocking it: add vi.mock('electron', ...) to the suite.");
