import { json, error, type RequestHandler } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { db } from '$lib/server/db.ts';

let running: ReturnType<typeof spawn> | null = null;

/**
 * Runs the sync in a child process rather than inline.
 *
 * node:sqlite is synchronous, so a long sync executed here would block the
 * event loop and freeze every other request for its duration.
 */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.auth.verified) throw error(404, 'Not found');
	if (running) return json({ started: false, message: 'A sync is already running' });

	const child = spawn(process.execPath, ['scripts/sync.ts'], {
		cwd: process.cwd(),
		env: process.env,
		stdio: 'ignore',
		detached: false
	});

	running = child;
	child.on('exit', () => {
		running = null;
	});

	return json({ started: true });
};

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.auth.verified) throw error(404, 'Not found');

	const run = db()
		.prepare('SELECT started_at, finished_at, status FROM sync_runs ORDER BY id DESC LIMIT 1')
		.get() as { started_at: string; finished_at: string | null; status: string } | undefined;

	return json({ running: Boolean(running), lastRun: run ?? null });
};
