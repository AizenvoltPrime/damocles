declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void): void;
declare function setup(fn: () => void): void;
declare function teardown(fn: () => void): void;

suite('AuthService', () => {
	let counter = 0;

	setup(() => {
		counter = 0;
	});

	teardown(() => {
		counter = -1;
	});

	test('increments on login', () => {
		counter += 1;
		if (counter !== 1) throw new Error('expected 1');
	});

	test('resets on logout', () => {
		counter = 0;
		if (counter !== 0) throw new Error('expected 0');
	});
});
