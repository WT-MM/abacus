import { db, tx, getMeta, setMeta } from './db.ts';
import { decrypt, encrypt, redact } from './crypto.ts';
import { classify, categoryId } from './categorize.ts';
import * as plaid from './plaid.ts';
import { PlaidError, type PlaidAccount, type PlaidTransaction, type SyncPage } from './plaid.ts';

export type ItemRow = {
	id: number;
	plaid_item_id: string;
	institution_id: string | null;
	institution_name: string;
	access_token_ct: string;
	transactions_cursor: string | null;
	consent_expires_at: string | null;
	last_successful_update: string | null;
	last_synced_at: string | null;
	status: string;
	error_code: string | null;
	error_message: string | null;
};

const TOKEN_AAD = 'plaid.access_token';

/**
 * Stand-in name recorded when an Item is linked. The link step writes the token
 * before naming the institution, so that a transient failure cannot strand a
 * token whose Item slot has already been spent; the name is backfilled here on
 * the next sync.
 */
export const UNNAMED_INSTITUTION = 'Linked institution';

export function accessTokenOf(item: ItemRow): string {
	return decrypt(item.access_token_ct, TOKEN_AAD);
}

export function storeAccessToken(token: string): string {
	return encrypt(token, TOKEN_AAD);
}

const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

function daysAgo(n: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - n);
	return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ accounts

function upsertAccounts(itemId: number, institution: string, accounts: PlaidAccount[]): Map<string, number> {
	const conn = db();
	const ids = new Map<string, number>();

	const upsert = conn.prepare(`
		INSERT INTO accounts (item_id, source, external_id, name, official_name, mask,
		                      institution_name, type, subtype, currency,
		                      current_cents, available_cents, limit_cents, balance_as_of)
		VALUES (?, 'plaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		-- accounts_external is a partial index, so its predicate has to be
		-- restated here. Without it SQLite matches no constraint and the
		-- statement fails at prepare time, before a single row is written.
		ON CONFLICT(source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
			name            = excluded.name,
			official_name   = excluded.official_name,
			mask            = excluded.mask,
			type            = excluded.type,
			subtype         = excluded.subtype,
			current_cents   = excluded.current_cents,
			available_cents = excluded.available_cents,
			limit_cents     = excluded.limit_cents,
			balance_as_of   = excluded.balance_as_of`);

	const find = conn.prepare(`SELECT id FROM accounts WHERE source = 'plaid' AND external_id = ?`);
	const snapshot = conn.prepare(`
		INSERT INTO balance_snapshots (account_id, on_date, current_cents) VALUES (?, ?, ?)
		ON CONFLICT(account_id, on_date) DO UPDATE SET current_cents = excluded.current_cents`);

	const cents = (v: number | null) => (v === null ? null : Math.round(v * 100));

	for (const a of accounts) {
		upsert.run(
			itemId,
			a.account_id,
			a.name,
			a.official_name,
			a.mask,
			institution,
			// Route on the type Plaid reports. Inferring from the institution is
			// wrong: brokerages hold cash accounts and banks hold investment ones.
			a.type,
			a.subtype,
			a.balances.iso_currency_code ?? 'USD',
			cents(a.balances.current) ?? 0,
			cents(a.balances.available),
			cents(a.balances.limit),
			nowIso()
		);
		const row = find.get(a.account_id) as { id: number } | undefined;
		if (!row) continue;
		ids.set(a.account_id, row.id);
		snapshot.run(row.id, today(), cents(a.balances.current) ?? 0);
	}

	return ids;
}

// -------------------------------------------------------------- transactions

function writeTransaction(accountId: number, t: PlaidTransaction): void {
	// Plaid reports a debit as a positive number. Abacus stores money leaving an
	// account as negative, so the inversion happens once, here, at ingest.
	const amount = -Math.round(t.amount * 100);
	const primary = t.personal_finance_category?.primary ?? null;
	const detailed = t.personal_finance_category?.detailed ?? null;

	db()
		.prepare(
			`INSERT INTO transactions (account_id, source, external_id, dedupe_hash, posted_on,
			                           amount_cents, description, merchant, plaid_category,
			                           category_id, pending, is_transfer)
			 VALUES (?, 'plaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 -- transactions_external is partial; the predicate is part of the
			 -- conflict target or the statement will not compile.
			 ON CONFLICT(source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
			   posted_on    = excluded.posted_on,
			   amount_cents = excluded.amount_cents,
			   description  = excluded.description,
			   merchant     = excluded.merchant,
			   pending      = excluded.pending,
			   -- A hand-set category is never overwritten by a later sync.
			   category_id  = CASE WHEN transactions.category_locked = 1
			                       THEN transactions.category_id ELSE excluded.category_id END`
		)
		.run(
			accountId,
			t.transaction_id,
			t.transaction_id,
			t.date,
			amount,
			t.name,
			t.merchant_name,
			detailed,
			classify({ description: t.name, merchant: t.merchant_name, primary, detailed }),
			t.pending ? 1 : 0,
			primary === 'TRANSFER_IN' || primary === 'TRANSFER_OUT' ? 1 : 0
		);
}

/**
 * Drains /transactions/sync and commits the whole page set atomically.
 *
 * The cursor is only advanced inside the same transaction that writes the rows,
 * because a cursor persisted ahead of its data would skip those transactions
 * forever — Plaid will never send them again.
 */
async function syncItemTransactions(item: ItemRow, token: string, accountIds: Map<string, number>): Promise<number> {
	let cursor = item.transactions_cursor;
	let attempts = 0;

	for (;;) {
		const added: PlaidTransaction[] = [];
		const modified: PlaidTransaction[] = [];
		const removed: string[] = [];
		let pageCursor = cursor;
		let restart = false;

		for (;;) {
			let page: SyncPage;
			try {
				page = await plaid.syncTransactions(token, pageCursor);
			} catch (err) {
				// Plaid mutated the page set mid-pagination; the partial set is
				// inconsistent and must be re-fetched from where this pass began.
				if (err instanceof PlaidError && err.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
					restart = true;
					break;
				}
				throw err;
			}

			added.push(...page.added);
			modified.push(...page.modified);
			removed.push(...page.removed.map((r) => r.transaction_id));
			pageCursor = page.next_cursor;
			if (!page.has_more) break;
		}

		if (restart) {
			if (++attempts >= 5) throw new Error('transactions/sync kept mutating during pagination');
			continue;
		}

		tx(() => {
			const del = db().prepare(`DELETE FROM transactions WHERE source = 'plaid' AND external_id = ?`);
			for (const t of [...added, ...modified]) {
				const accountId = accountIds.get(t.account_id);
				if (accountId) writeTransaction(accountId, t);
			}
			for (const id of removed) del.run(id);
			db().prepare('UPDATE items SET transactions_cursor = ? WHERE id = ?').run(pageCursor, item.id);
		});

		cursor = pageCursor;
		return added.length + modified.length + removed.length;
	}
}

// --------------------------------------------------------------- investments

async function syncInvestments(item: ItemRow, token: string, accountIds: Map<string, number>): Promise<number> {
	let touched = 0;

	// Holdings have no cursor, so the snapshot for each account is replaced
	// wholesale — a merge would leave sold-out positions behind forever.
	const { holdings, securities } = await plaid.getHoldings(token);
	const security = new Map(securities.map((s) => [s.security_id, s]));

	tx(() => {
		const conn = db();
		const clear = conn.prepare('DELETE FROM holdings WHERE account_id = ?');
		const insert = conn.prepare(`
			INSERT INTO holdings (account_id, security_id, symbol, name, quantity,
			                      price_cents, value_cents, cost_basis_cents, as_of)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(account_id, security_id) DO UPDATE SET
				quantity = excluded.quantity, price_cents = excluded.price_cents,
				value_cents = excluded.value_cents, cost_basis_cents = excluded.cost_basis_cents,
				as_of = excluded.as_of`);

		for (const accountId of new Set(holdings.map((h) => accountIds.get(h.account_id)).filter(Boolean))) {
			clear.run(accountId as number);
		}
		for (const h of holdings) {
			const accountId = accountIds.get(h.account_id);
			if (!accountId) continue;
			const s = security.get(h.security_id);
			insert.run(
				accountId,
				h.security_id,
				s?.ticker_symbol ?? null,
				s?.name ?? null,
				h.quantity,
				h.institution_price === null ? null : Math.round(h.institution_price * 100),
				Math.round((h.institution_value ?? 0) * 100),
				h.cost_basis === null ? null : Math.round(h.cost_basis * 100),
				today()
			);
			touched++;
		}
	});

	// Investment transactions are not covered by /transactions/sync at all, and
	// have no cursor. A rolling overlap window catches late corrections; a wider
	// monthly pass catches cancellations that fall outside it.
	const lastFull = getMeta('investments.last_full_reconcile');
	const wide = !lastFull || Date.parse(lastFull) < Date.now() - 30 * 864e5;
	const start = wide ? daysAgo(730) : daysAgo(120);

	let offset = 0;
	let total = Infinity;
	while (offset < total) {
		const res = await plaid.getInvestmentTransactions(token, start, today(), offset);
		total = res.total_investment_transactions;
		if (!res.investment_transactions.length) break;

		tx(() => {
			for (const it of res.investment_transactions) {
				const accountId = accountIds.get(it.account_id);
				if (!accountId) continue;
				const income = it.subtype === 'dividend' || it.subtype === 'interest';
				db()
					.prepare(
						`INSERT INTO transactions (account_id, source, external_id, dedupe_hash, posted_on,
						                           amount_cents, description, plaid_category, category_id,
						                           pending, is_transfer)
						 VALUES (?, 'plaid', ?, ?, ?, ?, ?, ?, ?, 0, ?)
						 -- Partial index; see the note on the transactions upsert above.
						 ON CONFLICT(source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
						   amount_cents = excluded.amount_cents, posted_on = excluded.posted_on`
					)
					.run(
						accountId,
						it.investment_transaction_id,
						it.investment_transaction_id,
						it.date,
						-Math.round(it.amount * 100),
						it.name,
						`investment.${it.subtype}`,
						categoryId(income ? 'Interest & Dividends' : 'Investment'),
						income ? 0 : 1
					);
				touched++;
			}
		});
		offset += res.investment_transactions.length;
	}

	if (wide) setMeta('investments.last_full_reconcile', nowIso());
	return touched;
}

// ---------------------------------------------------------------- item pass

export type ItemResult = {
	institution: string;
	ok: boolean;
	needsRepair: boolean;
	changed: number;
	message?: string;
};

async function syncItem(item: ItemRow): Promise<ItemResult> {
	const token = accessTokenOf(item);
	const conn = db();

	// Health first. Without webhooks nothing else reports that an Item has
	// stopped updating, so this is the only signal that consent lapsed.
	const status = await plaid.getItem(token);
	const itemError = status.item.error;
	conn
		.prepare(
			`UPDATE items SET consent_expires_at = ?, last_successful_update = ?,
			                  error_code = ?, error_message = ?,
			                  status = ? WHERE id = ?`
		)
		.run(
			status.item.consent_expiration_time,
			status.status?.transactions?.last_successful_update ?? null,
			itemError?.error_code ?? null,
			itemError ? redact(itemError.error_message) : null,
			itemError ? 'needs_repair' : 'ok',
			item.id
		);

	if (itemError) {
		return {
			institution: item.institution_name,
			ok: false,
			needsRepair: true,
			changed: 0,
			message: `${itemError.error_code}: reconnect required`
		};
	}

	// Name an Item that was linked while Plaid was unreachable for the lookup.
	// Without this it stays "Linked institution" permanently, since nothing else
	// revisits the name once the row exists.
	if (item.institution_name === UNNAMED_INSTITUTION && status.item.institution_id) {
		try {
			const { institution } = await plaid.getInstitution(status.item.institution_id);
			conn
				.prepare('UPDATE items SET institution_id = ?, institution_name = ? WHERE id = ?')
				.run(status.item.institution_id, institution.name, item.id);
			item.institution_name = institution.name;
		} catch {
			// Cosmetic; try again next run.
		}
	}

	const { accounts } = await plaid.getAccounts(token);
	const accountIds = tx(() => upsertAccounts(item.id, item.institution_name, accounts));

	let changed = await syncItemTransactions(item, token, accountIds);

	const hasInvestments = accounts.some((a) => a.type === 'investment');
	if (hasInvestments) {
		try {
			changed += await syncInvestments(item, token, accountIds);
		} catch (err) {
			// A brokerage that does not expose Investments must not fail the run;
			// its balances and cash transactions are still worth having.
			if (!(err instanceof PlaidError && err.productUnsupported)) throw err;
		}
	}

	conn.prepare(`UPDATE items SET last_synced_at = ?, status = 'ok' WHERE id = ?`).run(nowIso(), item.id);
	return { institution: item.institution_name, ok: true, needsRepair: false, changed };
}

/** Syncs every linked Item. One broken institution never blocks the others. */
export async function syncAll(): Promise<{ status: string; results: ItemResult[] }> {
	const conn = db();
	const started = nowIso();
	const run = conn.prepare(`INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')`).run(started);
	const runId = Number(run.lastInsertRowid);

	const items = conn.prepare('SELECT * FROM items ORDER BY id').all() as ItemRow[];
	const results: ItemResult[] = [];

	for (const item of items) {
		try {
			results.push(await syncItem(item));
		} catch (err) {
			const message = redact(err instanceof Error ? err.message : String(err));
			const repair = err instanceof PlaidError && err.needsRepair;
			conn
				.prepare(`UPDATE items SET status = ?, error_message = ? WHERE id = ?`)
				.run(repair ? 'needs_repair' : 'error', message, item.id);
			results.push({
				institution: item.institution_name,
				ok: false,
				needsRepair: repair,
				changed: 0,
				message
			});
		}
	}

	const failed = results.filter((r) => !r.ok).length;
	const status = !items.length ? 'ok' : failed === 0 ? 'ok' : failed === items.length ? 'error' : 'partial';

	conn
		.prepare('UPDATE sync_runs SET finished_at = ?, status = ?, detail = ? WHERE id = ?')
		.run(nowIso(), status, JSON.stringify(results), runId);

	return { status, results };
}

/** True when no Item has updated within `days` — surfaced as a staleness banner. */
export function stalenessDays(): number | null {
	const row = db()
		.prepare(`SELECT MAX(last_synced_at) AS latest FROM items`)
		.get() as { latest: string | null } | undefined;
	if (!row?.latest) return null;
	return Math.floor((Date.now() - Date.parse(row.latest)) / 864e5);
}
