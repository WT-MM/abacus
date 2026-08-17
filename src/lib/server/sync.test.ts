import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { newTempDb, removeTempDb, type TempDb } from './test-support.ts';

/**
 * Drives the real syncAll() against a stubbed Plaid.
 *
 * The prepare-time checks in sql.test.ts prove the statements compile; this
 * proves they actually land rows. Both matter: the partial-index defect made
 * every institution fail at prepare time while every unit test passed, because
 * nothing exercised the Plaid write path at all.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');

const ACCOUNTS = [
	{
		account_id: 'acc-checking',
		name: 'Total Checking',
		official_name: 'Chase Total Checking',
		mask: '4321',
		type: 'depository',
		subtype: 'checking',
		balances: { current: 1284.12, available: 1200.0, limit: null, iso_currency_code: 'USD' }
	},
	{
		account_id: 'acc-brokerage',
		name: 'Individual',
		official_name: null,
		mask: '9876',
		type: 'investment',
		subtype: 'brokerage',
		balances: { current: 21847.9, available: null, limit: null, iso_currency_code: 'USD' }
	}
];

const TXNS = [
	{
		transaction_id: 'txn-1',
		account_id: 'acc-checking',
		// Plaid signs a debit positive; Abacus stores outflow negative.
		amount: 84.21,
		date: '2026-08-12',
		name: 'WHOLE FOODS MKT',
		merchant_name: 'Whole Foods',
		pending: false,
		personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' }
	},
	{
		transaction_id: 'txn-2',
		account_id: 'acc-checking',
		amount: -4625.0,
		date: '2026-08-15',
		name: 'PAYROLL DIRECT DEP',
		merchant_name: null,
		pending: false,
		personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_WAGES' }
	}
];

/**
 * A canned Plaid response, or an error one. `__httpStatus` is an explicit
 * marker because Plaid's own /item/get body contains a top-level `status`
 * field — keying off that would misread a perfectly normal response.
 */
type StubResponse = object | { __httpStatus: number; __body: unknown };

function plaidStub(overrides: Partial<Record<string, StubResponse>> = {}) {
	const calls: string[] = [];

	const bodies: Partial<Record<string, StubResponse>> = {
		'/item/get': {
			item: {
				item_id: 'item-1',
				institution_id: 'ins_1',
				consent_expiration_time: null,
				error: null,
				products: ['transactions']
			},
			status: { transactions: { last_successful_update: '2026-08-15T06:30:00Z' } }
		},
		'/institutions/get_by_id': { institution: { name: 'Chase' } },
		'/accounts/get': { accounts: ACCOUNTS },
		'/transactions/sync': {
			added: TXNS,
			modified: [],
			removed: [],
			next_cursor: 'cursor-1',
			has_more: false
		},
		'/investments/holdings/get': {
			accounts: ACCOUNTS,
			holdings: [
				{
					account_id: 'acc-brokerage',
					security_id: 'sec-vti',
					quantity: 512,
					institution_price: 290.15,
					institution_value: 148556.8,
					cost_basis: 120000
				}
			],
			securities: [{ security_id: 'sec-vti', ticker_symbol: 'VTI', name: 'Vanguard Total Stock' }]
		},
		'/investments/transactions/get': {
			investment_transactions: [],
			total_investment_transactions: 0,
			securities: []
		},
		...overrides
	};

	vi.stubGlobal('fetch', async (url: string) => {
		const path = new URL(url).pathname;
		calls.push(path);
		const body = bodies[path];
		if (body === undefined) throw new Error(`unstubbed Plaid endpoint ${path}`);
		const error = body as { __httpStatus?: number; __body?: unknown };
		return error?.__httpStatus
			? new Response(JSON.stringify(error.__body), { status: error.__httpStatus })
			: new Response(JSON.stringify(body), { status: 200 });
	});

	return calls;
}

let tmp: TempDb;

async function bootWithLinkedItem() {
	tmp = newTempDb('abacus-sync-');
	process.env.ABACUS_ENCRYPTION_KEY = KEY;
	process.env.PLAID_CLIENT_ID = 'test-client';
	process.env.PLAID_SECRET = 'test-secret';
	process.env.PLAID_ENV = 'production';

	vi.resetModules();
	const dbmod = await import('./db.ts');
	const sync = await import('./sync.ts');

	dbmod
		.db()
		.prepare(
			`INSERT INTO items (plaid_item_id, institution_id, institution_name, access_token_ct)
			 VALUES ('item-1', 'ins_1', 'Linked institution', ?)`
		)
		.run(sync.storeAccessToken('access-production-test'));

	return { db: dbmod.db, sync };
}

beforeEach(() => {
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
	removeTempDb(tmp);
});

describe('syncAll', () => {
	it('reports success for a healthy item', async () => {
		plaidStub();
		const { sync } = await bootWithLinkedItem();
		const result = await sync.syncAll();

		expect(result.status).toBe('ok');
		expect(result.results).toHaveLength(1);
		expect(result.results[0].ok).toBe(true);
	});

	it('writes accounts with balances in cents', async () => {
		plaidStub();
		const { db, sync } = await bootWithLinkedItem();
		await sync.syncAll();

		const rows = db()
			.prepare('SELECT external_id, name, type, current_cents FROM accounts ORDER BY external_id')
			.all() as Array<{ external_id: string; name: string; type: string; current_cents: number }>;

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ external_id: 'acc-brokerage', type: 'investment', current_cents: 2184790 });
		expect(rows[1]).toMatchObject({ external_id: 'acc-checking', type: 'depository', current_cents: 128412 });
	});

	it('inverts Plaid amount signs so outflow is negative', async () => {
		plaidStub();
		const { db, sync } = await bootWithLinkedItem();
		await sync.syncAll();

		const rows = db()
			.prepare('SELECT external_id, amount_cents FROM transactions ORDER BY external_id')
			.all() as Array<{ external_id: string; amount_cents: number }>;

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ external_id: 'txn-1', amount_cents: -8421 });
		expect(rows[1]).toMatchObject({ external_id: 'txn-2', amount_cents: 462500 });
	});

	it('is idempotent — a second run updates rather than duplicating', async () => {
		plaidStub();
		const { db, sync } = await bootWithLinkedItem();
		await sync.syncAll();
		await sync.syncAll();

		const counts = db()
			.prepare(
				`SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
				        (SELECT COUNT(*) FROM transactions) AS transactions,
				        (SELECT COUNT(*) FROM holdings) AS holdings`
			)
			.get() as { accounts: number; transactions: number; holdings: number };

		expect(counts).toEqual({ accounts: 2, transactions: 2, holdings: 1 });
	});

	it('records the transactions cursor only after the rows are written', async () => {
		plaidStub();
		const { db, sync } = await bootWithLinkedItem();
		await sync.syncAll();

		const item = db().prepare('SELECT transactions_cursor FROM items').get() as {
			transactions_cursor: string;
		};
		expect(item.transactions_cursor).toBe('cursor-1');
	});

	it('backfills the institution name left behind by a link-time failure', async () => {
		plaidStub();
		const { db, sync } = await bootWithLinkedItem();
		await sync.syncAll();

		const item = db().prepare('SELECT institution_name FROM items').get() as { institution_name: string };
		expect(item.institution_name).toBe('Chase');
	});

	it('stores holdings for investment accounts', async () => {
		plaidStub();
		const { db, sync } = await bootWithLinkedItem();
		await sync.syncAll();

		const holding = db().prepare('SELECT symbol, quantity, value_cents FROM holdings').get() as {
			symbol: string;
			quantity: number;
			value_cents: number;
		};
		expect(holding).toMatchObject({ symbol: 'VTI', quantity: 512, value_cents: 14855680 });
	});

	it('takes a balance snapshot so the net worth trend can start', async () => {
		plaidStub();
		const { db, sync } = await bootWithLinkedItem();
		await sync.syncAll();

		const { n } = db().prepare('SELECT COUNT(*) AS n FROM balance_snapshots').get() as { n: number };
		expect(n).toBe(2);
	});

	it('marks an item needing repair without failing the whole run', async () => {
		plaidStub({
			'/item/get': {
				item: {
					item_id: 'item-1',
					institution_id: 'ins_1',
					consent_expiration_time: null,
					error: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' },
					products: ['transactions']
				}
			}
		});
		const { db, sync } = await bootWithLinkedItem();
		const result = await sync.syncAll();

		expect(result.results[0].needsRepair).toBe(true);
		const item = db().prepare('SELECT status FROM items').get() as { status: string };
		expect(item.status).toBe('needs_repair');
	});

	it('succeeds when an institution does not expose investments', async () => {
		// A brokerage without the Investments product must not fail the run: its
		// balances and cash transactions are still worth having.
		plaidStub({
			'/investments/holdings/get': {
				__httpStatus: 400,
				__body: {
					error_code: 'PRODUCT_NOT_SUPPORTED',
					error_type: 'INVALID_REQUEST',
					error_message: 'investments is not supported'
				}
			}
		});
		const { db, sync } = await bootWithLinkedItem();
		const result = await sync.syncAll();

		expect(result.status).toBe('ok');
		expect(result.results[0].ok).toBe(true);

		const counts = db()
			.prepare(
				`SELECT (SELECT COUNT(*) FROM transactions) AS txns,
				        (SELECT COUNT(*) FROM holdings) AS holdings`
			)
			.get() as { txns: number; holdings: number };
		expect(counts).toEqual({ txns: 2, holdings: 0 });
	});

	it('reports a genuine Plaid failure instead of swallowing it', async () => {
		plaidStub({
			'/accounts/get': {
				__httpStatus: 500,
				__body: { error_code: 'INTERNAL_SERVER_ERROR', error_type: 'API_ERROR', error_message: 'boom' }
			}
		});
		const { sync } = await bootWithLinkedItem();
		const result = await sync.syncAll();

		expect(result.status).toBe('error');
		expect(result.results[0].ok).toBe(false);
	});
});
