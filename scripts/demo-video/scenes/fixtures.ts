export const AUTH_PATH = 'c:/dev/acme-api/src/routes/auth.ts';

export const AUTH_TS = `import { Router } from 'express';
import { z } from 'zod';
import { sessions } from '../sessions';
import { verifyPassword } from '../crypto';

const router = Router();

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(8) });

router.post('/login', async (req, res) => {
  const body = LoginBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body' });
  const user = await verifyPassword(body.data.email, body.data.password);
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });
  res.cookie('sid', await sessions.create(user.id), { httpOnly: true, sameSite: 'lax' });
  res.status(204).end();
});

export default router;
`;

export const EDIT_OLD = `import { verifyPassword } from '../crypto';

const router = Router();

const LoginBody`;

export const EDIT_NEW = `import { verifyPassword } from '../crypto';
import { rateLimit } from 'express-rate-limit';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  message: { error: 'too_many_attempts' },
});

const LoginBody`;

export const EDIT2_OLD = `router.post('/login', async (req, res) => {`;
export const EDIT2_NEW = `router.post('/login', loginLimiter, async (req, res) => {`;

export const TEST_FRAMES = [
  '> acme-api@2.4.0 test\n> vitest run\n',
  '> acme-api@2.4.0 test\n> vitest run\n\n RUN  v4.1.1 c:/dev/acme-api\n',
  '> acme-api@2.4.0 test\n> vitest run\n\n RUN  v4.1.1 c:/dev/acme-api\n\n ✓ test/sessions.test.ts (9 tests) 41ms\n',
  '> acme-api@2.4.0 test\n> vitest run\n\n RUN  v4.1.1 c:/dev/acme-api\n\n ✓ test/sessions.test.ts (9 tests) 41ms\n ✓ test/users.test.ts (14 tests) 63ms\n',
  '> acme-api@2.4.0 test\n> vitest run\n\n RUN  v4.1.1 c:/dev/acme-api\n\n ✓ test/sessions.test.ts (9 tests) 41ms\n ✓ test/users.test.ts (14 tests) 63ms\n ✓ test/auth.test.ts (12 tests) 118ms\n   ✓ login > returns 429 after 10 failed attempts\n',
  '> acme-api@2.4.0 test\n> vitest run\n\n RUN  v4.1.1 c:/dev/acme-api\n\n ✓ test/sessions.test.ts (9 tests) 41ms\n ✓ test/users.test.ts (14 tests) 63ms\n ✓ test/auth.test.ts (12 tests) 118ms\n   ✓ login > returns 429 after 10 failed attempts\n\n Test Files  3 passed (3)\n      Tests  35 passed (35)\n   Duration  1.42s\n',
];
