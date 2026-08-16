import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SCHEMA } from './schema.ts';

/**
 * Every SQL statement in the server tree is prepared against a real schema.
 *
 * SQLite validates a great deal at prepare time — column names, and crucially
 * whether an ON CONFLICT target actually matches an index. A conflict target
 * that omits the predicate of a *partial* unique index is rejected outright, so
 * a statement can be syntactically fine, pass type-checking, and still fail on
 * the first row it ever touches in production.
 *
 * The statements are read out of the source rather than copied here, so this
 * cannot drift: a new query is covered the moment it is written.
 */

const ROOTS = ['src/lib/server', 'scripts'];

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return walk(path);
		return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
	});
}

type Found = { file: string; line: number; sql: string };

/** Pulls the string literal out of each `.prepare(<literal>)` call. */
function extractStatements(file: string): Found[] {
	const src = readFileSync(file, 'utf8');
	const out: Found[] = [];
	const opener = /\.prepare\(\s*(`|'|")/g;

	let match: RegExpExecArray | null;
	while ((match = opener.exec(src))) {
		const quote = match[1];
		const start = match.index + match[0].length;

		let i = start;
		while (i < src.length) {
			if (src[i] === '\\') i += 2;
			else if (src[i] === quote) break;
			else i++;
		}
		if (i >= src.length) continue;

		out.push({
			file: relative(process.cwd(), file),
			line: src.slice(0, match.index).split('\n').length,
			sql: src.slice(start, i)
		});
		opener.lastIndex = i;
	}
	return out;
}

const statements = ROOTS.flatMap((root) => walk(root)).flatMap(extractStatements);

// Statements assembled from interpolated fragments cannot be prepared as-is.
const preparable = statements.filter((s) => !s.sql.includes('${'));

describe('SQL statements prepare against the real schema', () => {
	it('finds the statements to check', () => {
		// Guards against the extractor silently matching nothing after a refactor,
		// which would turn this whole file into a no-op that always passes.
		expect(preparable.length).toBeGreaterThanOrEqual(15);
	});

	it.each(preparable.map((s) => [`${s.file}:${s.line}`, s.sql] as const))('%s', (_where, sql) => {
		const db = new DatabaseSync(':memory:');
		try {
			db.exec(SCHEMA);
			expect(() => db.prepare(sql)).not.toThrow();
		} finally {
			db.close();
		}
	});
});

describe('upserts on partial unique indexes', () => {
	// The specific defect: accounts_external and transactions_external are
	// partial (WHERE external_id IS NOT NULL), so a conflict target naming only
	// (source, external_id) matches no constraint and the statement never
	// compiles. Asserted directly so the reason is recorded, not just the symptom.
	const partialIndexTables = ['accounts', 'transactions'];

	it.each(partialIndexTables)('%s has a partial external-id index', (table) => {
		const db = new DatabaseSync(':memory:');
		db.exec(SCHEMA);
		const row = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
			.get(`${table}_external`) as { sql: string };
		db.close();
		expect(row.sql).toMatch(/WHERE external_id IS NOT NULL/);
	});

	it.each(partialIndexTables)('%s upsert actually collapses a duplicate', (table) => {
		const db = new DatabaseSync(':memory:');
		db.exec(SCHEMA);

		const sql =
			table === 'accounts'
				? `INSERT INTO accounts (source, external_id, name, type, current_cents)
				   VALUES ('plaid', 'x1', ?, 'depository', ?)
				   ON CONFLICT(source, external_id) WHERE external_id IS NOT NULL
				   DO UPDATE SET name = excluded.name, current_cents = excluded.current_cents`
				: `INSERT INTO transactions (account_id, source, external_id, dedupe_hash, posted_on,
				                             amount_cents, description)
				   VALUES (1, 'plaid', 'x1', 'h1', '2026-08-15', ?, ?)
				   ON CONFLICT(source, external_id) WHERE external_id IS NOT NULL
				   DO UPDATE SET amount_cents = excluded.amount_cents, description = excluded.description`;

		if (table === 'transactions') {
			db.exec(
				`INSERT INTO accounts (id, source, external_id, name, type) VALUES (1, 'plaid', 'a1', 'A', 'depository')`
			);
		}

		const stmt = db.prepare(sql);
		if (table === 'accounts') {
			stmt.run('First', 100);
			stmt.run('Second', 250);
		} else {
			stmt.run(100, 'First');
			stmt.run(250, 'Second');
		}

		const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
		db.close();

		expect(rows).toHaveLength(1);
		expect(rows[0][table === 'accounts' ? 'name' : 'description']).toBe('Second');
	});

	it('still rejects a conflict target missing the predicate', () => {
		// If a future schema change makes these indexes non-partial, this test
		// fails and the predicate should be dropped from the upserts to match.
		const db = new DatabaseSync(':memory:');
		db.exec(SCHEMA);
		expect(() =>
			db.prepare(
				`INSERT INTO accounts (source, external_id, name, type) VALUES ('plaid', 'x', 'n', 'depository')
				 ON CONFLICT(source, external_id) DO UPDATE SET name = excluded.name`
			)
		).toThrow(/ON CONFLICT/i);
		db.close();
	});
});
