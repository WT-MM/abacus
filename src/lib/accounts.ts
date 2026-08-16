// Shared by server and browser: how an account's stored balance turns into a
// contribution to net worth.

export type AccountType = 'depository' | 'credit' | 'investment' | 'loan' | 'other';

export type Account = {
	id: number;
	name: string;
	official_name: string | null;
	mask: string | null;
	institution_name: string | null;
	type: AccountType;
	subtype: string | null;
	current_cents: number;
	available_cents: number | null;
	limit_cents: number | null;
	balance_as_of: string | null;
	hidden: number;
	closed: number;
	item_id: number | null;
	source: string;
};

/** Credit and loan balances are stored as the amount owed, so they subtract. */
export function signedCents(account: Pick<Account, 'type' | 'current_cents'>): number {
	return account.type === 'credit' || account.type === 'loan'
		? -account.current_cents
		: account.current_cents;
}

export type Bucket = 'cash' | 'investments' | 'debt';

export function bucketOf(type: AccountType): Bucket {
	if (type === 'credit' || type === 'loan') return 'debt';
	if (type === 'investment') return 'investments';
	return 'cash';
}

export function netWorth(accounts: Array<Pick<Account, 'type' | 'current_cents' | 'closed' | 'hidden'>>): number {
	return accounts
		.filter((a) => !a.closed && !a.hidden)
		.reduce((sum, a) => sum + signedCents(a), 0);
}

export function bucketTotals(
	accounts: Array<Pick<Account, 'type' | 'current_cents' | 'closed' | 'hidden'>>
): Record<Bucket, number> {
	const totals: Record<Bucket, number> = { cash: 0, investments: 0, debt: 0 };
	for (const a of accounts) {
		if (a.closed || a.hidden) continue;
		totals[bucketOf(a.type)] += signedCents(a);
	}
	return totals;
}
