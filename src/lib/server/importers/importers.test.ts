import { describe, it, expect } from 'vitest';
import { parseCsv } from './csv.ts';
import { parseOfx, parseOfxDate } from './ofx.ts';
import { parseStatement, parseDate } from './index.ts';

describe('parseCsv', () => {
	it('handles quoted fields containing commas', () => {
		expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
	});

	it('unescapes doubled quotes', () => {
		expect(parseCsv('a,"say ""hi""",c')).toEqual([['a', 'say "hi"', 'c']]);
	});

	it('keeps newlines inside quoted fields', () => {
		expect(parseCsv('a,"line1\nline2"')).toEqual([['a', 'line1\nline2']]);
	});

	it('strips a UTF-8 BOM from the first header', () => {
		expect(parseCsv('﻿Date,Amount')[0][0]).toBe('Date');
	});

	it('drops blank rows', () => {
		expect(parseCsv('a,b\n\n\nc,d')).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});
});

describe('parseDate', () => {
	it.each([
		['2026-08-15', '2026-08-15'],
		['08/15/2026', '2026-08-15'],
		['8/5/2026', '2026-08-05'],
		['08/15/26', '2026-08-15']
	])('parses %s', (input, expected) => {
		expect(parseDate(input)).toBe(expected);
	});

	it('rejects nonsense', () => {
		expect(parseDate('not a date')).toBeNull();
	});
});

describe('institution exports', () => {
	// Chase credit card activity export. Charges are already negative.
	const CHASE_CREDIT = [
		'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
		'08/12/2026,08/13/2026,"WHOLE FOODS MKT",Groceries,Sale,-84.21,',
		'08/01/2026,08/02/2026,"AUTOMATIC PAYMENT - THANK YOU",,Payment,1240.00,'
	].join('\n');

	// Chase checking export: different header names, a running balance column.
	const CHASE_CHECKING = [
		'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
		'DEBIT,08/14/2026,"CITY UTILITIES WEB PMT",-142.55,ACH_DEBIT,8214.33,',
		'CREDIT,08/15/2026,"PAYROLL DIRECT DEP",4200.00,ACH_CREDIT,12414.33,'
	].join('\n');

	// Fidelity history export, preceded by a title line before the header.
	const FIDELITY = [
		'Brokerage',
		'',
		'Run Date,Account,Action,Symbol,Description,Type,Quantity,Price ($),Amount ($)',
		'08/11/2026,Z12345678,"YOU BOUGHT VANGUARD",VTI,VANGUARD TOTAL,Cash,10,290.15,-2901.50',
		'08/05/2026,Z12345678,"DIVIDEND RECEIVED",VTI,VANGUARD TOTAL,Cash,,,142.88'
	].join('\n');

	it('reads a Chase credit export and keeps sign convention', () => {
		const p = parseStatement(CHASE_CREDIT, 'chase.csv');
		expect(p.institution).toBe('Chase');
		expect(p.rows).toHaveLength(2);
		expect(p.rows[0]).toMatchObject({ date: '2026-08-12', amountCents: -8421 });
		expect(p.rows[1].amountCents).toBe(124000);
	});

	it('reads a Chase checking export despite different headers', () => {
		const p = parseStatement(CHASE_CHECKING, 'chk.csv');
		expect(p.rows.map((r) => r.amountCents)).toEqual([-14255, 420000]);
		expect(p.columns.date).toBe('Posting Date');
	});

	it('skips preamble lines to find the real header', () => {
		const p = parseStatement(FIDELITY, 'fidelity.csv');
		expect(p.institution).toBe('Fidelity');
		expect(p.rows).toHaveLength(2);
		expect(p.rows[0].amountCents).toBe(-290150);
		expect(p.rows[1].amountCents).toBe(14288);
	});

	it('counts unparseable rows instead of failing the whole file', () => {
		const p = parseStatement(`${CHASE_CREDIT}\n,,,,,,\ngarbage,row,here,,,,`, 'chase.csv');
		expect(p.rows).toHaveLength(2);
		expect(p.skipped).toBe(1);
	});

	it('refuses a file with no date column', () => {
		expect(() => parseStatement('foo,bar\n1,2', 'x.csv')).toThrow(/date column/);
	});
});

describe('OFX', () => {
	const QFX = `
OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260814120000[-5:EST]<TRNAMT>-142.55<FITID>202608140001<NAME>CITY UTILITIES</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260815<TRNAMT>4200.00<FITID>202608150002<NAME>PAYROLL<MEMO>DIRECT DEP</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

	it('parses unclosed SGML tags', () => {
		const txns = parseOfx(QFX);
		expect(txns).toHaveLength(2);
		expect(txns[0]).toMatchObject({ date: '2026-08-14', amountCents: -14255, description: 'CITY UTILITIES' });
		expect(txns[1].amountCents).toBe(420000);
	});

	it('carries the FITID through as an external id', () => {
		expect(parseOfx(QFX)[0].id).toBe('202608140001');
	});

	it('strips the timezone suffix from a date', () => {
		expect(parseOfxDate('20260814120000[-5:EST]')).toBe('2026-08-14');
	});

	it('routes an OFX file by content even with a .csv name', () => {
		expect(parseStatement(QFX, 'mislabelled.csv').format).toBe('ofx');
	});
});
