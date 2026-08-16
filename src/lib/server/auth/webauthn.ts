import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse
} from '@simplewebauthn/server';
import type {
	RegistrationResponseJSON,
	AuthenticationResponseJSON,
	AuthenticatorTransportFuture
} from '@simplewebauthn/server';
import { db } from '../db.ts';
import { config, rpID } from '../config.ts';
import { randomToken } from '../crypto.ts';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

type CredentialRow = {
	id: string;
	owner: string;
	public_key: Uint8Array;
	counter: number;
	transports: string | null;
	device_name: string | null;
	created_at: string;
	last_used_at: string | null;
};

export function credentialsFor(owner: string): CredentialRow[] {
	return db().prepare('SELECT * FROM credentials WHERE owner = ? ORDER BY created_at').all(owner) as CredentialRow[];
}

export function credentialCount(): number {
	return (db().prepare('SELECT COUNT(*) AS n FROM credentials').get() as { n: number }).n;
}

/** Challenges are single-use and expire, so a captured one cannot be replayed. */
function storeChallenge(owner: string, challenge: string, kind: 'register' | 'authenticate'): string {
	const id = randomToken(16);
	db()
		.prepare('INSERT INTO challenges (id, owner, challenge, kind, expires_at) VALUES (?, ?, ?, ?, ?)')
		.run(id, owner, challenge, kind, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString());
	return id;
}

function takeChallenge(id: string, owner: string, kind: string): string {
	const row = db().prepare('SELECT * FROM challenges WHERE id = ?').get(id) as
		| { owner: string; challenge: string; kind: string; expires_at: string }
		| undefined;
	db().prepare('DELETE FROM challenges WHERE id = ?').run(id);

	if (!row) throw new Error('Challenge not found or already used');
	if (row.owner !== owner || row.kind !== kind) throw new Error('Challenge does not match this request');
	if (Date.parse(row.expires_at) < Date.now()) throw new Error('Challenge expired');
	return row.challenge;
}

const transportsOf = (row: CredentialRow) =>
	(row.transports ? (JSON.parse(row.transports) as AuthenticatorTransportFuture[]) : undefined);

export async function startRegistration(owner: string) {
	const existing = credentialsFor(owner);
	const options = await generateRegistrationOptions({
		rpName: 'Abacus',
		rpID: rpID(),
		userName: owner,
		userDisplayName: owner,
		attestationType: 'none',
		// Prevents registering the same authenticator twice as separate keys.
		excludeCredentials: existing.map((c) => ({ id: c.id, transports: transportsOf(c) })),
		authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }
	});
	return { options, challengeId: storeChallenge(owner, options.challenge, 'register') };
}

export async function finishRegistration(
	owner: string,
	challengeId: string,
	response: RegistrationResponseJSON,
	deviceName: string
): Promise<void> {
	const expectedChallenge = takeChallenge(challengeId, owner, 'register');

	const verification = await verifyRegistrationResponse({
		response,
		expectedChallenge,
		expectedOrigin: config.origin,
		expectedRPID: rpID(),
		requireUserVerification: true
	});

	if (!verification.verified || !verification.registrationInfo) {
		throw new Error('Passkey registration could not be verified');
	}

	const { credential } = verification.registrationInfo;
	db()
		.prepare(
			`INSERT INTO credentials (id, owner, public_key, counter, transports, device_name)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(
			credential.id,
			owner,
			credential.publicKey,
			credential.counter,
			JSON.stringify(credential.transports ?? []),
			deviceName || 'Passkey'
		);
}

export async function startAuthentication(owner: string) {
	const options = await generateAuthenticationOptions({
		rpID: rpID(),
		allowCredentials: credentialsFor(owner).map((c) => ({ id: c.id, transports: transportsOf(c) })),
		userVerification: 'required'
	});
	return { options, challengeId: storeChallenge(owner, options.challenge, 'authenticate') };
}

export async function finishAuthentication(
	owner: string,
	challengeId: string,
	response: AuthenticationResponseJSON
): Promise<void> {
	const expectedChallenge = takeChallenge(challengeId, owner, 'authenticate');

	const row = db().prepare('SELECT * FROM credentials WHERE id = ? AND owner = ?').get(response.id, owner) as
		| CredentialRow
		| undefined;
	if (!row) throw new Error('Unknown passkey');

	const verification = await verifyAuthenticationResponse({
		response,
		expectedChallenge,
		expectedOrigin: config.origin,
		expectedRPID: rpID(),
		credential: {
			id: row.id,
			// node:sqlite hands back a Uint8Array over a generic ArrayBufferLike;
			// copying it produces the plain-ArrayBuffer view the verifier expects.
			publicKey: new Uint8Array(row.public_key),
			counter: row.counter,
			transports: transportsOf(row)
		},
		requireUserVerification: true
	});

	if (!verification.verified) throw new Error('Passkey assertion failed');

	db()
		.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?')
		.run(verification.authenticationInfo.newCounter, new Date().toISOString(), row.id);
}
