import { describe, it, expect } from 'vitest';
import { sanitizeLabel } from '../sanitize';

describe('sanitizeLabel', () => {
	it('preserves angle brackets in plain text output', () => {
		expect(sanitizeLabel('<script>alert("xss")</script>')).toContain('<script>');
		expect(sanitizeLabel('<script>alert("xss")</script>')).toContain('</script>');
	});

	it('strips control characters', () => {
		expect(sanitizeLabel('hello\x00world')).toBe('helloworld');
		expect(sanitizeLabel('tab\there')).toBe('tabhere');
	});

	it('caps at 256 characters', () => {
		const long = 'a'.repeat(300);
		expect(sanitizeLabel(long).length).toBe(256);
	});

	it('handles normal labels unchanged', () => {
		expect(sanitizeLabel('MyClass')).toBe('MyClass');
		expect(sanitizeLabel('foo_bar')).toBe('foo_bar');
	});
});
