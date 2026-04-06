export type CompassIndexState = 'idle' | 'indexing' | 'ready' | 'error';

export interface CompassIndexStatus {
	state: CompassIndexState;
	fileCount: number;
	nodeCount: number;
	edgeCount: number;
	communityCount: number;
	lastIndexedAt: number | null;
	error?: string;
}
