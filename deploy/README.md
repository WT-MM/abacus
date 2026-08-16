# Deploying Abacus

Assumes a Linux server already on your tailnet with Node 22.5+ (24 or newer
recommended) and `tailscaled` running.

> Handing this to a coding agent on the server? Point it at
> [`AGENT-DEPLOY.md`](AGENT-DEPLOY.md) instead. Same deployment, written for an
> agent with no prior context: explicit verification after each step, the rules
> it must not break, and the three points where it has to stop and ask you.

## 1. Put the app on the server

```sh
sudo useradd --system --home /opt/abacus --shell /usr/sbin/nologin abacus
sudo mkdir -p /opt/abacus /var/lib/abacus /etc/abacus
sudo chown abacus:abacus /var/lib/abacus

git clone https://github.com/WT-MM/abacus /opt/abacus
cd /opt/abacus
pnpm install --prod=false
pnpm build
sudo chown -R abacus:abacus /opt/abacus
```

## 2. Expose it over Tailscale

`tailscale serve` terminates TLS with a real certificate for your tailnet
hostname and proxies to loopback. That certificate is what makes WebAuthn and
Plaid's OAuth redirect work at all — both require https.

```sh
sudo tailscale serve --bg --https 443 http://127.0.0.1:3000
tailscale serve status      # note the https://<host>.<tailnet>.ts.net URL
```

Do **not** run `tailscale funnel`. That publishes the app to the open internet,
and the whole auth model assumes only your tailnet can reach the port.

## 3. Secrets

```sh
sudo install -m 600 -o root -g root /dev/null /etc/abacus/secrets.env
sudo tee /etc/abacus/secrets.env >/dev/null <<EOF
ABACUS_ENCRYPTION_KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=production
EOF
```

Back the encryption key up somewhere other than the database backup. Losing it
means relinking every institution; storing the two together means one stolen
backup gives up both.

## 4. Install the units

Edit `abacus.service` and `abacus-sync.service` first: set `ORIGIN`,
`ABACUS_ORIGIN` and `ABACUS_OWNERS` to your real tailnet URL and login.

```sh
sudo cp deploy/abacus.service deploy/abacus-sync.service deploy/abacus-sync.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now abacus.service abacus-sync.timer
systemctl status abacus
```

`HOST=127.0.0.1` is set in the unit and is not optional — the app refuses to
start otherwise, because binding a public interface would let anything that can
route to the port forge a Tailscale identity header.

## 5. First run

Open the https URL from a device with a passkey authenticator and choose
**Create a passkey**. From then on, reaching the tailnet is not sufficient;
a passkey is required too.

Register a second passkey from Settings straight away. With only one, losing
that device locks you out of the ledger.

## 6. Connect institutions

In the Plaid dashboard, add your exact tailnet URL plus `/link/oauth` as an
allowed redirect URI — for example
`https://abacus.your-tailnet.ts.net/link/oauth`. OAuth banks such as Chase
redirect the browser there, so it must match character for character.

Then **Accounts → Connect an institution**.

## Operating notes

- **Sync**: `sudo systemctl start abacus-sync` runs it now.
  `journalctl -u abacus-sync -n 50` shows the last run.
- **A connection breaking is normal.** Consent expires and logins change. The
  app surfaces it as a banner; use **Reconnect**, which repairs the existing
  connection through Link update mode. Never delete and relink — Plaid's free
  tier consumes an Item slot permanently and never returns it, so you get ten
  connections for the lifetime of the account, not ten at a time.
- **Backups**: stop the service, copy `/var/lib/abacus/abacus.db*` (all three
  files — the WAL and shm matter), start it again. Or use
  `sqlite3 abacus.db ".backup /path/backup.db"` while it runs.
- **Staleness**: without a public URL there are no webhooks, so the timer is the
  only thing keeping data fresh. The sidebar shows a warning after two days
  without a successful sync, and `abacus-sync` exits non-zero when every
  institution fails, so `OnFailure=` can page you if you want that.
