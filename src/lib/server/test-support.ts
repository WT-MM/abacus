import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Shared setup for tests that need a real database.
 *
 * Deliberately free of any vitest import: this file sits under src/ and is
 * scanned and type-checked alongside the application. Callers invoke
 * `vi.resetModules()` themselves, since only they know when the module cache
 * needs clearing.
 */

export type TempDb = { dir: string; path: string };

/** A throwaway database, with the environment pointed at it. */
export function newTempDb(prefix = 'abacus-test-'): TempDb {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const path = join(dir, 'test.db');

	process.env.ABACUS_ENV_FILE = '/nonexistent';
	process.env.ABACUS_DB = path;

	return { dir, path };
}

export function removeTempDb(db: TempDb | undefined): void {
	if (db) rmSync(db.dir, { recursive: true, force: true });
}
