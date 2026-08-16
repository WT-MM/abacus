import { describe, it, expect } from 'vitest';
import { project, monthsToTarget, DEFAULT_ASSUMPTIONS, type Position } from './forecast.ts';

const START: Position = { cashCents: 1_000_000, investmentsCents: 10_000_000, debtCents: -500_000 };
const FLAT = { ...DEFAULT_ASSUMPTIONS, investmentReturn: 0, expenseInflation: 0 };

describe('project', () => {
	it('advances the month label across a year boundary', () => {
		const points = project(START, '2026-11', 3, 0, 0, FLAT);
		expect(points.map((p) => p.month)).toEqual(['2026-12', '2027-01', '2027-02']);
	});

	it('adds the monthly surplus to cash', () => {
		const [first] = project(START, '2026-08', 1, 500_000, 300_000, FLAT);
		expect(first.cashCents).toBe(1_000_000 + 200_000);
	});

	it('compounds investment returns monthly', () => {
		const points = project({ cashCents: 0, investmentsCents: 10_000_000, debtCents: 0 }, '2026-08', 12, 0, 0, {
			...FLAT,
			investmentReturn: 0.12
		});
		// 1% a month compounded twelve times is ~12.68%, not 12%.
		expect(points[11].investmentsCents).toBeGreaterThan(11_260_000);
		expect(points[11].investmentsCents).toBeLessThan(11_275_000);
	});

	it('moves contributions out of cash rather than creating them', () => {
		const [p] = project({ cashCents: 500_000, investmentsCents: 0, debtCents: 0 }, '2026-08', 1, 0, 0, {
			...FLAT,
			monthlyContributionCents: 200_000
		});
		expect(p.cashCents).toBe(300_000);
		expect(p.investmentsCents).toBe(200_000);
		expect(p.netWorthCents).toBe(500_000);
	});

	it('never contributes more cash than is on hand', () => {
		const [p] = project({ cashCents: 50_000, investmentsCents: 0, debtCents: 0 }, '2026-08', 1, 0, 0, {
			...FLAT,
			monthlyContributionCents: 200_000
		});
		expect(p.investmentsCents).toBe(50_000);
		expect(p.cashCents).toBe(0);
	});

	it('pays debt down without overshooting the balance', () => {
		const points = project({ cashCents: 10_000_000, investmentsCents: 0, debtCents: -300_000 }, '2026-08', 4, 0, 0, {
			...FLAT,
			debtPaydownCents: 200_000
		});
		expect(points.map((p) => p.debtCents)).toEqual([-100_000, 0, 0, 0]);
	});

	it('grows expenses with inflation', () => {
		const points = project(START, '2026-08', 12, 0, 1_000_000, { ...FLAT, expenseInflation: 0.12 });
		expect(points[11].expenseCents).toBeGreaterThan(1_120_000);
	});

	it('keeps net worth as cash plus investments minus debt', () => {
		for (const p of project(START, '2026-08', 6, 800_000, 400_000, DEFAULT_ASSUMPTIONS)) {
			expect(p.netWorthCents).toBe(p.cashCents + p.investmentsCents + p.debtCents);
		}
	});
});

describe('monthsToTarget', () => {
	const points = project({ cashCents: 0, investmentsCents: 0, debtCents: 0 }, '2026-08', 12, 100_000, 0, FLAT);

	it('finds the first month that clears the target', () => {
		expect(monthsToTarget(points, 300_000)).toBe(3);
	});

	it('returns null when the target is out of reach', () => {
		expect(monthsToTarget(points, 99_000_000)).toBeNull();
	});
});
