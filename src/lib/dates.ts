// Dates in Abacus are calendar dates, not instants: "2026-08" is a month and
// "2026-08-15" is a day, neither of which has a timezone.
//
// Formatting them without pinning to UTC shifts every label backwards in any
// negative-offset zone, so an August budget renders as "July". Every date
// formatter in the app goes through here.

const UTC = { timeZone: 'UTC' } as const;

/** "2026-08" → "August 2026". */
export function monthLabel(month: string): string {
	return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', {
		...UTC,
		month: 'long',
		year: 'numeric'
	});
}

/** "2026-08" → "Aug 26", for axis ticks and dense tables. */
export function monthShort(month: string): string {
	return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', {
		...UTC,
		month: 'short',
		year: '2-digit'
	});
}

/** "2026-08-15" → "Aug 15". */
export function dayLabel(date: string): string {
	return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
		...UTC,
		month: 'short',
		day: 'numeric'
	});
}

/** "2026-08-15" → "Aug 15, 26". */
export function dayLabelWithYear(date: string): string {
	return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
		...UTC,
		month: 'short',
		day: 'numeric',
		year: '2-digit'
	});
}
