import { getMeta } from './db.ts';
import { DEFAULT_ASSUMPTIONS, type Assumptions } from '../forecast.ts';

/**
 * Forecast assumptions, persisted as JSON in the meta table.
 *
 * Merged over the defaults so that a key added in a later version does not read
 * as undefined for anyone who saved their settings before it existed.
 */
export function loadAssumptions(): Assumptions {
	const raw = getMeta('forecast.assumptions');
	if (!raw) return DEFAULT_ASSUMPTIONS;
	try {
		return { ...DEFAULT_ASSUMPTIONS, ...JSON.parse(raw) };
	} catch {
		return DEFAULT_ASSUMPTIONS;
	}
}
