import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Money moving between your own accounts must never read as spending.
 *
 * The case that matters: a card purchase is an expense, and paying the card off
 * from checking is not a second one. Counting both inflates spending by however
 * much of it went on the card — which for most people is most of it.
 */

let dir: string;
let budget: typeof import('./budget.ts');
let classify: typeof import('./categorize.ts').classify;
let isTransferCategory: typeof import('./categorize.ts').isTransferCategory;
let conn: import('node:sqlite').DatabaseSync;

const MONTH = '2026-08';

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'abacus-dbl-'));
	process.env.ABACUS_ENV_FILE = '/nonexistent';
	process.env.ABACUS_DB = join(dir, 'test.db');
	vi.resetModules();

	const dbmod = await import('./db.ts');
	budget = await import('./budget.ts');
	const cat = await import('./categorize.ts');
	classify = cat.classify;
	isTransferCategory = cat.isTransferCategory;
	conn = dbmod.db();

	conn.exec(
		`INSERT INTO accounts (id, source, external_id, name, type) VALUES
		   (1, 'plaid', 'chk', 'Checking', 'depository'),
		   (2, 'plaid', 'cc',  'Card',     'credit')`
	);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Mirrors what sync.ts writes for a Plaid transaction. */
function ingest(opts: {
	account: number;
	/** Plaid's sign: positive is money out of the account. */
	amount: number;
	name: string;
	primary: string;
	detailed?: string;
	day?: string;
}) {
	const categoryId = classify({
		description: opts.name,
		merchant: null,
		primary: opts.primary,
		detailed: opts.detailed ?? null
	});

	conn
		.prepare(
			`INSERT INTO transactions (account_id, source, external_id, dedupe_hash, posted_on,
			                           amount_cents, description, category_id, is_transfer)
			 VALUES (?, 'plaid', ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			opts.account,
			opts.name + opts.amount,
			opts.name + opts.amount,
			opts.day ?? `${MONTH}-10`,
			-Math.round(opts.amount * 100),
			opts.name,
			categoryId,
			isTransferCategory(categoryId) ? 1 : 0
		);
}

const totalSpending = () =>
	budget
		.buildGrid(MONTH)
		.rows.filter((r) => r.kind === 'expense')
		.reduce((sum, r) => sum + r.actualCents, 0);

describe('paying off a credit card', () => {
	it('counts the purchase once', () => {
		ingest({
			account: 2,
			amount: 500,
			name: 'WHOLE FOODS',
			primary: 'FOOD_AND_DRINK',
			detailed: 'FOOD_AND_DRINK_GROCERIES'
		});
		expect(totalSpending()).toBe(50_000);
	});

	it('does not count the payment as spending too', () => {
		// The purchase on the card.
		ingest({
			account: 2,
			amount: 500,
			name: 'WHOLE FOODS',
			primary: 'FOOD_AND_DRINK',
			detailed: 'FOOD_AND_DRINK_GROCERIES'
		});

		// Both sides of paying the card off: out of checking, into the card.
		ingest({
			account: 1,
			amount: 500,
			name: 'CHASE CREDIT CRD AUTOPAY',
			primary: 'LOAN_PAYMENTS',
			detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
			day: `${MONTH}-20`
		});
		ingest({
			account: 2,
			amount: -500,
			name: 'AUTOMATIC PAYMENT - THANK YOU',
			primary: 'LOAN_PAYMENTS',
			detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
			day: `${MONTH}-20`
		});

		// Still 500 spent, not 1,000 and not 1,500.
		expect(totalSpending()).toBe(50_000);
	});

	it('does not rely on the two sides cancelling out', () => {
		// Both legs land in "Fees & Interest" with opposite signs, so when they
		// fall in the same month they net to zero and the total looks right by
		// accident. They do not always fall in the same month: a payment posts to
		// checking on the 31st and to the card on the 1st. Then one month is
		// overstated by the payment and the next understated by it.
		ingest({
			account: 1,
			amount: 500,
			name: 'CHASE CREDIT CRD AUTOPAY',
			primary: 'LOAN_PAYMENTS',
			detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
			day: `${MONTH}-31`
		});
		// The card side posts next month, so it cannot cancel this one.
		expect(totalSpending()).toBe(0);
	});

	it('leaves a real loan payment as spending', () => {
		// A mortgage or car loan payment genuinely leaves the household, unlike a
		// card payoff, so blanket-excluding LOAN_PAYMENTS would be wrong.
		ingest({
			account: 1,
			amount: 1800,
			name: 'MORTGAGE SERVICING',
			primary: 'LOAN_PAYMENTS',
			detailed: 'LOAN_PAYMENTS_MORTGAGE_PAYMENT'
		});
		expect(totalSpending()).toBe(180_000);
	});

	it('keeps a plain transfer between accounts out of spending', () => {
		ingest({ account: 1, amount: 1000, name: 'TRANSFER TO SAVINGS', primary: 'TRANSFER_OUT' });
		ingest({ account: 2, amount: -1000, name: 'TRANSFER FROM CHECKING', primary: 'TRANSFER_IN' });
		expect(totalSpending()).toBe(0);
	});
});

describe('trailing averages see the same thing', () => {
	it('excludes a card payoff from the forecast basis', () => {
		const prev = '2026-07';
		const add = (amount: number, primary: string, detailed?: string) => {
			const categoryId = classify({ description: 'x', primary, detailed: detailed ?? null });
			conn
				.prepare(
					`INSERT INTO transactions (account_id, source, dedupe_hash, posted_on, amount_cents, description, category_id, is_transfer)
					 VALUES (1, 'plaid', ?, ?, ?, 'x', ?, ?)`
				)
				.run(
					`${primary}${detailed}${amount}`,
					`${prev}-10`,
					-Math.round(amount * 100),
					categoryId,
					isTransferCategory(categoryId) ? 1 : 0
				);
		};

		add(500, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES');
		add(500, 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT');

		expect(budget.trailingMonthlyAverages(MONTH, 3).expenseCents).toBe(50_000);
	});
});
