import { db } from './db.ts';

// Plaid's personal_finance_category taxonomy mapped onto the default sheet.
// Anything unmapped lands in Uncategorised rather than being silently dropped.
const PFC_MAP: Record<string, string> = {
	INCOME: 'Salary',
	TRANSFER_IN: 'Transfer',
	TRANSFER_OUT: 'Transfer',
	LOAN_PAYMENTS: 'Fees & Interest',
	BANK_FEES: 'Fees & Interest',
	ENTERTAINMENT: 'Entertainment',
	FOOD_AND_DRINK: 'Dining',
	GENERAL_MERCHANDISE: 'Shopping',
	HOME_IMPROVEMENT: 'Housing',
	MEDICAL: 'Health',
	PERSONAL_CARE: 'Health',
	GENERAL_SERVICES: 'Shopping',
	GOVERNMENT_AND_NON_PROFIT: 'Taxes',
	TRANSPORTATION: 'Transport',
	TRAVEL: 'Travel',
	RENT_AND_UTILITIES: 'Utilities'
};

// Detailed categories worth splitting out of their primary bucket.
const DETAILED_MAP: Record<string, string> = {
	FOOD_AND_DRINK_GROCERIES: 'Groceries',
	RENT_AND_UTILITIES_RENT: 'Rent & Mortgage',
	LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'Rent & Mortgage',
	INCOME_DIVIDENDS: 'Interest & Dividends',
	INCOME_INTEREST_EARNED: 'Interest & Dividends',
	GENERAL_SERVICES_SUBSCRIPTION: 'Subscriptions',
	ENTERTAINMENT_STREAMING: 'Subscriptions'
};

let idCache: Map<string, number> | null = null;

export function categoryId(name: string): number | null {
	if (!idCache) {
		idCache = new Map();
		const rows = db().prepare('SELECT id, name FROM categories').all() as Array<{ id: number; name: string }>;
		for (const r of rows) idCache.set(r.name.toLowerCase(), r.id);
	}
	return idCache.get(name.toLowerCase()) ?? null;
}

export function invalidateCategoryCache(): void {
	idCache = null;
}

/**
 * User rules win over Plaid's taxonomy — a rule is an explicit statement about
 * this person's spending, and Plaid's guess is not.
 */
export function classify(input: {
	description: string;
	merchant?: string | null;
	primary?: string | null;
	detailed?: string | null;
}): number | null {
	const haystack = `${input.description} ${input.merchant ?? ''}`.toLowerCase();

	const rules = db()
		.prepare('SELECT pattern, category_id FROM rules ORDER BY priority DESC, id ASC')
		.all() as Array<{ pattern: string; category_id: number }>;

	for (const rule of rules) {
		if (matches(haystack, rule.pattern)) return rule.category_id;
	}

	if (input.detailed && DETAILED_MAP[input.detailed]) return categoryId(DETAILED_MAP[input.detailed]);
	if (input.primary && PFC_MAP[input.primary]) return categoryId(PFC_MAP[input.primary]);
	return categoryId('Uncategorised');
}

function matches(haystack: string, pattern: string): boolean {
	if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
		const end = pattern.lastIndexOf('/');
		try {
			return new RegExp(pattern.slice(1, end), pattern.slice(end + 1) || 'i').test(haystack);
		} catch {
			return false; // A malformed rule must not break every import.
		}
	}
	return haystack.includes(pattern.toLowerCase());
}
