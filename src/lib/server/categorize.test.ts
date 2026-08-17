import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { newTempDb, removeTempDb, type TempDb } from './test-support.ts';

/**
 * Classification against a real database, because a mapping only means
 * anything once it resolves to a category row that actually exists.
 */

let tmp: TempDb;
let classify: typeof import('./categorize.ts').classify;
let nameOf: (id: number | null) => string | null;

beforeAll(async () => {
	tmp = newTempDb('abacus-cat-');

	vi.resetModules();
	const dbmod = await import('./db.ts');
	classify = (await import('./categorize.ts')).classify;

	const conn = dbmod.db();
	nameOf = (id) =>
		id === null
			? null
			: ((conn.prepare('SELECT name FROM categories WHERE id = ?').get(id) as { name: string }).name);
});

afterAll(() => removeTempDb(tmp));

const of = (primary: string, detailed?: string) =>
	nameOf(classify({ description: 'ACH DEPOSIT', primary, detailed: detailed ?? null }));

describe('income classification', () => {
	// The Salary row is what a person reads as "my paycheck". Everything else
	// Plaid files under INCOME landing there would quietly inflate it — and a
	// transfer from a friend that Plaid cannot classify arrives as
	// INCOME_OTHER_INCOME, which is exactly the case that used to read as pay.
	it.each([
		['wages are the only thing that reaches Salary', 'INCOME_WAGES', 'Salary'],
		['dividends split out', 'INCOME_DIVIDENDS', 'Interest & Dividends'],
		['interest splits out', 'INCOME_INTEREST_EARNED', 'Interest & Dividends'],
		['a tax refund is not pay', 'INCOME_TAX_REFUND', 'Other Income'],
		['unemployment is not pay', 'INCOME_UNEMPLOYMENT', 'Other Income'],
		['a pension is not pay', 'INCOME_RETIREMENT_PENSION', 'Other Income'],
		["Plaid's income catch-all is not pay", 'INCOME_OTHER_INCOME', 'Other Income'],
		['a subtype Plaid adds later is not pay', 'INCOME_SOMETHING_NEW', 'Other Income']
	])('%s', (_label, detailed, expected) => {
		expect(of('INCOME', detailed)).toBe(expected);
	});
});

describe('spending and transfers', () => {
	it.each([
		['TRANSFER_IN', undefined, 'Transfer'],
		['TRANSFER_OUT', undefined, 'Transfer'],
		['FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES', 'Groceries'],
		['FOOD_AND_DRINK', undefined, 'Dining'],
		['RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT', 'Rent & Mortgage'],
		['RENT_AND_UTILITIES', undefined, 'Utilities'],
		['TRANSPORTATION', undefined, 'Transport'],
		// Never dropped: an unknown category still has to land somewhere visible.
		['SOMETHING_PLAID_INVENTED_LATER', undefined, 'Uncategorised']
	])('%s / %s → %s', (primary, detailed, expected) => {
		expect(of(primary, detailed)).toBe(expected);
	});
});

describe('every mapping resolves to a seeded category', () => {
	// A mapping naming a category that was never seeded resolves to null, and the
	// transaction lands nowhere — invisible in the sheet and in every total.
	const PRIMARIES = [
		'INCOME',
		'TRANSFER_IN',
		'TRANSFER_OUT',
		'LOAN_PAYMENTS',
		'BANK_FEES',
		'ENTERTAINMENT',
		'FOOD_AND_DRINK',
		'GENERAL_MERCHANDISE',
		'HOME_IMPROVEMENT',
		'MEDICAL',
		'PERSONAL_CARE',
		'GENERAL_SERVICES',
		'GOVERNMENT_AND_NON_PROFIT',
		'TRANSPORTATION',
		'TRAVEL',
		'RENT_AND_UTILITIES'
	];

	const DETAILED = [
		'FOOD_AND_DRINK_GROCERIES',
		'RENT_AND_UTILITIES_RENT',
		'LOAN_PAYMENTS_MORTGAGE_PAYMENT',
		'INCOME_WAGES',
		'INCOME_DIVIDENDS',
		'INCOME_INTEREST_EARNED',
		'INCOME_TAX_REFUND',
		'INCOME_UNEMPLOYMENT',
		'INCOME_RETIREMENT_PENSION',
		'INCOME_OTHER_INCOME',
		'GENERAL_SERVICES_SUBSCRIPTION',
		'ENTERTAINMENT_STREAMING'
	];

	it.each(PRIMARIES)('primary %s resolves', (primary) => {
		expect(of(primary)).not.toBeNull();
	});

	it.each(DETAILED)('detailed %s resolves', (detailed) => {
		expect(of(detailed.split('_')[0], detailed)).not.toBeNull();
	});
});
