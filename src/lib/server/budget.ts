import { db } from './db.ts';
import { safeEvaluateRow, type CellContext } from '../budget/formula.ts';

export type BudgetRow = {
	row: number;
	categoryId: number;
	name: string;
	kind: 'income' | 'expense';
	group: string | null;
	formula: string;
	budgetCents: number;
	actualCents: number;
	remainingCents: number;
	projectedCents: number;
	error?: string;
};

export type BudgetGrid = {
	month: string;
	rows: BudgetRow[];
	totals: { income: number; expense: number; net: number; projectedExpense: number; projectedNet: number };
};

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export function shiftMonth(month: string, delta: number): string {
	const [y, m] = month.split('-').map(Number);
	const d = new Date(Date.UTC(y, m - 1 + delta, 1));
	return d.toISOString().slice(0, 7);
}

function monthBounds(month: string): { start: string; end: string; days: number } {
	const [y, m] = month.split('-').map(Number);
	const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
	return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, '0')}`, days };
}

type CategoryRow = { id: number; name: string; kind: string; grp: string | null };

function categories(): CategoryRow[] {
	return db()
		.prepare(`SELECT id, name, kind, grp FROM categories WHERE archived = 0 AND kind <> 'transfer' ORDER BY sort, id`)
		.all() as CategoryRow[];
}

/**
 * Observed spend per category for a month, as a positive magnitude.
 *
 * Transactions store outflow as negative; a budget sheet reads better when
 * "spent 412 of 600" are both positive, so expenses are flipped here and income
 * is left alone.
 */
type Observed = { total: number; count: number };

function actuals(month: string): Map<number, Observed> {
	const { start, end } = monthBounds(month);
	const rows = db()
		.prepare(
			`SELECT t.category_id AS id, c.kind AS kind,
			        SUM(t.amount_cents) AS total, COUNT(*) AS n
			   FROM transactions t
			   JOIN categories c ON c.id = t.category_id
			  WHERE t.posted_on BETWEEN ? AND ?
			    AND t.is_transfer = 0
			  GROUP BY t.category_id, c.kind`
		)
		.all(start, end) as Array<{ id: number; kind: string; total: number; n: number }>;

	const out = new Map<number, Observed>();
	for (const r of rows) {
		out.set(r.id, { total: r.kind === 'expense' ? -r.total : r.total, count: r.n });
	}
	return out;
}

// Below this many transactions in a month, a run rate is noise rather than a
// trend, and extrapolating it is actively misleading: rent charged once on the
// 3rd would project to double by mid-month. Such categories are reported at
// what they have actually spent.
const MIN_SAMPLES_TO_EXTRAPOLATE = 3;

/**
 * Month-end estimate from the run rate so far. This is inference, not
 * observation — the UI renders it in brass to keep the distinction visible.
 */
export function projectedCents(observed: Observed | undefined, month: string, now = new Date()): number {
	if (!observed) return 0;

	if (monthKey(now) !== month) return observed.total; // A finished month needs no projection.
	if (observed.count < MIN_SAMPLES_TO_EXTRAPOLATE) return observed.total;

	const { days } = monthBounds(month);
	const elapsed = Math.max(1, now.getUTCDate());
	if (elapsed >= days) return observed.total;

	return Math.round((observed.total / elapsed) * days);
}

function formulas(month: string): Map<number, string> {
	const rows = db()
		.prepare('SELECT category_id, formula FROM budget_cells WHERE month = ?')
		.all(month) as Array<{ category_id: number; formula: string }>;
	return new Map(rows.map((r) => [r.category_id, r.formula]));
}

// A chain of =PREV() formulas would otherwise walk backwards without end.
const MAX_LOOKBACK = 12;

export function buildGrid(month: string, lookback = MAX_LOOKBACK): BudgetGrid {
	const cats = categories();
	const cells = formulas(month);
	const actual = actuals(month);

	const byName = new Map(cats.map((c, i) => [c.name.toLowerCase(), i + 1]));
	const actualOf = (row: number) => (actual.get(cats[row - 1]?.id)?.total ?? 0) / 100;

	let prevGrid: BudgetGrid | null = null;
	const prevOf = (row: number): number => {
		if (lookback <= 0) return 0;
		prevGrid ??= buildGrid(shiftMonth(month, -1), lookback - 1);
		return (prevGrid.rows[row - 1]?.budgetCents ?? 0) / 100;
	};

	const ctx: CellContext = {
		rowCount: cats.length,
		rowByName: (name) => byName.get(name.toLowerCase()),
		rawBudget: (row) => cells.get(cats[row - 1]?.id) ?? '',
		actual: actualOf,
		projected: (row) => projectedCents(actual.get(cats[row - 1]?.id), month) / 100,
		prevBudget: prevOf
	};

	const rows: BudgetRow[] = cats.map((c, i) => {
		const row = i + 1;
		const { value, error } = safeEvaluateRow(row, ctx);
		const budgetCents = Math.round(value * 100);
		const actualCents = actual.get(c.id)?.total ?? 0;
		return {
			row,
			categoryId: c.id,
			name: c.name,
			kind: c.kind as 'income' | 'expense',
			group: c.grp,
			formula: cells.get(c.id) ?? '',
			budgetCents,
			actualCents,
			remainingCents: budgetCents - actualCents,
			projectedCents: projectedCents(actual.get(c.id), month),
			error
		};
	});

	const sum = (pred: (r: BudgetRow) => boolean, pick: (r: BudgetRow) => number) =>
		rows.filter(pred).reduce((a, r) => a + pick(r), 0);

	const income = sum((r) => r.kind === 'income', (r) => r.budgetCents);
	const expense = sum((r) => r.kind === 'expense', (r) => r.budgetCents);
	const projectedExpense = sum((r) => r.kind === 'expense', (r) => r.projectedCents);

	return {
		month,
		rows,
		totals: { income, expense, net: income - expense, projectedExpense, projectedNet: income - projectedExpense }
	};
}

export function setCell(month: string, categoryId: number, formula: string): void {
	const raw = formula.trim();
	if (!raw) {
		db().prepare('DELETE FROM budget_cells WHERE month = ? AND category_id = ?').run(month, categoryId);
		return;
	}
	db()
		.prepare(
			`INSERT INTO budget_cells (month, category_id, formula) VALUES (?, ?, ?)
			 ON CONFLICT(month, category_id) DO UPDATE SET formula = excluded.formula`
		)
		.run(month, categoryId, raw);
}

/** Copies a month's formulas forward, so a new month starts from the last one. */
export function copyMonth(from: string, to: string): number {
	const rows = db().prepare('SELECT category_id, formula FROM budget_cells WHERE month = ?').all(from) as Array<{
		category_id: number;
		formula: string;
	}>;
	for (const r of rows) setCell(to, r.category_id, r.formula);
	return rows.length;
}
