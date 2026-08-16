/**
 * A small spreadsheet language for budget cells.
 *
 * Only the Budget column (B) holds formulas. Actual (C) and Projected (E) are
 * observed data, and Remaining (D) is derived as B - C. That asymmetry is what
 * keeps evaluation acyclic in practice: a formula can read any column, but only
 * column B can ever recurse.
 *
 * Numbers are dollars, because that is what a person types. Rounding to cents
 * happens once, at the boundary in budget.ts.
 *
 *   1200                 literal
 *   =1200*1.03           arithmetic
 *   =SUM(B4:B9)          range over the budget column
 *   =B[Rent] + B[Utilities]
 *   =PREV()*1.05         this row, last month
 *   =IF(C7 > B7, C7, B7) overspend-aware
 */

export type Ast =
	| { kind: 'num'; value: number }
	| { kind: 'cell'; col: Col; row: RowSel }
	| { kind: 'range'; col: Col; from: RowSel; to: RowSel }
	| { kind: 'call'; name: string; args: Ast[] }
	| { kind: 'unary'; op: '-'; operand: Ast }
	| { kind: 'binary'; op: BinOp; left: Ast; right: Ast };

export type Col = 'B' | 'C' | 'D' | 'E';
export type RowSel = { kind: 'index'; index: number } | { kind: 'name'; name: string };
type BinOp = '+' | '-' | '*' | '/' | '>' | '<' | '>=' | '<=' | '=' | '<>';

export type FormulaErrorCode = '#SYNTAX' | '#NAME?' | '#CYCLE' | '#DIV/0' | '#ERR';

// Fields are declared and assigned rather than using parameter properties,
// which Node's strip-only TypeScript mode cannot compile. scripts/sync.ts
// imports this tree directly under bare Node, so that matters here.
export class FormulaError extends Error {
	code: FormulaErrorCode;

	constructor(code: FormulaErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

// ---------------------------------------------------------------- tokenizer

type Token =
	| { t: 'num'; v: number }
	| { t: 'cell'; col: Col; row: RowSel }
	| { t: 'ident'; v: string }
	| { t: 'op'; v: string }
	| { t: 'eof' };

const CELL_RE = /^([A-E])(\d+|\[[^\]]+\])/;
const NUM_RE = /^\d+(\.\d+)?|^\.\d+/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const OPS = ['>=', '<=', '<>', '+', '-', '*', '/', '(', ')', ',', ':', '>', '<', '='];

function rowSel(raw: string): RowSel {
	if (raw.startsWith('[')) return { kind: 'name', name: raw.slice(1, -1).trim() };
	return { kind: 'index', index: parseInt(raw, 10) };
}

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let s = src;
	while (s.length) {
		if (/^\s/.test(s)) {
			s = s.replace(/^\s+/, '');
			continue;
		}
		// Cell refs are matched before identifiers so that B3 and B[Rent] do not
		// tokenize as the identifier "B".
		const cell = CELL_RE.exec(s);
		if (cell) {
			out.push({ t: 'cell', col: cell[1] as Col, row: rowSel(cell[2]) });
			s = s.slice(cell[0].length);
			continue;
		}
		const num = NUM_RE.exec(s);
		if (num) {
			out.push({ t: 'num', v: parseFloat(num[0]) });
			s = s.slice(num[0].length);
			continue;
		}
		const ident = IDENT_RE.exec(s);
		if (ident) {
			out.push({ t: 'ident', v: ident[0].toUpperCase() });
			s = s.slice(ident[0].length);
			continue;
		}
		const op = OPS.find((o) => s.startsWith(o));
		if (op) {
			out.push({ t: 'op', v: op });
			s = s.slice(op.length);
			continue;
		}
		throw new FormulaError('#SYNTAX', `Unexpected character "${s[0]}"`);
	}
	out.push({ t: 'eof' });
	return out;
}

// ------------------------------------------------------------------- parser

class Parser {
	private i = 0;
	private readonly toks: Token[];

	constructor(toks: Token[]) {
		this.toks = toks;
	}

	private peek(): Token {
		return this.toks[this.i];
	}

	private eat(op: string): boolean {
		const t = this.peek();
		if (t.t === 'op' && t.v === op) {
			this.i++;
			return true;
		}
		return false;
	}

	private expect(op: string): void {
		if (!this.eat(op)) throw new FormulaError('#SYNTAX', `Expected "${op}"`);
	}

	parse(): Ast {
		const node = this.comparison();
		if (this.peek().t !== 'eof') throw new FormulaError('#SYNTAX', 'Trailing input');
		return node;
	}

	private comparison(): Ast {
		let left = this.additive();
		for (;;) {
			const t = this.peek();
			if (t.t === 'op' && ['>', '<', '>=', '<=', '=', '<>'].includes(t.v)) {
				this.i++;
				left = { kind: 'binary', op: t.v as BinOp, left, right: this.additive() };
			} else return left;
		}
	}

	private additive(): Ast {
		let left = this.multiplicative();
		for (;;) {
			if (this.eat('+')) left = { kind: 'binary', op: '+', left, right: this.multiplicative() };
			else if (this.eat('-')) left = { kind: 'binary', op: '-', left, right: this.multiplicative() };
			else return left;
		}
	}

	private multiplicative(): Ast {
		let left = this.unary();
		for (;;) {
			if (this.eat('*')) left = { kind: 'binary', op: '*', left, right: this.unary() };
			else if (this.eat('/')) left = { kind: 'binary', op: '/', left, right: this.unary() };
			else return left;
		}
	}

	private unary(): Ast {
		if (this.eat('-')) return { kind: 'unary', op: '-', operand: this.unary() };
		if (this.eat('+')) return this.unary();
		return this.primary();
	}

	private primary(): Ast {
		const t = this.peek();

		if (t.t === 'num') {
			this.i++;
			return { kind: 'num', value: t.v };
		}

		if (t.t === 'cell') {
			this.i++;
			if (this.eat(':')) {
				const end = this.peek();
				if (end.t !== 'cell') throw new FormulaError('#SYNTAX', 'Range end must be a cell');
				if (end.col !== t.col) throw new FormulaError('#SYNTAX', 'Ranges cannot span columns');
				this.i++;
				return { kind: 'range', col: t.col, from: t.row, to: end.row };
			}
			return { kind: 'cell', col: t.col, row: t.row };
		}

		if (t.t === 'ident') {
			this.i++;
			const args: Ast[] = [];
			if (this.eat('(')) {
				if (!this.eat(')')) {
					do {
						args.push(this.comparison());
					} while (this.eat(','));
					this.expect(')');
				}
			}
			return { kind: 'call', name: t.v, args };
		}

		if (this.eat('(')) {
			const inner = this.comparison();
			this.expect(')');
			return inner;
		}

		throw new FormulaError('#SYNTAX', 'Unexpected end of formula');
	}
}

/** `=1200*1.03` or a bare `1200`. Returns null for an empty cell. */
export function parseFormula(input: string): Ast | null {
	const raw = input.trim();
	if (!raw) return null;
	if (!raw.startsWith('=')) {
		const n = Number(raw.replace(/[$,]/g, ''));
		if (Number.isNaN(n)) throw new FormulaError('#SYNTAX', `"${raw}" is not a number`);
		return { kind: 'num', value: n };
	}
	return new Parser(tokenize(raw.slice(1))).parse();
}

// ---------------------------------------------------------------- evaluator

export interface CellContext {
	rowCount: number;
	/** 1-based row for a category name, case-insensitive. */
	rowByName(name: string): number | undefined;
	/** Raw contents of the Budget column for a row. */
	rawBudget(row: number): string;
	/** Observed spend for a row, in dollars. */
	actual(row: number): number;
	/** Projected month-end spend for a row, in dollars. Independent of B. */
	projected(row: number): number;
	/** Previous month's resolved budget for a row, in dollars. */
	prevBudget(row: number): number;
}

function resolveRow(sel: RowSel, ctx: CellContext): number {
	if (sel.kind === 'index') {
		if (sel.index < 1 || sel.index > ctx.rowCount) {
			throw new FormulaError('#NAME?', `Row ${sel.index} is out of range`);
		}
		return sel.index;
	}
	const row = ctx.rowByName(sel.name);
	if (!row) throw new FormulaError('#NAME?', `No category named "${sel.name}"`);
	return row;
}

/**
 * Evaluates the Budget column for `row`. `stack` carries the chain of rows
 * currently being evaluated so a self-referential formula reports #CYCLE
 * instead of overflowing the call stack.
 */
export function evaluateRow(row: number, ctx: CellContext, stack: number[] = []): number {
	if (stack.includes(row)) throw new FormulaError('#CYCLE', `Row ${row} refers to itself`);
	const ast = parseFormula(ctx.rawBudget(row));
	if (!ast) return 0;
	return evaluate(ast, ctx, row, [...stack, row]);
}

function columnValue(col: Col, row: number, ctx: CellContext, stack: number[]): number {
	switch (col) {
		case 'B':
			return evaluateRow(row, ctx, stack);
		case 'C':
			return ctx.actual(row);
		case 'D':
			return evaluateRow(row, ctx, stack) - ctx.actual(row);
		case 'E':
			return ctx.projected(row);
	}
}

function evaluate(node: Ast, ctx: CellContext, self: number, stack: number[]): number {
	switch (node.kind) {
		case 'num':
			return node.value;

		case 'cell':
			return columnValue(node.col, resolveRow(node.row, ctx), ctx, stack);

		case 'range':
			throw new FormulaError('#SYNTAX', 'A range is only valid inside a function');

		case 'unary':
			return -evaluate(node.operand, ctx, self, stack);

		case 'binary': {
			const l = evaluate(node.left, ctx, self, stack);
			const r = evaluate(node.right, ctx, self, stack);
			switch (node.op) {
				case '+':
					return l + r;
				case '-':
					return l - r;
				case '*':
					return l * r;
				case '/':
					if (r === 0) throw new FormulaError('#DIV/0', 'Division by zero');
					return l / r;
				case '>':
					return l > r ? 1 : 0;
				case '<':
					return l < r ? 1 : 0;
				case '>=':
					return l >= r ? 1 : 0;
				case '<=':
					return l <= r ? 1 : 0;
				case '=':
					return l === r ? 1 : 0;
				case '<>':
					return l !== r ? 1 : 0;
			}
		}

		case 'call':
			return callFn(node, ctx, self, stack);
	}
}

function expand(arg: Ast, ctx: CellContext, self: number, stack: number[]): number[] {
	if (arg.kind === 'range') {
		const from = resolveRow(arg.from, ctx);
		const to = resolveRow(arg.to, ctx);
		const [lo, hi] = from <= to ? [from, to] : [to, from];
		const values: number[] = [];
		for (let r = lo; r <= hi; r++) {
			// A range that contains its own row would otherwise recurse forever;
			// skipping self is what makes =SUM(B1:B20) usable in a total row.
			if (r === self && arg.col === 'B') continue;
			values.push(columnValue(arg.col, r, ctx, stack));
		}
		return values;
	}
	return [evaluate(arg, ctx, self, stack)];
}

function callFn(node: Extract<Ast, { kind: 'call' }>, ctx: CellContext, self: number, stack: number[]): number {
	const flat = () => node.args.flatMap((a) => expand(a, ctx, self, stack));

	switch (node.name) {
		case 'SUM':
			return flat().reduce((a, b) => a + b, 0);
		case 'AVG': {
			const v = flat();
			if (!v.length) return 0;
			return v.reduce((a, b) => a + b, 0) / v.length;
		}
		case 'MIN': {
			const v = flat();
			return v.length ? Math.min(...v) : 0;
		}
		case 'MAX': {
			const v = flat();
			return v.length ? Math.max(...v) : 0;
		}
		case 'ABS':
			return Math.abs(evaluate(node.args[0], ctx, self, stack));
		case 'ROUND': {
			const value = evaluate(node.args[0], ctx, self, stack);
			const digits = node.args[1] ? evaluate(node.args[1], ctx, self, stack) : 0;
			const f = 10 ** digits;
			return Math.round(value * f) / f;
		}
		case 'IF': {
			if (node.args.length < 3) throw new FormulaError('#SYNTAX', 'IF needs three arguments');
			return evaluate(node.args[0], ctx, self, stack)
				? evaluate(node.args[1], ctx, self, stack)
				: evaluate(node.args[2], ctx, self, stack);
		}
		case 'PREV': {
			const row = node.args.length ? resolveRow({ kind: 'index', index: evaluate(node.args[0], ctx, self, stack) }, ctx) : self;
			return ctx.prevBudget(row);
		}
		default:
			throw new FormulaError('#NAME?', `Unknown function ${node.name}`);
	}
}

/** Never throws — the grid renders the error code in the cell instead. */
export function safeEvaluateRow(row: number, ctx: CellContext): { value: number; error?: string } {
	try {
		const value = evaluateRow(row, ctx);
		if (!Number.isFinite(value)) return { value: 0, error: '#ERR' };
		return { value };
	} catch (err) {
		if (err instanceof FormulaError) return { value: 0, error: err.code };
		return { value: 0, error: '#ERR' };
	}
}
