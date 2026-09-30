export class GapWidget {
	render(): number {
		return 1;
	}
}

declare const ns: { Service: new () => object };
declare const Registry: { lookup(n: number): number };

export function buildAll(): GapWidget {
	const widget = new GapWidget();
	const svc = new ns.Service();
	void svc;
	widget.render();
	Registry.lookup(1);
	return widget;
}
