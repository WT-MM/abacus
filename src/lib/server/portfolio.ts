import { db } from './db.ts';

export type Holding = {
	id: number;
	accountId: number;
	accountName: string;
	institution: string | null;
	symbol: string | null;
	name: string | null;
	quantity: number;
	priceCents: number | null;
	valueCents: number;
	costBasisCents: number | null;
	gainCents: number | null;
	/** Share of total holdings value, 0–1. */
	weight: number;
	asOf: string;
};

export type Position = {
	holdings: Holding[];
	holdingsValueCents: number;
	costBasisCents: number;
	/** Null when no holding reports a cost basis. */
	gainCents: number | null;
	/** Sum of the balances of every investment account. */
	investmentBalanceCents: number;
	/**
	 * Investment balance not accounted for by holdings — normally uninvested
	 * cash sitting in a brokerage. Reported rather than hidden, because the two
	 * figures almost never match and a silent discrepancy reads as a bug.
	 */
	uninvestedCents: number;
	asOf: string | null;
};

type HoldingRow = {
	id: number;
	account_id: number;
	account_name: string;
	institution_name: string | null;
	symbol: string | null;
	name: string | null;
	quantity: number;
	price_cents: number | null;
	value_cents: number;
	cost_basis_cents: number | null;
	as_of: string;
};

export function portfolio(): Position {
	const rows = db()
		.prepare(
			`SELECT h.id, h.account_id, a.name AS account_name, a.institution_name,
			        h.symbol, h.name, h.quantity, h.price_cents, h.value_cents,
			        h.cost_basis_cents, h.as_of
			   FROM holdings h
			   JOIN accounts a ON a.id = h.account_id
			  WHERE a.closed = 0 AND a.hidden = 0
			  ORDER BY h.value_cents DESC`
		)
		.all() as HoldingRow[];

	const holdingsValueCents = rows.reduce((sum, r) => sum + r.value_cents, 0);

	const withBasis = rows.filter((r) => r.cost_basis_cents !== null);
	const costBasisCents = withBasis.reduce((sum, r) => sum + (r.cost_basis_cents ?? 0), 0);
	const basisValueCents = withBasis.reduce((sum, r) => sum + r.value_cents, 0);

	const { total } = db()
		.prepare(
			`SELECT IFNULL(SUM(current_cents), 0) AS total FROM accounts
			  WHERE type = 'investment' AND closed = 0 AND hidden = 0`
		)
		.get() as { total: number };

	const holdings: Holding[] = rows.map((r) => ({
		id: r.id,
		accountId: r.account_id,
		accountName: r.account_name,
		institution: r.institution_name,
		symbol: r.symbol,
		name: r.name,
		quantity: r.quantity,
		priceCents: r.price_cents,
		valueCents: r.value_cents,
		costBasisCents: r.cost_basis_cents,
		gainCents: r.cost_basis_cents === null ? null : r.value_cents - r.cost_basis_cents,
		weight: holdingsValueCents > 0 ? r.value_cents / holdingsValueCents : 0,
		asOf: r.as_of
	}));

	return {
		holdings,
		holdingsValueCents,
		costBasisCents,
		// Compared only against the holdings that actually reported a basis;
		// mixing in the ones that did not would understate the gain.
		gainCents: withBasis.length ? basisValueCents - costBasisCents : null,
		investmentBalanceCents: total,
		uninvestedCents: total - holdingsValueCents,
		asOf: rows.length ? rows.reduce((a, r) => (r.as_of > a ? r.as_of : a), rows[0].as_of) : null
	};
}

/** Holdings grouped by the account they sit in, for display. */
export function byAccount(holdings: Holding[]): Array<{
	accountId: number;
	label: string;
	valueCents: number;
	holdings: Holding[];
}> {
	const groups = new Map<number, Holding[]>();
	for (const h of holdings) {
		if (!groups.has(h.accountId)) groups.set(h.accountId, []);
		groups.get(h.accountId)!.push(h);
	}

	return [...groups.entries()]
		.map(([accountId, list]) => ({
			accountId,
			label: `${list[0].institution ?? 'Other'} · ${list[0].accountName}`,
			valueCents: list.reduce((sum, h) => sum + h.valueCents, 0),
			holdings: list
		}))
		.sort((a, b) => b.valueCents - a.valueCents);
}
