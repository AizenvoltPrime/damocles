const PHP_EXTERNAL_PATTERNS: RegExp[] = [
	/^Random\\/,
	/^Illuminate\\/,
	/^Carbon\\/,
	/^League\\/,
	/^Symfony\\/,
	/^Laravel\\/,
	/^Doctrine\\/,
	/^Monolog\\/,
	/^Ramsey\\/,
	/^Psr\\/,
	/^GuzzleHttp\\/,
	/^Faker\\/,
	/^PHPUnit\\/,
	/^Mockery\\/,
	/^React\\/,
	/^Nette\\/,
	/^Predis\\/,
	/^Firebase\\/,
	/^Spatie\\/,
	/^Inertia\\/,
	/^Tightenco\\/,
	/^Livewire\\/,
	/^Barryvdh\\/,
	/^Maatwebsite\\/,
	/^Nyholm\\/,
	/^Opcodes\\/,
	/^Ratchet\\/,
	/^Filament\\/,
	/^Intervention\\/,
	/^Twilio\\/,
	/^Kreait\\/,
	/^Pusher\\/,
	/^Google\\/,
	/^Aws\\/,
	/^Stripe\\/,
	/^Sentry\\/,
	/^Stevebauman\\/,
	/^Webpatser\\/,
];

const PHP_BUILTIN_TYPES = new Set([
	'Exception', 'RuntimeException', 'InvalidArgumentException', 'LogicException',
	'TypeError', 'ValueError', 'Error', 'stdClass', 'Closure', 'Generator',
	'Throwable', 'Stringable', 'JsonSerializable', 'ArrayAccess', 'Countable',
	'Iterator', 'Serializable', 'Traversable',
	'BadMethodCallException', 'DomainException', 'OverflowException',
	'UnexpectedValueException', 'LengthException', 'OutOfRangeException',
	'RangeException', 'BadFunctionCallException', 'UnderflowException',
	'OutOfBoundsException', 'ArithmeticError', 'DivisionByZeroError',
	'IteratorAggregate', 'SplObserver', 'SplSubject',
	'SplHeap', 'SplStack', 'SplQueue', 'SplPriorityQueue',
	'SplFixedArray', 'SplObjectStorage', 'SplFileInfo', 'SplFileObject',
	'PDO', 'PDOStatement', 'PDOException',
	'DateTime', 'DateTimeImmutable', 'DateTimeInterface', 'DateInterval', 'DateTimeZone',
	'BackedEnum', 'UnitEnum',
	'ReflectionClass', 'ReflectionMethod', 'ReflectionProperty', 'ReflectionFunction',
	'ReflectionParameter', 'ReflectionType', 'ReflectionNamedType', 'ReflectionException',
	'CurlHandle', 'CurlMultiHandle',
]);

const TS_BUILTIN_TYPES = new Set([
	'Omit', 'Partial', 'Pick', 'Record', 'Exclude', 'Extract', 'Required', 'Readonly',
	'ReturnType', 'Parameters', 'InstanceType', 'NonNullable', 'Awaited',
	'ConstructorParameters', 'ThisParameterType', 'OmitThisParameter', 'ThisType',
	'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize',
	'Promise', 'PromiseLike', 'Array', 'ArrayLike', 'Map', 'Set', 'WeakMap', 'WeakSet',
	'RegExp', 'Date', 'Error', 'Buffer', 'Symbol', 'BigInt',
	'Iterable', 'AsyncIterable', 'Iterator', 'AsyncIterator',
	'Generator', 'AsyncGenerator',
	'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLButtonElement',
	'HTMLFormElement', 'HTMLImageElement', 'HTMLAnchorElement', 'HTMLSelectElement',
	'HTMLTextAreaElement', 'HTMLCanvasElement', 'HTMLVideoElement', 'HTMLAudioElement',
	'HTMLSpanElement', 'SVGElement', 'SVGSVGElement',
	'Element', 'Event', 'Document', 'Node', 'EventTarget', 'NodeList', 'HTMLCollection',
	'Window', 'Navigator', 'Location', 'History', 'Storage',
	'CSSStyleDeclaration', 'DOMRect', 'DOMRectReadOnly', 'DOMTokenList',
	'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'PerformanceObserver',
	'MutationRecord', 'IntersectionObserverEntry', 'ResizeObserverEntry',
	'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'InputEvent', 'TouchEvent',
	'DragEvent', 'PointerEvent', 'WheelEvent', 'AnimationEvent', 'TransitionEvent',
	'ClipboardEvent', 'CustomEvent', 'MessageEvent', 'UIEvent', 'CompositionEvent',
	'SubmitEvent', 'ProgressEvent', 'PopStateEvent', 'StorageEvent',
	'Response', 'Request', 'Headers', 'URL', 'URLSearchParams',
	'AbortController', 'AbortSignal',
	'FormData', 'Blob', 'FileReader', 'FileList',
	'ReadableStream', 'WritableStream', 'TransformStream',
	'TextEncoder', 'TextDecoder',
	'WebSocket', 'XMLHttpRequest',
	'Worker', 'SharedWorker', 'ServiceWorker',
	'MediaStream', 'MediaRecorder',
	'CanvasRenderingContext2D', 'WebGLRenderingContext', 'WebGL2RenderingContext',
	'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
	'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
	'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
	'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
	'NodeJS',
]);

const NODE_BUILTINS = new Set([
	'fs', 'fs/promises', 'path', 'os', 'util', 'crypto', 'http', 'https', 'net',
	'child_process', 'stream', 'events', 'querystring', 'url',
	'zlib', 'buffer', 'readline', 'worker_threads', 'vm', 'tty',
	'cluster', 'dns', 'dgram', 'tls', 'module', 'perf_hooks',
	'async_hooks', 'constants', 'punycode', 'string_decoder',
	'timers', 'timers/promises', 'assert', 'assert/strict', 'console', 'v8', 'repl',
	'process', 'inspector', 'diagnostics_channel', 'trace_events',
]);

const EDITOR_EXTERNALS = new Set(['vscode', 'electron']);

const RUST_STDLIB_PREFIXES = ['std::', 'core::', 'alloc::', 'proc_macro::', 'test::'];

function isRustStdlibPath(target: string): boolean {
	return RUST_STDLIB_PREFIXES.some(p => target.startsWith(p));
}

const ASSET_EXTENSIONS = new Set([
	'.css', '.scss', '.sass', '.less', '.styl', '.pcss', '.postcss',
	'.json', '.yaml', '.yml', '.toml',
	'.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
	'.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.flac',
	'.ttf', '.woff', '.woff2', '.otf', '.eot',
	'.wasm', '.md', '.txt', '.pdf', '.glb', '.gltf',
]);

function isAssetImport(target: string): boolean {
	const lastDot = target.lastIndexOf('.');
	if (lastDot < 0) return false;
	const ext = target.slice(lastDot).toLowerCase();
	const qIdx = ext.indexOf('?');
	const cleanExt = qIdx >= 0 ? ext.slice(0, qIdx) : ext;
	return ASSET_EXTENSIONS.has(cleanExt);
}

function isBareModuleSpec(target: string): boolean {
	if (!target) return false;
	if (target.startsWith('.') || target.startsWith('/') || target.startsWith('\\')) return false;
	if (target.startsWith('@')) {
		return /^@[^/\\]+[/\\][^/\\]+/.test(target);
	}
	if (/[/\\]/.test(target)) {
		const firstSegment = target.split(/[/\\]/)[0] ?? '';
		return /^[a-z][a-z0-9._-]*$/.test(firstSegment);
	}
	return !target.includes(':') || target.startsWith('node:');
}

export function isKnownExternal(target: string): boolean {
	if (PHP_EXTERNAL_PATTERNS.some(p => p.test(target))) return true;
	if (PHP_BUILTIN_TYPES.has(target)) return true;
	if (TS_BUILTIN_TYPES.has(target)) return true;
	if (target.startsWith('node_modules/') || target.startsWith('node_modules\\')) return true;
	if (target.startsWith('vendor/') || target.startsWith('vendor\\')) return true;
	if (/[/\\]node_modules[/\\]/.test(target) || /[/\\]vendor[/\\]/.test(target)) return true;
	if (target.startsWith('node:')) return true;
	if (NODE_BUILTINS.has(target)) return true;
	if (EDITOR_EXTERNALS.has(target)) return true;
	if (isRustStdlibPath(target)) return true;
	if (isAssetImport(target)) return true;
	if (isBareModuleSpec(target)) return true;
	return false;
}
