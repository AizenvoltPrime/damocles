const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/g;
const MAX_LABEL_LEN = 256;

export function sanitizeLabel(text: string): string {
	let cleaned = text.replace(CONTROL_CHAR_RE, '').trim();
	if (cleaned.length > MAX_LABEL_LEN) {
		cleaned = cleaned.slice(0, MAX_LABEL_LEN);
	}
	return cleaned;
}
