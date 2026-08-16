# Agent deployment runbook

You are deploying **Abacus**, a single-user personal finance ledger, onto this
machine. Work through this file in order. It assumes you have no prior context.

Read the whole file before running anything — the ordering constraint in step 3
will waste your time if you discover it late.

---

## What this app is, and why the details matter

Abacus holds every bank balance and transaction its owner has. It is reached
only over Tailscale. Its authentication works like this:

1. `tailscale serve` terminates TLS and attaches a verified
   `Tailscale-User-Login` header to each request.
2. The app checks that header against an explicit owner allowlist.
3. The app additionally requires a WebAuthn passkey.

**Step 1 is only trustworthy because nothing except the local proxy can reach
the app's port.** If the app listens on a public interface, anything that can
route to it can send a forged `Tailscale-User-Login` header and read every
balance. The app refuses to start unless bound to loopback. That guard is
deliberate.

---

## Rules — do not violate these

- **Never run `tailscale funnel`.** It publishes the app to the open internet
  and destroys the security model. Only `tailscale serve`.
- **Never set `HOST` to anything but `127.0.0.1`,** and never edit or bypass the
  loopback guard in `src/hooks.server.ts`. If the app refuses to start because
  of it, the configuration is wrong — fix the configuration.
- **Never put secrets in `/etc/systemd/system/*.service`.** Unit files are
  world-readable. Secrets go in `/etc/abacus/secrets.env`, mode 600, root-owned.
- **Never print the encryption key or the Plaid secret** into terminal output,
  logs, or a commit. Generate the key with a command that writes it straight to
  the file (step 5 does this).
- **Never `git commit` anything from this deployment.** You are deploying, not
  developing.
- **Do not invent the tailnet hostname.** Read it from `tailscale status`.
  A wrong `ORIGIN` silently breaks both passkey login and bank OAuth.

## Three things you cannot do — stop and ask the human

1. **Plaid dashboard signup and API keys** (step 4). Requires a human account
   and identity verification.
2. **Registering the Plaid redirect URI** (step 4). Human, in a browser.
3. **Creating the passkey** (step 9). Requires biometric hardware and human
   presence.

Everything else is yours. When you hit one of these, stop, print exactly what
you need, and wait.

---

## Step 1 — Preflight

Run these and report the results before proceeding.

```sh
node --version          # need >= 22.5 for node:sqlite; see the TS check below
pnpm --version || corepack enable pnpm
tailscale status --peers=false
systemctl --version
command -v node
```

**If `node` is older than 22.5**, stop — `node:sqlite` does not exist and the
app cannot run. Install Node 24 LTS or newer and re-run preflight.

**Functional TypeScript check.** The daily sync unit runs `node scripts/sync.ts`
with no build step, relying on Node's native type stripping. Version numbers are
a poor proxy for whether that works, so test it directly:

```sh
printf 'const n: number = 1;\nconsole.log("ts-ok", n);\n' > /tmp/tscheck.ts
node /tmp/tscheck.ts; rm -f /tmp/tscheck.ts
```

- Prints `ts-ok 1` → nothing to do.
- Errors about TypeScript syntax → you are on a Node that needs the flag. In
  step 7 you must change `abacus-sync.service`'s ExecStart to
  `ExecStart=<node> --experimental-strip-types scripts/sync.ts`.
  **Record this now** — if you forget, the web app works fine and the daily
  sync silently never runs.

Note the absolute path from `command -v node`. The shipped unit files assume
`/usr/bin/node`; if yours differs (nvm, `/usr/local/bin`, Nix), you will patch
both units in step 7.

## Step 2 — Get the code

The repository is **private**. If `gh auth status` does not show an account with
access to `WT-MM/abacus`, stop and ask the human to run `gh auth login` — it is
interactive and you cannot complete it.

```sh
sudo useradd --system --home /opt/abacus --shell /usr/sbin/nologin abacus 2>/dev/null || true
sudo mkdir -p /opt/abacus /var/lib/abacus /etc/abacus
sudo chown abacus:abacus /var/lib/abacus

gh repo clone WT-MM/abacus /tmp/abacus-src
sudo cp -r /tmp/abacus-src/. /opt/abacus/
cd /opt/abacus
pnpm install                 # devDependencies are required to build
pnpm build
sudo chown -R abacus:abacus /opt/abacus
```

`pnpm build` must end with `✔ done`. If it does not, stop and report the error —
do not proceed with a broken build.

## Step 3 — Tailscale, before anything else

**Ordering constraint:** you need the tailnet hostname before you can set
`ORIGIN` (step 6) or register the Plaid redirect URI (step 4). Do this first.

```sh
sudo tailscale serve --bg --https 443 http://127.0.0.1:3000
tailscale serve status
```

`tailscale serve status` prints the public URL it is now serving — read the
hostname from there. That is authoritative; do not try to assemble it from
`tailscale status --json`, where `Self` is not reliably the first `DNSName` in
the document and you will silently pick up a peer's name instead.

Your origin is `https://<host>.<tailnet>.ts.net` — no trailing slash, no port.

Record it. Call it **`ORIGIN_URL`** for the rest of this runbook, and report it
to the human — they need it for the next step.

## Step 4 — Human: Plaid

Stop here. Print this to the human and wait for them to come back with two
values:

> I need you to do three things in the Plaid dashboard:
>
> 1. Sign up at dashboard.plaid.com if you have not. A brand-new team
>    automatically qualifies for the free **Trial plan** (10 Items, includes
>    Transactions and Investments, and grants OAuth access to Chase without full
>    production approval).
> 2. **Team Settings → Keys** — send me the `client_id` and the **Production**
>    secret. Not the Sandbox secret.
> 3. **Team Settings → API → Allowed redirect URIs** — add exactly:
>    `<ORIGIN_URL>/link/oauth`
>    Character for character, no trailing slash. Chase's OAuth handoff fails
>    with an unhelpful error if this does not match.

If the human wants to defer Plaid, that is fine — the app runs without it, with
sync disabled and CSV/OFX import still working. Leave `PLAID_CLIENT_ID` and
`PLAID_SECRET` empty and carry on.

## Step 5 — Secrets

`ABACUS_ENCRYPTION_KEY` encrypts the Plaid access tokens at rest. Generate it
directly into the file so it never appears in your terminal output or scrollback:

```sh
sudo touch /etc/abacus/secrets.env
sudo chmod 600 /etc/abacus/secrets.env
sudo chown root:root /etc/abacus/secrets.env

sudo sh -c 'printf "ABACUS_ENCRYPTION_KEY=%s\n" \
  "$(node -e "console.log(require(\"node:crypto\").randomBytes(32).toString(\"base64\"))")' \
  >> /etc/abacus/secrets.env
```

Then append the Plaid values from step 4 (use an editor, or a heredoc — do not
echo them into a shell command that gets logged):

```
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=production
```

Verify without revealing values:

```sh
sudo grep -c '=' /etc/abacus/secrets.env      # expect 4 (or 1 if Plaid deferred)
sudo stat -c '%a %U' /etc/abacus/secrets.env  # expect 600 root
```

**Tell the human to back this key up separately from the database.** Losing it
means relinking every institution, which consumes Plaid Item slots that are
never returned. Storing it in the same backup as the database means one stolen
backup gives up both.

## Step 6 — Configure the units

Edit `/opt/abacus/deploy/abacus.service` and set these three to your real values
(`ORIGIN` and `ABACUS_ORIGIN` are both required and must be identical):

```
Environment=ORIGIN=<ORIGIN_URL>
Environment=ABACUS_ORIGIN=<ORIGIN_URL>
Environment=ABACUS_OWNERS=<the human's exact tailnet login>
```

`tailscale status` shows the owner of this node in the third column of its
first line (for example `wesley@`), but that is often truncated to the local
part. **Confirm the full login with the human rather than guessing** — it is the
address they sign in to Tailscale with.

**It must be exact.** A tailnet can contain shared external
users, and Serve sends identity headers for them too, so this allowlist is the
thing standing between "anyone on the tailnet" and "the owner".

`abacus-sync.service` needs no origin, but confirm its `ABACUS_DB` matches.

## Step 7 — Patch paths, then install the units

If `command -v node` was not `/usr/bin/node`, fix both units. If the step 1
TypeScript check failed, add the flag to the sync unit at the same time:

```sh
NODE_BIN=$(command -v node)
sudo sed -i "s|^ExecStart=/usr/bin/node|ExecStart=$NODE_BIN|" \
  /opt/abacus/deploy/abacus.service /opt/abacus/deploy/abacus-sync.service

# ONLY if the step 1 TypeScript check failed:
# sudo sed -i "s|scripts/sync.ts|--experimental-strip-types scripts/sync.ts|" \
#   /opt/abacus/deploy/abacus-sync.service
```

```sh
sudo cp /opt/abacus/deploy/abacus.service \
        /opt/abacus/deploy/abacus-sync.service \
        /opt/abacus/deploy/abacus-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now abacus.service abacus-sync.timer
```

## Step 8 — Verify before declaring anything

Run all of these. Every one must pass.

```sh
systemctl is-active abacus                    # active
journalctl -u abacus -n 20 --no-pager         # "Listening on http://127.0.0.1:3000"
```

The listening address **must** say `127.0.0.1`, not `0.0.0.0`. If it says
`0.0.0.0`, `HOST` is not reaching the process — fix it, do not continue.

Now exercise the auth gates locally. These send a forged identity header on
purpose; that they work from the box is exactly why loopback-only binding
matters.

```sh
# No identity — must be 404, revealing nothing
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/

# Wrong identity — must be 404
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Tailscale-User-Login: nobody@example.com' http://127.0.0.1:3000/

# Owner identity, no passkey yet — must be 303 to /auth
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  -H "Tailscale-User-Login: <owner login>" http://127.0.0.1:3000/

# Security headers present
curl -s -D- -o /dev/null -H "Tailscale-User-Login: <owner login>" \
  http://127.0.0.1:3000/auth | grep -iE 'content-security-policy|strict-transport'
```

Expected: `404`, `404`, `303 .../auth?next=%2F`, and a CSP containing a
`'nonce-...'` in `script-src`.

**If the owner-identity request returns 404**, `ABACUS_OWNERS` does not match
the login you sent. That is the single most common misconfiguration.

Finally confirm the timer:

```sh
systemctl list-timers abacus-sync --no-pager
```

## Step 9 — Human: first login

Stop. Tell the human:

> Open `<ORIGIN_URL>` on a device with a passkey authenticator and choose
> **Create a passkey**. Then go to **Settings → Add a passkey** and register a
> second one on a different device. With only one, losing that device locks you
> out of the ledger permanently — the app will not let you delete your last
> passkey, but it cannot help if the device is gone.
>
> Then **Accounts → Connect an institution** for each of Chase, Fidelity and
> Wealthfront.

## Step 10 — First sync

Once the human confirms institutions are linked, do not wait for the 06:30
timer:

```sh
sudo systemctl start abacus-sync
journalctl -u abacus-sync -n 40 --no-pager
```

Expect one `ok <institution> <n> records` line per institution and a final
`sync ok`. A `FAIL` line names the institution and reason.

Tell the human the net worth chart will show a single point at first. Plaid
reports a current balance, not a history, so the trend is built from snapshots
taken at each sync and cannot be backfilled.

---

## Failure modes and what they mean

| Symptom | Cause |
|---|---|
| Service exits with "Refusing to start: HOST is …" | The loopback guard. `HOST=127.0.0.1` is missing from the unit. Fix the unit; never the guard. |
| Owner request returns 404 | `ABACUS_OWNERS` does not exactly match the Tailscale login. |
| Every form POST rejected as cross-site | `ORIGIN` does not match the URL the browser is using. |
| Passkey registration fails with an opaque error | `ABACUS_ORIGIN` wrong, so the WebAuthn RP ID is wrong. |
| Chase OAuth returns to a blank page | The redirect URI in the Plaid dashboard does not exactly equal `<ORIGIN_URL>/link/oauth`. |
| Web app fine, data never updates | The sync unit is failing. Very likely the Node TypeScript issue from step 1. Check `journalctl -u abacus-sync`. |
| An institution shows "needs reconnecting" | Normal. Consent expires. The human uses **Reconnect** in the UI, which repairs the existing connection. **Never delete and relink** — Plaid's free tier consumes an Item slot permanently and only 10 exist for the lifetime of the account. |

## Report back

When done, tell the human:

- The `ORIGIN_URL` they should bookmark
- Output of the four verification curls
- Whether the sync unit needed the `--experimental-strip-types` flag
- That the encryption key is at `/etc/abacus/secrets.env` and **needs a backup
  stored separately from the database**
- Backup procedure: stop the service, copy `/var/lib/abacus/abacus.db*` — all
  three files, the `-wal` and `-shm` matter — then start it again. Or
  `sqlite3 abacus.db ".backup /path/backup.db"` while running.

Do not report success until every check in step 8 has actually passed. If
something is unresolved, say which step and what you saw.
