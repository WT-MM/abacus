import { db, tx } from '../db.ts';
import { sha256 } from '../crypto.ts';
import { classify } from '../categorize.ts';
import { parseCsv } from './csv.ts';
import { parseOfx } from './ofx.ts';

export type ParsedRow = {
	date: string; // YYYY-MM-DD
	amountCents: number; // negative = money out
	description: string;
	externalId?: string | null;
	sourceCategory?: string | null;
};

export type ImportPreview = {
	format: 'csv' | 'ofx';
	institution: string;
	columns: Record<string, string>;
	rows: ParsedRow[];
	skipped: number;
};

// Columns are matched by keyword rather than fixed position: Chase, Fidelity
// and Wealthfront all use different orders, and each changes its export format
// occasionally. Order within each list is most- to least-specific.
const HEADER_HINTS = {
	date: ['transaction date', 'posting date', 'post date', 'run date', 'trade date', 'date'],
	amount: ['amount ($)', 'amount', 'net amount'],
	debit: ['debit', 'withdrawal'],
	credit: ['credit', 'deposit'],
	description: ['description', 'action', 'name', 'payee', 'merchant', 'details', 'memo'],
	category: ['category', 'type']
};

function findColumn(headers: string[], hints: string[]): number {
	const lower = headers.map((h) => h.trim().toLowerCase());
	for (const hint of hints) {
		const exact = lower.indexOf(hint);
		if (exact !== -1) return exact;
	}
	for (const hint of hints) {
		const partial = lower.findIndex((h) => h.includes(hint));
		if (partial !== -1) return partial;
	}
	return -1;
}

function parseAmount(raw: string): number | null {
	const t = raw.trim();
	if (!t) return null;
	const negative = /^\(.*\)$/.test(t) || t.includes('-');
	const digits = t.replace(/[^0-9.]/g, '');
	if (!digits || Number.isNaN(Number(digits))) return null;
	const cents = Math.round(parseFloat(digits) * 100);
	return negative ? -cents : cents;
}

/** Accepts YYYY-MM-DD, MM/DD/YYYY and MM/DD/YY. */
export function parseDate(raw: string): string | null {
	const t = raw.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

	const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
	if (slash) {
		const [, m, d, y] = slash;
		const year = y.length === 2 ? `20${y}` : y;
		return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
	}

	const parsed = Date.parse(t);
	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

function guessInstitution(headers: string[], text: string): string {
	const h = headers.join(' ').toLowerCase();
	if (h.includes('run date') || h.includes('symbol')) return 'Fidelity';
	if (h.includes('posting date') || h.includes('check or slip')) return 'Chase';
	if (h.includes('transaction date') && h.includes('memo')) return 'Chase';
	if (text.toLowerCase().includes('wealthfront')) return 'Wealthfront';
	return 'Imported';
}

export function parseStatement(text: string, filename: string): ImportPreview {
	if (/\.(ofx|qfx)$/i.test(filename) || /<STMTTRN>/i.test(text)) {
		const rows = parseOfx(text).map((t) => ({
			date: t.date,
			amountCents: t.amountCents,
			description: t.description,
			externalId: t.id,
			sourceCategory: t.type
		}));
		return { format: 'ofx', institution: 'OFX', columns: {}, rows, skipped: 0 };
	}

	const table = parseCsv(text);
	if (!table.length) throw new Error('That file has no rows');

	// Some exports prepend a title line before the real header; take the first
	// row that actually looks like a header.
	const headerIndex = table.findIndex((r) => findColumn(r, HEADER_HINTS.date) !== -1);
	if (headerIndex === -1) throw new Error('No date column found — is this a transaction export?');

	const headers = table[headerIndex];
	const idx = {
		date: findColumn(headers, HEADER_HINTS.date),
		amount: findColumn(headers, HEADER_HINTS.amount),
		debit: findColumn(headers, HEADER_HINTS.debit),
		credit: findColumn(headers, HEADER_HINTS.credit),
		description: findColumn(headers, HEADER_HINTS.description),
		category: findColumn(headers, HEADER_HINTS.category)
	};

	if (idx.amount === -1 && idx.debit === -1 && idx.credit === -1) {
		throw new Error('No amount column found');
	}

	const rows: ParsedRow[] = [];
	let skipped = 0;

	for (const cells of table.slice(headerIndex + 1)) {
		const date = parseDate(cells[idx.date] ?? '');

		let amount: number | null = null;
		if (idx.amount !== -1) amount = parseAmount(cells[idx.amount] ?? '');
		if (amount === null && idx.debit !== -1) {
			const d = parseAmount(cells[idx.debit] ?? '');
			// A debit column holds magnitudes; the sign is implied by the column.
			if (d !== null) amount = -Math.abs(d);
		}
		if (amount === null && idx.credit !== -1) {
			const c = parseAmount(cells[idx.credit] ?? '');
			if (c !== null) amount = Math.abs(c);
		}

		if (!date || amount === null) {
			skipped++;
			continue;
		}

		rows.push({
			date,
			amountCents: amount,
			description: (cells[idx.description] ?? '').trim() || 'Imported transaction',
			sourceCategory: idx.category === -1 ? null : (cells[idx.category] ?? '').trim() || null
		});
	}

	const columns = Object.fromEntries(
		Object.entries(idx)
			.filter(([, v]) => v !== -1)
			.map(([k, v]) => [k, headers[v]])
	);

	return { format: 'csv', institution: guessInstitution(headers, text), columns, rows, skipped };
}

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();

export function dedupeHash(row: ParsedRow): string {
	return sha256(`${row.date}|${row.amountCents}|${normalise(row.description)}`);
}

export type ImportResult = { inserted: number; duplicates: number; overlapping: number };

/**
 * Writes parsed rows into an account.
 *
 * Two dedupe passes run: an exact hash for re-importing the same file, and a
 * fuzzy date/amount window against Plaid rows, because the same transaction
 * arrives from both sources with different descriptions and would otherwise be
 * counted twice.
 */
export function importRows(accountId: number, rows: ParsedRow[]): ImportResult {
	let inserted = 0;
	let duplicates = 0;
	let overlapping = 0;

	tx(() => {
		const conn = db();
		const exists = conn.prepare('SELECT 1 FROM transactions WHERE account_id = ? AND dedupe_hash = ?');
		const nearby = conn.prepare(
			`SELECT 1 FROM transactions
			  WHERE account_id = ? AND source = 'plaid' AND amount_cents = ?
			    AND ABS(julianday(posted_on) - julianday(?)) <= 3`
		);
		const insert = conn.prepare(
			`INSERT INTO transactions (account_id, source, dedupe_hash, posted_on, amount_cents,
			                           description, plaid_category, category_id)
			 VALUES (?, 'import', ?, ?, ?, ?, ?, ?)`
		);

		for (const row of rows) {
			const hash = dedupeHash(row);
			if (exists.get(accountId, hash)) {
				duplicates++;
				continue;
			}
			if (nearby.get(accountId, row.amountCents, row.date)) {
				overlapping++;
				continue;
			}
			insert.run(
				accountId,
				hash,
				row.date,
				row.amountCents,
				row.description,
				row.sourceCategory ?? null,
				classify({ description: row.description })
			);
			inserted++;
		}
	});

	return { inserted, duplicates, overlapping };
}
