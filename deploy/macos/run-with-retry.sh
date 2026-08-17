#!/bin/sh
# Retry policy for launchd, which has no StartLimitBurst or
# RestartPreventExitStatus. KeepAlive={SuccessfulExit:false} restarts on any
# non-zero exit for ever, so the cap lives here: exiting 0 tells launchd to
# stop. A job that gave up therefore reports exit 0 to `launchctl list`; the
# log is the place to look. Details in deploy/README.md.
#   usage: run-with-retry.sh <command> [args...]

set -u

attempts=${ABACUS_MAX_ATTEMPTS:-3}
delay=${ABACUS_RETRY_DELAY:-5}
n=1

while :; do
	"$@"
	code=$?

	[ "$code" -eq 0 ] && exit 0

	# 78 EX_CONFIG, 65 EX_DATAERR. A bad key does not become good on the third
	# try, and an institution needing reconnection needs a browser, not a retry.
	if [ "$code" -eq 78 ] || [ "$code" -eq 65 ]; then
		echo "abacus: exit $code will not change on retry — giving up (see the log above)" >&2
		exit 0
	fi

	if [ "$n" -ge "$attempts" ]; then
		echo "abacus: giving up after $n attempt(s), last exit $code" >&2
		exit 0
	fi

	echo "abacus: attempt $n failed with exit $code, retrying in ${delay}s" >&2
	n=$((n + 1))
	sleep "$delay"
done
