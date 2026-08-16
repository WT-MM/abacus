import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

/**
 * crypto.ts caches the decoded key at module scope, so each case needs the
 * module re-evaluated. resetModules clears vitest's registry; a variable
 * dynamic import cannot be used here because Vite resolves those statically.
 */
async function loadWith(key: string | undefined) {
	process.env.ABACUS_ENV_FILE = '/nonexistent';
	if (key === undefined) delete process.env.ABACUS_ENCRYPTION_KEY;
	else process.env.ABACUS_ENCRYPTION_KEY = key;
	vi.resetModules();
	return import('./crypto.ts');
}

/** Stand-in for the meta table. */
function store() {
	const rows = new Map<string, string>();
	return {
		read: (k: string) => rows.get(k) ?? null,
		write: (k: string, v: string) => void rows.set(k, v),
		rows
	};
}

beforeEach(() => {
	delete process.env.ABACUS_ENCRYPTION_KEY;
});

describe('encrypt / decrypt', () => {
	it('round-trips a value', async () => {
		const { encrypt, decrypt } = await loadWith(KEY_A);
		expect(decrypt(encrypt('access-production-abc', 'purpose'), 'purpose')).toBe('access-production-abc');
	});

	it('produces a different ciphertext each time', async () => {
		const { encrypt } = await loadWith(KEY_A);
		expect(encrypt('same', 'p')).not.toBe(encrypt('same', 'p'));
	});

	it('refuses a ciphertext lifted into another purpose', async () => {
		const { encrypt, decrypt } = await loadWith(KEY_A);
		const ct = encrypt('secret', 'plaid.access_token');
		expect(() => decrypt(ct, 'keycheck')).toThrow();
	});

	it('refuses a tampered ciphertext', async () => {
		const { encrypt, decrypt } = await loadWith(KEY_A);
		const [v, iv, tag, body] = encrypt('secret', 'p').split(':');
		const flipped = Buffer.from(body, 'base64');
		flipped[0] ^= 0xff;
		expect(() => decrypt([v, iv, tag, flipped.toString('base64')].join(':'), 'p')).toThrow();
	});
});

describe('assertEncryptionKeyUsable', () => {
	it('rejects a missing key', async () => {
		const { assertEncryptionKeyUsable } = await loadWith(undefined);
		expect(() => assertEncryptionKeyUsable()).toThrow(/Missing required environment variable/);
	});

	it('rejects a key of the wrong length', async () => {
		const { assertEncryptionKeyUsable } = await loadWith(Buffer.from('short').toString('base64'));
		expect(() => assertEncryptionKeyUsable()).toThrow(/must decode to 32 bytes/);
	});

	it('accepts a well-formed key', async () => {
		const { assertEncryptionKeyUsable } = await loadWith(KEY_A);
		expect(() => assertEncryptionKeyUsable()).not.toThrow();
	});
});

describe('assertEncryptionKeyMatchesDatabase', () => {
	it('writes a check value on first boot', async () => {
		const { assertEncryptionKeyMatchesDatabase } = await loadWith(KEY_A);
		const s = store();
		assertEncryptionKeyMatchesDatabase(s.read, s.write);
		expect(s.rows.has('crypto.key_check')).toBe(true);
	});

	it('accepts the same key on later boots', async () => {
		const { assertEncryptionKeyMatchesDatabase } = await loadWith(KEY_A);
		const s = store();
		assertEncryptionKeyMatchesDatabase(s.read, s.write);
		expect(() => assertEncryptionKeyMatchesDatabase(s.read, s.write)).not.toThrow();
	});

	// The case length validation cannot see: a different key of the correct
	// shape leaves every stored access token undecryptable.
	it('rejects a different key of the correct length', async () => {
		const first = await loadWith(KEY_A);
		const s = store();
		first.assertEncryptionKeyMatchesDatabase(s.read, s.write);

		const second = await loadWith(KEY_B);
		expect(() => second.assertEncryptionKeyMatchesDatabase(s.read, s.write)).toThrow(
			/does not match the key this database was created with/
		);
	});

	it('rejects a corrupted check value', async () => {
		const { assertEncryptionKeyMatchesDatabase } = await loadWith(KEY_A);
		const s = store();
		s.write('crypto.key_check', 'v1:AAAA:AAAA:AAAA');
		expect(() => assertEncryptionKeyMatchesDatabase(s.read, s.write)).toThrow();
	});
});

describe('redact', () => {
	it.each([
		['access-production-0123abcd-dead-beef', 'access-***'],
		['link-sandbox-0123abcd-dead-beef', 'link-***']
	])('strips %s', async (input, expected) => {
		const { redact } = await loadWith(KEY_A);
		expect(redact(`token was ${input} here`)).toBe(`token was ${expected} here`);
	});

	it('strips long hex runs', async () => {
		const { redact } = await loadWith(KEY_A);
		expect(redact('id 0123456789abcdef0123456789abcdef')).toBe('id ***');
	});
});
