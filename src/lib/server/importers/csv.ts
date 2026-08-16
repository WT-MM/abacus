/** RFC 4180 CSV: quoted fields, doubled quotes, embedded newlines and commas. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let i = 0;

	// Strip a UTF-8 BOM; Chase and Fidelity both emit one and it would otherwise
	// become part of the first header name.
	const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

	const endField = () => {
		row.push(field);
		field = '';
	};
	const endRow = () => {
		endField();
		if (row.some((c) => c.trim() !== '')) rows.push(row);
		row = [];
	};

	while (i < src.length) {
		const ch = src[i];

		if (quoted) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}

		if (ch === '"') {
			quoted = true;
			i++;
		} else if (ch === ',') {
			endField();
			i++;
		} else if (ch === '\r') {
			i++;
		} else if (ch === '\n') {
			endRow();
			i++;
		} else {
			field += ch;
			i++;
		}
	}

	if (field !== '' || row.length) endRow();
	return rows;
}
