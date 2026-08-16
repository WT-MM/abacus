import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let mod: typeof import('./portfolio.ts');
let conn: import('node:sqlite').DatabaseSync;

async function boot() {
	dir = mkdtempSync(join(tmpdir(), 'abacus-pf-'));
	process.env.ABACUS_ENV_FILE = '/nonexistent';
	process.env.ABACUS_DB = join(dir, 'test.db');

	vi.resetModules();
	const dbmod = await import('./db.ts');
	mod = await import('./portfolio.ts');
	conn = dbmod.db();
}

function account(id: number, name: string, type: string, cents: number, hidden = 0) {
	conn
		.prepare(
			`INSERT INTO accounts (id, source, external_id, name, institution_name, type, current_cents, hidden)
			 VALUES (?, 'plaid', ?, ?, 'Fidelity', ?, ?, ?)`
		)
		.run(id, `ext-${id}`, name, type, cents, hidden);
}

function holding(accountId: number, symbol: string, qty: number, value: number, basis: number | null) {
	conn
		.prepare(
			`INSERT INTO holdings (account_id, security_id, symbol, name, quantity, price_cents, value_cents, cost_basis_cents, as_of)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-08-16')`
		)
		.run(accountId, `${accountId}-${symbol}`, symbol, `${symbol} fund`, qty, Math.round(value / qty), value, basis);
}

beforeEach(boot);
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('portfolio', () => {
	it('is empty without holdings', () => {
		const p = mod.portfolio();
		expect(p.holdings).toEqual([]);
		expect(p.holdingsValueCents).toBe(0);
		expect(p.gainCents).toBeNull();
	});

	it('totals holdings and computes weights', () => {
		account(1, 'Brokerage', 'investment', 30_000_00);
		holding(1, 'VTI', 100, 20_000_00, 15_000_00);
		holding(1, 'VXUS', 50, 10_000_00, 9_000_00);

		const p = mod.portfolio();
		expect(p.holdingsValueCents).toBe(30_000_00);
		expect(p.holdings.map((h) => h.symbol)).toEqual(['VTI', 'VXUS']); // ordered by value
		expect(p.holdings[0].weight).toBeCloseTo(2 / 3, 5);
		expect(p.holdings[1].weight).toBeCloseTo(1 / 3, 5);
	});

	it('reports gain against cost basis', () => {
		account(1, 'Brokerage', 'investment', 30_000_00);
		holding(1, 'VTI', 100, 20_000_00, 15_000_00);

		const p = mod.portfolio();
		expect(p.gainCents).toBe(5_000_00);
	});

	it('excludes holdings with no basis from the gain rather than treating basis as zero', () => {
		// Counting a missing basis as zero would report the entire position as gain.
		account(1, 'Brokerage', 'investment', 30_000_00);
		holding(1, 'VTI', 100, 20_000_00, 15_000_00);
		holding(1, 'UNKN', 10, 10_000_00, null);

		const p = mod.portfolio();
		expect(p.gainCents).toBe(5_000_00);
		expect(p.holdings.find((h) => h.symbol === 'UNKN')?.gainCents).toBeNull();
	});

	it('surfaces the gap between securities and the account balance', () => {
		// Uninvested cash: the balance exceeds what the holdings account for.
		account(1, 'Brokerage', 'investment', 32_500_00);
		holding(1, 'VTI', 100, 30_000_00, 25_000_00);

		const p = mod.portfolio();
		expect(p.investmentBalanceCents).toBe(32_500_00);
		expect(p.uninvestedCents).toBe(2_500_00);
	});

	it('counts only investment accounts in the balance', () => {
		account(1, 'Brokerage', 'investment', 30_000_00);
		account(2, 'Checking', 'depository', 5_000_00);
		expect(mod.portfolio().investmentBalanceCents).toBe(30_000_00);
	});

	it('ignores hidden accounts on both sides', () => {
		account(1, 'Brokerage', 'investment', 30_000_00);
		account(2, 'Old IRA', 'investment', 9_000_00, 1);
		holding(2, 'OLD', 10, 9_000_00, 8_000_00);

		const p = mod.portfolio();
		expect(p.investmentBalanceCents).toBe(30_000_00);
		expect(p.holdings).toEqual([]);
	});
});

describe('byAccount', () => {
	it('groups and orders by value', () => {
		account(1, 'Small', 'investment', 1_000_00);
		account(2, 'Large', 'investment', 50_000_00);
		holding(1, 'A', 1, 1_000_00, null);
		holding(2, 'B', 1, 50_000_00, null);

		const groups = mod.byAccount(mod.portfolio().holdings);
		expect(groups.map((g) => g.label)).toEqual(['Fidelity · Large', 'Fidelity · Small']);
		expect(groups[0].valueCents).toBe(50_000_00);
	});
});
