import os from 'node:os';
import path from 'node:path';

export const TOKEN_HEADER = 'x-smoke-token';

/** Profile, screenshots and the controller's token live here; SMOKE_DIR overrides it. */
export const smokeDir = () => path.resolve(process.env.SMOKE_DIR ?? path.join(os.tmpdir(), 'damocles-smoke'));

export const smokePort = () => Number(process.env.SMOKE_PORT ?? 9555);

export const tokenFile = (dir) => path.join(dir, 'controller.token');
