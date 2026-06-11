export function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

export function isWithinRoot(resolvedPath: string, rootReal: string): boolean {
	const isWindows = process.platform === 'win32';
	let normalized = resolvedPath.replace(/\\/g, '/');
	let rootNorm = rootReal.replace(/\\/g, '/');
	if (isWindows) {
		normalized = normalized.toLowerCase();
		rootNorm = rootNorm.toLowerCase();
	}
	return normalized.startsWith(rootNorm + '/') || normalized === rootNorm;
}

export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const effectiveLimit = Math.min(Math.max(1, limit | 0), items.length);
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await fn(items[i]!, i);
		}
	};
	const workers: Promise<void>[] = [];
	for (let w = 0; w < effectiveLimit; w++) workers.push(worker());
	await Promise.all(workers);
	return results;
}
