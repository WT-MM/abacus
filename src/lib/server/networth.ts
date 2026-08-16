import { db } from './db.ts';
import { signedCents, bucketTotals, type Account, type AccountType } from '../accounts.ts';
import { monthShort } from '../dates.ts';

export function liveAccounts(): Account[] {
	return db()
		.prepare(`SELECT * FROM accounts WHERE closed = 0 ORDER BY institution_name, name`)
		.all() as Account[];
}

export function currentPosition() {
	const accounts = liveAccounts();
	const totals = bucketTotals(accounts);
	return {
		accounts,
		cashCents: totals.cash,
		investmentsCents: totals.investments,
		debtCents: totals.debt,
		netWorthCents: totals.cash + totals.investments + totals.debt
	};
}

const monthEnd = (month: string) => {
	const [y, m] = month.split('-').map(Number);
	return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * Net worth at the end of each of the last `months` months.
 *
 * Plaid reports only a current balance, so history exists solely because each
 * sync writes a snapshot. An account carries its most recent earlier balance
 * forward — otherwise a month with no sync would read as a crash to zero.
 */
export function netWorthHistory(months = 12): Array<{ label: string; month: string; value: number }> {
	const accounts = liveAccounts();
	if (!accounts.length) return [];

	const snapshots = db()
		.prepare('SELECT account_id, on_date, current_cents FROM balance_snapshots ORDER BY on_date')
		.all() as Array<{ account_id: number; on_date: string; current_cents: number }>;
	if (!snapshots.length) return [];

	const byAccount = new Map<number, Array<{ date: string; cents: number }>>();
	for (const s of snapshots) {
		if (!byAccount.has(s.account_id)) byAccount.set(s.account_id, []);
		byAccount.get(s.account_id)!.push({ date: s.on_date, cents: s.current_cents });
	}

	const earliest = snapshots[0].on_date.slice(0, 7);
	const now = new Date();
	const out: Array<{ label: string; month: string; value: number }> = [];

	for (let i = months - 1; i >= 0; i--) {
		const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
		const month = d.toISOString().slice(0, 7);
		if (month < earliest) continue;
		const cutoff = monthEnd(month);

		let total = 0;
		for (const account of accounts) {
			const history = byAccount.get(account.id);
			if (!history) continue;
			let latest: number | null = null;
			for (const point of history) {
				if (point.date <= cutoff) latest = point.cents;
				else break;
			}
			if (latest !== null) {
				total += signedCents({ type: account.type as AccountType, current_cents: latest });
			}
		}

		out.push({ month, label: monthShort(month), value: total });
	}

	return out;
}

export function recentTransactions(limit = 8) {
	return db()
		.prepare(
			`SELECT t.id, t.posted_on, t.amount_cents, t.description, t.merchant, t.pending,
			        a.name AS account_name, c.name AS category_name
			   FROM transactions t
			   JOIN accounts a ON a.id = t.account_id
			   LEFT JOIN categories c ON c.id = t.category_id
			  ORDER BY t.posted_on DESC, t.id DESC
			  LIMIT ?`
		)
		.all(limit) as Array<{
		id: number;
		posted_on: string;
		amount_cents: number;
		description: string;
		merchant: string | null;
		pending: number;
		account_name: string;
		category_name: string | null;
	}>;
}
