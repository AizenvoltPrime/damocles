import { describe, it, expect } from 'vitest';
import { isSensitive } from '../detect';

describe('isSensitive — credential-name filter scope', () => {
	it('does NOT flag source-code files that happen to contain credential keywords', () => {
		expect(isSensitive('c:/proj/resources/ts/Components/PasswordInput.vue')).toBe(false);
		expect(isSensitive('c:/proj/resources/ts/Pages/User/PasswordForm.vue')).toBe(false);
		expect(isSensitive('c:/proj/app/Http/Controllers/Auth/UpdatePasswordController.php')).toBe(false);
		expect(isSensitive('c:/proj/src/auth/credentialProvider.ts')).toBe(false);
		expect(isSensitive('c:/proj/src/secrets.py')).toBe(false);
		expect(isSensitive('c:/proj/src/SecretManager.java')).toBe(false);
		expect(isSensitive('c:/proj/src/PrivateKeyInput.tsx')).toBe(false);
	});

	it('still flags credential-bearing data/config files', () => {
		expect(isSensitive('c:/proj/passwords.json')).toBe(true);
		expect(isSensitive('c:/proj/secrets.yaml')).toBe(true);
		expect(isSensitive('c:/proj/credentials.yml')).toBe(true);
		expect(isSensitive('c:/proj/aws_credentials.ini')).toBe(true);
		expect(isSensitive('c:/proj/service.account.json')).toBe(true);
	});

	it('flags dotfile and PEM/key files regardless of extension', () => {
		expect(isSensitive('c:/proj/.env')).toBe(true);
		expect(isSensitive('c:/proj/.env.local')).toBe(true);
		expect(isSensitive('c:/proj/.envrc')).toBe(true);
		expect(isSensitive('c:/proj/server.pem')).toBe(true);
		expect(isSensitive('c:/proj/private.key')).toBe(true);
		expect(isSensitive('c:/proj/client.pfx')).toBe(true);
		expect(isSensitive('c:/home/user/.ssh/id_rsa')).toBe(true);
		expect(isSensitive('c:/home/user/.ssh/id_ed25519')).toBe(true);
		expect(isSensitive('c:/home/user/.netrc')).toBe(true);
	});

	it('does not flag unrelated source files', () => {
		expect(isSensitive('c:/proj/src/app.ts')).toBe(false);
		expect(isSensitive('c:/proj/src/index.vue')).toBe(false);
		expect(isSensitive('c:/proj/README.md')).toBe(false);
	});
});
