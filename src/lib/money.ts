// Every monetary value in Abacus is an integer number of cents. Floats never
// touch a balance; they appear only inside forecast maths, and are rounded back
// to cents at the boundary.

export type Cents = number;

export function toCents(amount: number): Cents {
	return Math.round(amount * 100);
}

const WHOLE = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	maximumFractionDigits: 0
});

const EXACT = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

/**
 * Accounting presentation: negatives are parenthesised rather than signed, the
 * convention every ledger this app ingests already uses.
 */
export function money(cents: Cents, opts: { exact?: boolean; parens?: boolean } = {}): string {
	const { exact = true, parens = true } = opts;
	const fmt = exact ? EXACT : WHOLE;
	const s = fmt.format(Math.abs(cents) / 100);
	if (cents < 0) return parens ? `(${s})` : `-${s}`;
	return s;
}

/** Compact form for dense tiles: $38.2k, $1.24M. */
export function moneyCompact(cents: Cents): string {
	const abs = Math.abs(cents) / 100;
	const sign = cents < 0 ? '-' : '';
	if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
	if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
	return `${sign}$${abs.toFixed(0)}`;
}

export function percent(ratio: number, digits = 1): string {
	return `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(digits)}%`;
}

/**
 * Parse user-entered money. Accepts "1,200.50", "$1200", "(45.10)" and "-45.10".
 * Returns null when the text is not a number at all.
 */
export function parseMoney(text: string): Cents | null {
	const t = text.trim();
	if (!t) return null;
	const negative = /^\(.*\)$/.test(t) || t.startsWith('-');
	const digits = t.replace(/[()$,\s-]/g, '');
	if (!/^\d*\.?\d*$/.test(digits) || digits === '' || digits === '.') return null;
	const value = Math.round(parseFloat(digits) * 100);
	return negative ? -value : value;
}
