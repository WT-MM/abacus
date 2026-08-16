import { describe, it, expect } from 'vitest';
import { projectedCents, shiftMonth, monthKey } from './budget.ts';

const AUG = '2026-08';
const midAugust = new Date('2026-08-15T12:00:00Z'); // 15 of 31 days elapsed

describe('projectedCents', () => {
	it('extrapolates a run rate once there are enough transactions', () => {
		// 30,000 over 15 days of a 31-day month.
		expect(projectedCents({ total: 30_000, count: 12 }, AUG, midAugust)).toBe(62_000);
	});

	it.each([
		['a single charge', 1],
		['two charges', 2]
	])('does not extrapolate %s', (_label, count) => {
		// Rent billed once on the 3rd would otherwise project to double by mid-month.
		expect(projectedCents({ total: 285_000, count }, AUG, midAugust)).toBe(285_000);
	});

	it('reports a finished month at its actual total', () => {
		expect(projectedCents({ total: 41_000, count: 20 }, '2026-07', midAugust)).toBe(41_000);
	});

	it('stops extrapolating on the last day of the month', () => {
		expect(projectedCents({ total: 55_000, count: 20 }, AUG, new Date('2026-08-31T12:00:00Z'))).toBe(55_000);
	});

	it('treats an untouched category as zero', () => {
		expect(projectedCents(undefined, AUG, midAugust)).toBe(0);
	});
});

describe('shiftMonth', () => {
	it.each([
		[AUG, 1, '2026-09'],
		[AUG, -1, '2026-07'],
		['2026-12', 1, '2027-01'],
		['2026-01', -1, '2025-12'],
		[AUG, -12, '2025-08']
	])('%s shifted by %i is %s', (month, delta, expected) => {
		expect(shiftMonth(month, delta)).toBe(expected);
	});
});

describe('monthKey', () => {
	it('formats a date as YYYY-MM', () => {
		expect(monthKey(new Date('2026-08-15T12:00:00Z'))).toBe('2026-08');
	});
});
