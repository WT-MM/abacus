import { db } from './db.ts';

// Plaid's personal_finance_category taxonomy mapped onto the default sheet.
// Anything unmapped lands in Uncategorised rather than being silently dropped.
const PFC_MAP: Record<string, string> = {
	// Only the detailed wage categories become Salary (see DETAILED_MAP). Plaid's
	// INCOME primary also covers tax refunds, unemployment and its own
	// catch-all, so mapping the primary straight to Salary meant a refund — or a
	// transfer from a friend that Plaid could not classify — read as a paycheck.
	INCOME: 'Other Income',
	TRANSFER_IN: 'Transfer',
	TRANSFER_OUT: 'Transfer',
	// Borrowing is neither income nor spending; the repayment is the expense.
	// Unmapped, money arriving would land in an expense category as negative
	// spending. (Plaid's v2 taxonomy only.)
	LOAN_DISBURSEMENTS: 'Transfer',
	LOAN_PAYMENTS: 'Fees & Interest',
	BANK_FEES: 'Fees & Interest',
	ENTERTAINMENT: 'Entertainment',
	FOOD_AND_DRINK: 'Dining',
	GENERAL_MERCHANDISE: 'Shopping',
	// "Housing" is a group heading in the sheet, not a category, so this used to
	// resolve to nothing — and a transaction with no category is dropped by the
	// inner join in actuals(), making every hardware-store purchase invisible in
	// the budget while still showing in the transaction list.
	HOME_IMPROVEMENT: 'Shopping',
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
	// Paying a card is not spending — the spending already happened when the
	// card was used. Counting the payoff as well double-counts everything bought
	// on credit. Note this cannot be done at the LOAN_PAYMENTS level: a mortgage
	// or car payment genuinely does leave the household.
	LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'Transfer',

	// Plaid's TRANSFER_* primaries do not mean "between this owner's accounts".
	// Cash out of an ATM is untrackable spending and a deposit is money from
	// outside; excluding either loses it entirely. Peer-to-peer app transfers
	// stay excluded on purpose — money to and from friends is usually settling
	// up — and are correctable per-transaction.
	TRANSFER_OUT_WITHDRAWAL: 'Uncategorised',
	TRANSFER_IN_DEPOSIT: 'Other Income',
	// Only wages reach Salary; anything else Plaid calls income goes to Other
	// Income, where an unexpected amount gets noticed. Both spellings, because
	// Plaid renamed this in v2 and teams created from December 2025 get v2.
	INCOME_WAGES: 'Salary',
	INCOME_SALARY: 'Salary',
	INCOME_DIVIDENDS: 'Interest & Dividends',
	INCOME_INTEREST_EARNED: 'Interest & Dividends',
	INCOME_TAX_REFUND: 'Other Income',
	INCOME_UNEMPLOYMENT: 'Other Income',
	INCOME_RETIREMENT_PENSION: 'Other Income',
	INCOME_OTHER_INCOME: 'Other Income',
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
	transferIds = null;
}

let transferIds: Set<number> | null = null;

/**
 * Whether a category represents money moving between your own accounts.
 *
 * Drives the is_transfer flag at ingest, rather than reading Plaid's primary
 * directly, so that anything routed to a transfer category is excluded however
 * it got there — including a card payoff Plaid files under LOAN_PAYMENTS, and
 * anything re-categorised by hand afterwards.
 */
export function isTransferCategory(id: number | null): boolean {
	if (id === null) return false;
	if (!transferIds) {
		const rows = db()
			.prepare(`SELECT id FROM categories WHERE kind = 'transfer'`)
			.all() as Array<{ id: number }>;
		transferIds = new Set(rows.map((r) => r.id));
	}
	return transferIds.has(id);
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

	// Falls through to Uncategorised if a mapped name does not resolve. A null
	// category is not a harmless "unknown": actuals() inner-joins categories, so
	// the row vanishes from every total while still showing in the list.
	const mapped =
		(input.detailed ? DETAILED_MAP[input.detailed] : undefined) ??
		(input.primary ? PFC_MAP[input.primary] : undefined);

	return (mapped ? categoryId(mapped) : null) ?? categoryId('Uncategorised');
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
