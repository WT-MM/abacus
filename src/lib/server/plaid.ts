import { config, plaidConfigured } from './config.ts';
import { redact } from './crypto.ts';

// A hand-rolled client rather than the official SDK: this app calls eight
// endpoints, and avoiding the dependency keeps the server tree importable by
// bare Node for the sync process.

const HOSTS: Record<string, string> = {
	sandbox: 'https://sandbox.plaid.com',
	production: 'https://production.plaid.com'
};

// Explicit fields rather than parameter properties: Node's strip-only
// TypeScript mode cannot compile the latter, and scripts/sync.ts imports this
// module directly.
export class PlaidError extends Error {
	code: string;
	type: string;
	status: number;

	constructor(code: string, type: string, message: string, status: number) {
		super(message);
		this.code = code;
		this.type = type;
		this.status = status;
	}

	/** Item is broken in a way only the user can fix, via Link update mode. */
	get needsRepair(): boolean {
		return ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'ITEM_LOCKED'].includes(
			this.code
		);
	}

	/** Institution does not expose this product; skip it without failing the run. */
	get productUnsupported(): boolean {
		return ['PRODUCT_NOT_SUPPORTED', 'PRODUCTS_NOT_SUPPORTED', 'NO_INVESTMENT_ACCOUNTS'].includes(
			this.code
		);
	}
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
	if (!plaidConfigured()) throw new Error('Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET.');

	const res = await fetch(`${HOSTS[config.plaid.env]}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_id: config.plaid.clientId, secret: config.plaid.secret, ...body })
	});

	const text = await res.text();
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`Plaid ${path} returned non-JSON (${res.status}): ${redact(text.slice(0, 200))}`);
	}

	if (!res.ok) {
		throw new PlaidError(
			json.error_code ?? 'UNKNOWN',
			json.error_type ?? 'UNKNOWN',
			json.error_message ?? `Plaid ${path} failed`,
			res.status
		);
	}
	return json as T;
}

// ------------------------------------------------------------------- types

export type PlaidAccount = {
	account_id: string;
	name: string;
	official_name: string | null;
	mask: string | null;
	type: string;
	subtype: string | null;
	balances: {
		current: number | null;
		available: number | null;
		limit: number | null;
		iso_currency_code: string | null;
	};
};

export type PlaidTransaction = {
	transaction_id: string;
	account_id: string;
	amount: number;
	date: string;
	name: string;
	merchant_name: string | null;
	pending: boolean;
	personal_finance_category?: { primary: string; detailed: string } | null;
};

export type PlaidHolding = {
	account_id: string;
	security_id: string;
	quantity: number;
	institution_price: number | null;
	institution_value: number | null;
	cost_basis: number | null;
};

export type PlaidSecurity = {
	security_id: string;
	ticker_symbol: string | null;
	name: string | null;
};

export type PlaidInvestmentTransaction = {
	investment_transaction_id: string;
	account_id: string;
	date: string;
	name: string;
	amount: number;
	type: string;
	subtype: string;
};

export type ItemStatus = {
	item: {
		item_id: string;
		institution_id: string | null;
		consent_expiration_time: string | null;
		error: { error_code: string; error_message: string } | null;
		products: string[];
	};
	status?: { transactions?: { last_successful_update: string | null } };
};

// --------------------------------------------------------------- endpoints

/**
 * `products` deliberately omits `balance`: it is a real-time-fetch product and
 * including it in Link slows every connection without improving daily sync.
 */
export function createLinkToken(opts: {
	userId: string;
	/** Set to repair an existing Item. Update mode must be used for re-auth, because a Trial Item slot is consumed permanently and never returned. */
	accessToken?: string;
	redirectUri: string;
}): Promise<{ link_token: string; expiration: string }> {
	const body: Record<string, unknown> = {
		user: { client_user_id: opts.userId },
		client_name: 'Abacus',
		country_codes: ['US'],
		language: 'en',
		redirect_uri: opts.redirectUri
	};

	if (opts.accessToken) {
		body.access_token = opts.accessToken;
		body.update = { account_selection_enabled: true };
	} else {
		body.products = ['transactions'];
		// Investments is requested opportunistically; brokerages that do not
		// expose it still link successfully for transactions.
		body.optional_products = ['investments'];
	}

	return call('/link/token/create', body);
}

export function exchangePublicToken(publicToken: string): Promise<{ access_token: string; item_id: string }> {
	return call('/item/public_token/exchange', { public_token: publicToken });
}

export function getItem(accessToken: string): Promise<ItemStatus> {
	return call('/item/get', { access_token: accessToken });
}

export function getInstitution(institutionId: string): Promise<{ institution: { name: string } }> {
	return call('/institutions/get_by_id', {
		institution_id: institutionId,
		country_codes: ['US']
	});
}

export function getAccounts(accessToken: string): Promise<{ accounts: PlaidAccount[] }> {
	return call('/accounts/get', { access_token: accessToken });
}

export type SyncPage = {
	added: PlaidTransaction[];
	modified: PlaidTransaction[];
	removed: Array<{ transaction_id: string }>;
	next_cursor: string;
	has_more: boolean;
	transactions_update_status?: string;
};

export function syncTransactions(accessToken: string, cursor: string | null): Promise<SyncPage> {
	const body: Record<string, unknown> = { access_token: accessToken, count: 500 };
	if (cursor) body.cursor = cursor;
	return call('/transactions/sync', body);
}

export function getHoldings(
	accessToken: string
): Promise<{ accounts: PlaidAccount[]; holdings: PlaidHolding[]; securities: PlaidSecurity[] }> {
	return call('/investments/holdings/get', { access_token: accessToken });
}

export function getInvestmentTransactions(
	accessToken: string,
	startDate: string,
	endDate: string,
	offset = 0
): Promise<{
	investment_transactions: PlaidInvestmentTransaction[];
	total_investment_transactions: number;
	securities: PlaidSecurity[];
}> {
	return call('/investments/transactions/get', {
		access_token: accessToken,
		start_date: startDate,
		end_date: endDate,
		options: { count: 500, offset }
	});
}
