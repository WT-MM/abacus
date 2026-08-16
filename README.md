# Abacus

A single-user personal finance ledger you host yourself, reachable only over
Tailscale. It pulls balances, transactions and investment holdings from your
banks and brokerages, gives you a spreadsheet to budget in, and projects where
the numbers are heading.

Built for one person on one server. There are no tenants, no analytics, no
outbound calls except the ones you configure.

---

## What it does

**Aggregates.** Chase, Fidelity and Wealthfront through Plaid — balances,
transactions, and investment holdings — synced once a day. Anything Plaid
cannot reach you can import from a CSV, OFX or QFX statement.

**Budgets, in cells.** The budget is an actual spreadsheet. Cells hold formulas,
reference each other, and recompute against what you really spent:

```
1200                     a literal
=SUM(B4:B9)              a range down the budget column
=B[Rent] * 1.05          reference another row by name
=PREV() * 1.03           this row, last month
=IF(C7 > B7, C7, B7)     branch on what actually happened
```

Columns are `B` budget, `C` actual, `D` remaining, `E` projected. `SUM`, `AVG`,
`MIN`, `MAX`, `ABS`, `ROUND`, `IF` and `PREV` are available. Circular references
report `#CYCLE` rather than hanging.

**Forecasts.** Five years of net worth from your current position, budget, and
assumptions you control — investment return, inflation, contributions, debt
paydown.

## One idea worth knowing

**Observed values are ink. Inferred values are brass.**

Every number the app *measured* renders in the foreground colour. Every number
it *modelled* — a run-rate projection, a forecast, the future half of the trend
line — renders in brass, dashed and lightly hatched. Mistaking an estimate for a
fact is the failure mode that actually costs money, so the distinction is
carried in the palette rather than a footnote.

The app is strict about this. A projection that equals the observed total is not
drawn in brass, because nothing was inferred.

## Security

The threat model is: a device on your tailnet is borrowed or compromised, or the
server's disk is stolen.

- **Two independent gates.** `tailscale serve` attaches a verified identity
  header, checked against an explicit owner allowlist — a tailnet can contain
  shared external users, so "has a valid identity" is not "is you". Then a
  WebAuthn passkey with user verification is required on top.
- **The server binds loopback only,** and refuses to start otherwise. Header
  trust is only sound because nothing but the local proxy can reach the port,
  so a misconfiguration fails to boot rather than silently exposing everything.
- **Plaid access tokens are encrypted at rest** with AES-256-GCM, a fresh nonce
  per record, and the purpose bound in as additional authenticated data.
- Sessions store only a hash. Passkey challenges are single-use and expire.
  Secrets are redacted before anything is logged or persisted. CSP is generated
  by SvelteKit with per-response nonces.
- An unrecognised caller gets a bare 404 — no hint that anything is here.

Balances and transactions themselves are stored in plain SQLite. If a stolen
disk is in your threat model, put it on an encrypted volume; encrypting only the
tokens would be security theatre.

## Cost

Free. Plaid's Trial plan covers ten Production Items with Transactions and
Investments included, and grants OAuth access to institutions such as Chase
without full production approval. Three institutions uses three of ten.

Those slots are consumed **permanently** — deleting an Item does not return one.
So reconnecting a broken institution goes through Plaid Link's *update mode*,
which repairs the existing Item in place. The UI only ever offers you that path.

## Stack

SvelteKit 2 · Svelte 5 · Node 26 · SQLite via the built-in `node:sqlite`

No ORM, no CSS framework, no native modules to compile, and no build step for
the sync process — Node 26 runs its TypeScript directly. Fonts are self-hosted
so the app makes no third-party requests at all beyond Plaid.

## Running it locally

```sh
pnpm install
cp .env.example .env          # set ABACUS_OWNERS and ABACUS_ENCRYPTION_KEY
node scripts/seed.ts          # optional: realistic demo data
pnpm dev
```

`ABACUS_DEV_USER` stands in for the Tailscale identity header in development.
It is ignored when `NODE_ENV=production`.

```sh
pnpm test          # 73 tests: formula engine, forecast maths, importers
pnpm check         # svelte-check
pnpm build         # production build
```

Deployment — systemd units, `tailscale serve`, Plaid redirect setup — is in
[`deploy/README.md`](deploy/README.md).

## Layout

```
src/lib/budget/formula.ts     the spreadsheet language: lexer, parser, evaluator
src/lib/forecast.ts           projection maths, pure and testable
src/lib/server/sync.ts        Plaid ingest: cursors, holdings, item health
src/lib/server/importers/     CSV and OFX parsing, column detection, dedupe
src/lib/server/auth/          Tailscale identity, passkeys, sessions
scripts/sync.ts               the daily sync, run as its own process
```

## Things that will bite you

- **Net worth history only exists going forward.** Plaid reports a current
  balance, not a series. The trend line is built from snapshots each sync takes,
  so it starts the day you connect and cannot be backfilled.
- **A connection breaking is routine.** Consent expires, logins change. Without
  a public URL there are no webhooks, so each sync calls `/item/get` and the app
  raises a banner. Reconnect from Accounts.
- **Run rates are not extrapolated from fewer than three transactions.** Rent
  charged once on the 3rd would otherwise project to double by mid-month.
- **`/transactions/sync` does not cover investment accounts.** Holdings and
  investment transactions come from separate endpoints with no cursor, so
  holdings are replaced wholesale and a wider reconciliation runs monthly.

## Licence

MIT
