/**
 * Process exit codes, following sysexits.h.
 *
 * These exist so the init system can tell apart failures that are worth
 * retrying from ones that will fail identically forever. A misconfigured
 * encryption key does not become correct on the fourth restart; an institution
 * that needs reconnecting does not fix itself either. Both should stop and be
 * visible, rather than loop and fill the journal.
 *
 * The service units key `RestartPreventExitStatus` off CONFIG and
 * NEEDS_ATTENTION, so changing these values means changing the units too.
 */
export const EXIT = {
	OK: 0,

	/** EX_DATAERR — a human has to act. Retrying changes nothing. */
	NEEDS_ATTENTION: 65,

	/** EX_TEMPFAIL — transient (network, Plaid outage). Worth retrying. */
	TEMPFAIL: 75,

	/** EX_CONFIG — bad configuration. Will fail identically on every restart. */
	CONFIG: 78
} as const;
