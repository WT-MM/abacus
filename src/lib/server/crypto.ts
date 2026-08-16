import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

// Ciphertext is versioned so the key can be rotated without guessing at the
// format of rows written by an older build.
const VERSION = 'v1';

let cachedKey: Buffer | null = null;

function key(): Buffer {
	if (cachedKey) return cachedKey;
	const raw = Buffer.from(config.encryptionKey(), 'base64');
	if (raw.length !== 32) {
		throw new Error('ABACUS_ENCRYPTION_KEY must be 32 bytes, base64-encoded (see `just keygen`)');
	}
	cachedKey = raw;
	return raw;
}

/**
 * AES-256-GCM with a fresh nonce per call. `purpose` is bound in as additional
 * authenticated data, so a ciphertext lifted out of one column cannot be
 * replayed into another.
 */
export function encrypt(plaintext: string, purpose: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	cipher.setAAD(Buffer.from(purpose, 'utf8'));
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(payload: string, purpose: string): string {
	const [version, ivB64, tagB64, ctB64] = payload.split(':');
	if (version !== VERSION) throw new Error(`Unsupported ciphertext version ${version}`);
	const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
	decipher.setAAD(Buffer.from(purpose, 'utf8'));
	decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
	return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function sha256(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * Secrets must never reach the journal. Sync errors get run through this before
 * they are persisted or logged.
 */
export function redact(text: string): string {
	return text
		.replace(/access-(sandbox|production)-[a-z0-9-]+/gi, 'access-***')
		.replace(/link-(sandbox|production)-[a-z0-9-]+/gi, 'link-***')
		.replace(/\b[0-9a-f]{24,}\b/gi, '***');
}
