#!/usr/bin/env node
// Fills a scratch database with plausible activity so the interface can be
// worked on without connecting a real institution. Never run this against a
// database holding real data — it refuses if one already has accounts.

import { loadEnv } from './env.ts';

loadEnv();

const { db, tx } = await import('../src/lib/server/db.ts');
const { setCell } = await import('../src/lib/server/budget.ts');
const { categoryId } = await import('../src/lib/server/categorize.ts');

const conn = db();

const existing = conn.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
if (existing.n > 0 && !process.argv.includes('--force')) {
	process.stderr.write('Refusing to seed: this database already has accounts. Pass --force to override.\n');
	process.exit(1);
}

const ACCOUNTS: Array<[string, string, string, string, number]> = [
	// institution, name, type, subtype, current balance in cents
	['Chase', 'Total Checking', 'depository', 'checking', 1_284_412],
	['Chase', 'Sapphire Reserve', 'credit', 'credit card', 312_477],
	['Fidelity', 'Individual Brokerage', 'investment', 'brokerage', 21_847_900],
	['Fidelity', 'Roth IRA', 'investment', 'ira', 8_612_340],
	['Wealthfront', 'Automated Investing', 'investment', 'brokerage', 9_204_155],
	['Wealthfront', 'Cash Account', 'depository', 'savings', 2_640_880]
];

const MERCHANTS: Array<[string, string, number, number]> = [
	// description, category, min cents, max cents
	['WHOLE FOODS MKT', 'Groceries', 4_200, 14_800],
	['TRADER JOES', 'Groceries', 2_800, 9_400],
	['BLUE BOTTLE COFFEE', 'Dining', 600, 1_900],
	['TARTINE BAKERY', 'Dining', 1_400, 4_800],
	['UBER TRIP', 'Transport', 900, 4_200],
	['CHEVRON', 'Transport', 3_800, 7_600],
	['AMAZON MKTPL', 'Shopping', 1_500, 18_000],
	['NETFLIX.COM', 'Subscriptions', 1_599, 1_599],
	['SPOTIFY USA', 'Subscriptions', 1_199, 1_199],
	['PG&E', 'Utilities', 6_800, 14_200],
	['COMCAST', 'Utilities', 8_000, 8_000],
	['ONE MEDICAL', 'Health', 2_500, 12_000],
	['ALASKA AIR', 'Travel', 18_000, 62_000]
];

// A fixed generator so repeated seeds produce the same sheet.
let seedState = 20260815;
const rand = () => {
	seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
	return seedState / 0x7fffffff;
};
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const iso = (d: Date) => d.toISOString().slice(0, 10);

tx(() => {
	const insertAccount = conn.prepare(
		`INSERT INTO accounts (source, external_id, name, institution_name, type, subtype, current_cents, balance_as_of)
		 VALUES ('import', ?, ?, ?, ?, ?, ?, ?)`
	);
	const insertTxn = conn.prepare(
		`INSERT INTO transactions (account_id, source, dedupe_hash, posted_on, amount_cents, description, category_id)
		 VALUES (?, 'import', ?, ?, ?, ?, ?)`
	);
	const insertSnapshot = conn.prepare(
		`INSERT INTO balance_snapshots (account_id, on_date, current_cents) VALUES (?, ?, ?)
		 ON CONFLICT(account_id, on_date) DO UPDATE SET current_cents = excluded.current_cents`
	);

	const ids: number[] = [];
	for (const [institution, name, type, subtype, balance] of ACCOUNTS) {
		insertAccount.run(`seed-${name}`, name, institution, type, subtype, balance, new Date().toISOString());
		const row = conn.prepare(`SELECT id FROM accounts WHERE external_id = ?`).get(`seed-${name}`) as { id: number };
		ids.push(row.id);
	}

	const [checking, card, brokerage, ira, wealthfront, savings] = ids;
	const today = new Date();

	// Fourteen months of balance history, drifting upward with a dip so the
	// trend line has some shape to it.
	for (let m = 14; m >= 0; m--) {
		const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - m, 15));
		const growth = 1 - m * 0.021;
		const wobble = 1 + Math.sin(m * 1.3) * 0.014;
		for (const [i, id] of ids.entries()) {
			const base = ACCOUNTS[i][4];
			const isDebt = ACCOUNTS[i][2] === 'credit';
			insertSnapshot.run(id, iso(d), Math.round(base * (isDebt ? 1 + m * 0.004 : growth * wobble)));
		}
	}

	let hash = 0;
	const nextHash = () => `seed-${hash++}`;

	// Nine months of spending, salary and contributions.
	for (let m = 8; m >= 0; m--) {
		const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - m, 1));
		const lastDay = m === 0 ? today.getUTCDate() : new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();

		const paydays = [1, 15].filter((d) => d <= lastDay);
		for (const day of paydays) {
			const d = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day));
			insertTxn.run(checking, nextHash(), iso(d), 462_500, 'SOMANA PAYROLL DIRECT DEP', categoryId('Salary'));
		}

		if (lastDay >= 3) {
			const rentDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 3));
			insertTxn.run(checking, nextHash(), iso(rentDay), -285_000, 'PROPERTY MGMT RENT', categoryId('Rent & Mortgage'));
		}

		if (lastDay >= 5) {
			const investDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 5));
			insertTxn.run(checking, nextHash(), iso(investDay), -150_000, 'WEALTHFRONT TRANSFER', categoryId('Investment'));
			insertTxn.run(wealthfront, nextHash(), iso(investDay), 150_000, 'DEPOSIT FROM CHASE', categoryId('Investment'));
			insertTxn.run(brokerage, nextHash(), iso(investDay), 24_180, 'DIVIDEND RECEIVED VTI', categoryId('Interest & Dividends'));
		}

		const count = between(26, 40);
		for (let i = 0; i < count; i++) {
			const [name, category, lo, hi] = MERCHANTS[between(0, MERCHANTS.length - 1)];
			const day = between(1, lastDay);
			const d = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day));
			// Most spending sits on the card; a minority clears from checking.
			const account = rand() > 0.25 ? card : checking;
			insertTxn.run(account, nextHash(), iso(d), -between(lo, hi), name, categoryId(category));
		}
	}

	// Holdings behind the brokerage balances.
	const insertHolding = conn.prepare(
		`INSERT INTO holdings (account_id, security_id, symbol, name, quantity, price_cents, value_cents, as_of)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const HOLDINGS: Array<[number, string, string, number, number]> = [
		[brokerage, 'VTI', 'Vanguard Total Stock Market ETF', 512, 29_015],
		[brokerage, 'VXUS', 'Vanguard Total International Stock ETF', 380, 6_842],
		[ira, 'FZROX', 'Fidelity ZERO Total Market Index', 4_820, 1_787],
		[wealthfront, 'VTI', 'Vanguard Total Stock Market ETF', 217, 29_015]
	];
	for (const [account, symbol, name, qty, price] of HOLDINGS) {
		insertHolding.run(account, `${account}-${symbol}`, symbol, name, qty, price, qty * price, iso(today));
	}
});

// A budget sheet that exercises the formula engine rather than only literals.
const month = new Date().toISOString().slice(0, 7);
const CELLS: Array<[string, string]> = [
	['Salary', '9250'],
	['Interest & Dividends', '240'],
	['Rent & Mortgage', '2850'],
	['Utilities', '=PREV()*1.03'],
	['Groceries', '750'],
	['Dining', '=B[Groceries]*0.55'],
	['Transport', '260'],
	['Health', '180'],
	['Shopping', '400'],
	['Entertainment', '150'],
	['Travel', '500'],
	['Subscriptions', '95'],
	['Fees & Interest', '40']
];

// The previous month gets literal values so that =PREV() in the current month
// has something to resolve against.
const [y, m] = month.split('-').map(Number);
const prevMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);

for (const [name, formula] of CELLS) {
	const id = categoryId(name);
	if (!id) continue;
	setCell(month, id, formula);
	if (!formula.startsWith('=')) setCell(prevMonth, id, formula);
}
setCell(prevMonth, categoryId('Utilities')!, '265');

const counts = conn
	.prepare('SELECT (SELECT COUNT(*) FROM accounts) AS a, (SELECT COUNT(*) FROM transactions) AS t')
	.get() as { a: number; t: number };

process.stdout.write(`Seeded ${counts.a} accounts and ${counts.t} transactions for ${month}.\n`);
