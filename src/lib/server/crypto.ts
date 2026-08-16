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
		throw new Error(
			`ABACUS_ENCRYPTION_KEY must decode to 32 bytes, got ${raw.length}. ` +
				`Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`
		);
	}
	cachedKey = raw;
	return raw;
}

/**
 * Fails loudly if the key is absent or the wrong length.
 *
 * Called at startup, and again before exchanging a Plaid public token. Without
 * it the key is first exercised when storing an access token — which happens
 * immediately *after* the exchange has consumed one of ten lifetime Item slots,
 * so a mistyped key costs a slot and strands a token that can never be
 * recovered. A bad key must stop the process, not the link.
 */
export function assertEncryptionKeyUsable(): void {
	key();
}

const KEY_CHECK = 'crypto.key_check';
const KEY_CHECK_AAD = 'keycheck';
const KEY_CHECK_PLAINTEXT = 'abacus';

/**
 * Proves the configured key is the one this database was encrypted with.
 *
 * Length alone is not enough: any other 32-byte value passes `key()` while
 * leaving every stored access token undecryptable. That failure would surface
 * as institutions mysteriously breaking, and the natural response — relink
 * them — spends Item slots that are never returned. Catching it at boot turns
 * a silent, expensive failure into a refusal to start.
 *
 * The check value is written on first boot, so an existing deployment adopts
 * whatever key it is already using.
 */
export function assertEncryptionKeyMatchesDatabase(
	read: (k: string) => string | null,
	write: (k: string, v: string) => void
): void {
	const stored = read(KEY_CHECK);
	if (!stored) {
		write(KEY_CHECK, encrypt(KEY_CHECK_PLAINTEXT, KEY_CHECK_AAD));
		return;
	}

	let decrypted: string;
	try {
		decrypted = decrypt(stored, KEY_CHECK_AAD);
	} catch {
		throw new Error(
			'ABACUS_ENCRYPTION_KEY does not match the key this database was created with. ' +
				'Restore the original key — relinking institutions would consume Plaid Item slots permanently.'
		);
	}
	if (decrypted !== KEY_CHECK_PLAINTEXT) {
		throw new Error('ABACUS_ENCRYPTION_KEY failed its verification check.');
	}
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
