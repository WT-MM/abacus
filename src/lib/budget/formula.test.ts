import { describe, it, expect } from 'vitest';
import { parseFormula, evaluateRow, safeEvaluateRow, FormulaError, type CellContext } from './formula.ts';

type Row = { name: string; budget: string; actual?: number; projected?: number; prev?: number };

/** Rows are 1-based, matching what the grid shows in its row gutter. */
function ctxOf(rows: Row[]): CellContext {
	return {
		rowCount: rows.length,
		rowByName: (name) => {
			const i = rows.findIndex((r) => r.name.toLowerCase() === name.toLowerCase());
			return i === -1 ? undefined : i + 1;
		},
		rawBudget: (row) => rows[row - 1]?.budget ?? '',
		actual: (row) => rows[row - 1]?.actual ?? 0,
		projected: (row) => rows[row - 1]?.projected ?? 0,
		prevBudget: (row) => rows[row - 1]?.prev ?? 0
	};
}

/** The three-row sheet most cases below build on. */
const SHEET: Row[] = [
	{ name: 'Rent', budget: '2400', actual: 2400 },
	{ name: 'Groceries', budget: '600', actual: 412 },
	{ name: 'Dining', budget: '300', actual: 388 }
];

/** SHEET plus a fourth row holding `budget`, evaluated. */
const withTotal = (budget: string) => evaluateRow(4, ctxOf([...SHEET, { name: 'Total', budget }]));

describe('parseFormula', () => {
	it('treats a bare number as a literal', () => {
		expect(parseFormula('1200')).toEqual({ kind: 'num', value: 1200 });
	});

	it('strips currency formatting from literals', () => {
		expect(parseFormula('$1,200.50')).toEqual({ kind: 'num', value: 1200.5 });
	});

	it('returns null for an empty cell', () => {
		expect(parseFormula('   ')).toBeNull();
	});

	it('rejects non-numeric literals', () => {
		expect(() => parseFormula('abc')).toThrow(FormulaError);
	});

	it('rejects a range spanning two columns', () => {
		expect(() => parseFormula('=SUM(B3:C9)')).toThrow(/span/);
	});
});

describe('arithmetic', () => {
	it.each([
		['honours operator precedence', '=1000 * 1.03 + 50', 1080],
		['applies unary minus', '=-(200+50)', -250],
		['treats a parenthesised group as one term', '=(100+50)*2', 300]
	])('%s', (_label, budget, expected) => {
		expect(evaluateRow(1, ctxOf([{ name: 'X', budget }]))).toBeCloseTo(expected, 6);
	});
});

describe('column references', () => {
	it('resolves a named row reference', () => {
		const rows = [...SHEET.slice(0, 2), { name: 'Dining', budget: '=B[Groceries] / 2', actual: 388 }];
		expect(evaluateRow(3, ctxOf(rows))).toBe(300);
	});

	it.each([
		['budget, by index', '=B2', 600],
		['actual', '=C2', 412],
		['remaining, derived as budget minus actual', '=D2', 188],
		['projected', '=E2', 640]
	])('reads %s', (_label, budget, expected) => {
		const rows: Row[] = [{ name: 'Probe', budget }, { ...SHEET[1], projected: 640 }];
		expect(evaluateRow(1, ctxOf(rows))).toBe(expected);
	});
});

describe('functions', () => {
	it.each([
		['sums a range', '=SUM(B1:B3)', 3300],
		['sums a range addressed by name', '=SUM(B[Rent]:B[Dining])', 3300],
		// A range containing the total row must not recurse into itself.
		['excludes the writing row from a self-spanning range', '=SUM(B1:B4)', 3300],
		['averages a range', '=AVG(B1:B3)', 1100],
		['takes a minimum', '=MIN(B1:B3)', 300],
		['takes a maximum over the actual column', '=MAX(C1:C3)', 2400],
		['sums across two ranges', '=SUM(B1:B2, B3:B3)', 3300]
	])('%s', (_label, budget, expected) => {
		expect(withTotal(budget)).toBe(expected);
	});

	it('rounds to a given precision', () => {
		expect(evaluateRow(1, ctxOf([{ name: 'X', budget: '=ROUND(10/3, 2)' }]))).toBe(3.33);
	});

	it('branches on a comparison', () => {
		const c = ctxOf([{ name: 'Dining', budget: '=IF(C1 > 350, C1, 300)', actual: 388 }]);
		expect(evaluateRow(1, c)).toBe(388);
	});

	it('reads the previous month through PREV', () => {
		expect(evaluateRow(1, ctxOf([{ name: 'X', budget: '=PREV()*1.05', prev: 1000 }]))).toBeCloseTo(1050, 6);
	});
});

describe('error reporting', () => {
	it.each([
		['division by zero', '=100/0', '#DIV/0'],
		['unknown category name', '=B[Nope]', '#NAME?'],
		['row past the end of the sheet', '=B99', '#NAME?'],
		['unknown function', '=NOPE(1)', '#NAME?'],
		['malformed syntax', '=1 +', '#SYNTAX'],
		['direct self-reference', '=B1+1', '#CYCLE'],
		// D1 is budget-minus-actual for this same row, so it loops back into B1.
		['cycle reached through the derived remaining column', '=D1', '#CYCLE']
	])('reports %s as %s', (_label, budget, code) => {
		expect(safeEvaluateRow(1, ctxOf([{ name: 'X', budget }])).error).toBe(code);
	});

	it('detects an indirect cycle across three rows', () => {
		const c = ctxOf([
			{ name: 'A', budget: '=B2' },
			{ name: 'B', budget: '=B3' },
			{ name: 'C', budget: '=B1' }
		]);
		expect(safeEvaluateRow(1, c).error).toBe('#CYCLE');
	});

	it('leaves a valid cell unflagged', () => {
		expect(safeEvaluateRow(1, ctxOf([{ name: 'X', budget: '=2+2' }]))).toEqual({ value: 4 });
	});
});
