// OFX/QFX is SGML, not XML: tags are frequently unclosed, so a real parser is
// the wrong tool. Chase's QFX and Fidelity's OFX both fall out of this shape.

export type OfxTransaction = {
	id: string | null;
	date: string; // YYYY-MM-DD
	amountCents: number;
	description: string;
	memo: string | null;
	type: string | null;
};

function tag(block: string, name: string): string | null {
	// Value runs to the next tag or end of block, closed or not.
	const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
	return m ? m[1].trim() : null;
}

/** OFX dates are YYYYMMDD with an optional time and bracketed timezone. */
export function parseOfxDate(raw: string | null): string | null {
	if (!raw) return null;
	const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function parseOfx(text: string): OfxTransaction[] {
	const out: OfxTransaction[] = [];
	const blocks = text.split(/<STMTTRN>/i).slice(1);

	for (const raw of blocks) {
		const block = raw.split(/<\/STMTTRN>/i)[0];
		const date = parseOfxDate(tag(block, 'DTPOSTED'));
		const amount = tag(block, 'TRNAMT');
		if (!date || amount === null) continue;

		const name = tag(block, 'NAME');
		const memo = tag(block, 'MEMO');
		out.push({
			id: tag(block, 'FITID'),
			date,
			// OFX signs debits negative already, matching how Abacus stores them.
			amountCents: Math.round(parseFloat(amount) * 100),
			description: name || memo || 'Imported transaction',
			memo,
			type: tag(block, 'TRNTYPE')
		});
	}

	return out;
}
