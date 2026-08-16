import { db } from './db.ts';

export type Variable = {
	name: string; // upper-cased key
	label: string; // as typed
	value: number;
	note: string | null;
};

/**
 * Function names the formula language already owns. A variable called SUM
 * could never be referenced — the evaluator would resolve the function first —
 * so it is rejected at definition time rather than silently ignored later.
 */
const RESERVED = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'ABS', 'ROUND', 'IF', 'PREV']);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name the tokenizer would read as a cell reference, e.g. B3, and never as a variable. */
const LOOKS_LIKE_CELL = /^[A-Ea-e]\d/;

export class VariableError extends Error {}

export function normaliseName(label: string): string {
	const trimmed = label.trim();

	if (!trimmed) throw new VariableError('Give the variable a name');
	if (!IDENTIFIER.test(trimmed)) {
		throw new VariableError(
			`"${trimmed}" is not usable in a formula. Use letters, digits and underscores, starting with a letter — for example avg_meal_cost.`
		);
	}
	if (LOOKS_LIKE_CELL.test(trimmed)) {
		throw new VariableError(
			`"${trimmed}" reads as a cell reference in a formula, so it could never be looked up. Pick another name.`
		);
	}

	const key = trimmed.toUpperCase();
	if (RESERVED.has(key)) {
		throw new VariableError(`"${trimmed}" is a built-in function name. Pick another name.`);
	}
	return key;
}

export function listVariables(): Variable[] {
	return db()
		.prepare('SELECT name, label, value, note FROM variables ORDER BY label')
		.all() as Variable[];
}

/** Every variable as an upper-cased lookup map, for the formula evaluator. */
export function variableMap(): Map<string, number> {
	return new Map(listVariables().map((v) => [v.name, v.value]));
}

export function upsertVariable(label: string, value: number, note?: string | null): void {
	const name = normaliseName(label);
	if (!Number.isFinite(value)) throw new VariableError('Give the variable a number');

	db()
		.prepare(
			`INSERT INTO variables (name, label, value, note) VALUES (?, ?, ?, ?)
			 ON CONFLICT(name) DO UPDATE SET
			   label = excluded.label, value = excluded.value, note = excluded.note`
		)
		.run(name, label.trim(), value, note?.trim() || null);
}

export function deleteVariable(name: string): void {
	db().prepare('DELETE FROM variables WHERE name = ?').run(name.toUpperCase());
}

/**
 * Budget cells that mention a variable, so removing one cannot silently break
 * a sheet. Matched on word boundaries — a naive substring search would report
 * `meals` as used by a formula that only mentions `meals_per_week`.
 */
export function formulasUsing(name: string): Array<{ month: string; category: string }> {
	const key = name.toUpperCase();
	const rows = db()
		.prepare(
			`SELECT b.month, c.name AS category, b.formula
			   FROM budget_cells b JOIN categories c ON c.id = b.category_id
			  WHERE b.formula LIKE '=%'
			  ORDER BY b.month DESC`
		)
		.all() as Array<{ month: string; category: string; formula: string }>;

	const pattern = new RegExp(`(^|[^A-Za-z0-9_])${key}([^A-Za-z0-9_]|$)`, 'i');
	return rows.filter((r) => pattern.test(r.formula)).map(({ month, category }) => ({ month, category }));
}
