#!/bin/sh
# Retry policy for launchd, which has no equivalent of systemd's
# StartLimitBurst or RestartPreventExitStatus.
#
# launchd is configured with KeepAlive={SuccessfulExit:false}, meaning it
# restarts the job whenever it exits non-zero — for ever, with no cap. So the
# policy lives here instead: this wrapper exits 0 to tell launchd to stop, and
# non-zero only while it still wants to be restarted.
#
# The trade-off is that a job which has given up shows a last exit status of 0
# in `launchctl list`, so the log is the place to look. On Linux the systemd
# units express all of this natively and leave the unit in a failed state,
# which is why Ubuntu is the recommended target.
#
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
