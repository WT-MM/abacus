// Generated from the schema DDL. Kept as a TypeScript module rather than a
// .sql file so that it is bundled into the production build: a readFileSync
// of a sibling .sql file resolves in dev and then ENOENTs after `vite build`.

export const SCHEMA = `-- Abacus schema. Applied idempotently at startup by db.ts.
-- Money is stored as integer cents throughout. Balances are stored exactly as
-- the source reported them; sign normalisation for net worth is derived at read
-- time from account.type, so the stored row always matches the statement.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per institution login. On the Plaid Trial plan an Item slot is
-- consumed permanently -- deleting an Item does NOT return the slot -- so
-- repairs go through Link update mode, never a fresh link.
CREATE TABLE IF NOT EXISTS items (
  id                     INTEGER PRIMARY KEY,
  plaid_item_id          TEXT NOT NULL UNIQUE,
  institution_id         TEXT,
  institution_name       TEXT NOT NULL,
  access_token_ct        TEXT NOT NULL,
  transactions_cursor    TEXT,
  consent_expires_at     TEXT,
  last_successful_update TEXT,
  last_synced_at         TEXT,
  status                 TEXT NOT NULL DEFAULT 'ok',   -- ok | needs_repair | error
  error_code             TEXT,
  error_message          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id               INTEGER PRIMARY KEY,
  item_id          INTEGER REFERENCES items(id) ON DELETE CASCADE,
  source           TEXT NOT NULL,               -- plaid | import
  external_id      TEXT,
  name             TEXT NOT NULL,
  official_name    TEXT,
  mask             TEXT,
  institution_name TEXT,
  type             TEXT NOT NULL,               -- depository | credit | investment | loan | other
  subtype          TEXT,
  currency         TEXT NOT NULL DEFAULT 'USD',
  current_cents    INTEGER NOT NULL DEFAULT 0,
  available_cents  INTEGER,
  limit_cents      INTEGER,
  balance_as_of    TEXT,
  hidden           INTEGER NOT NULL DEFAULT 0,
  closed           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_external
  ON accounts(source, external_id) WHERE external_id IS NOT NULL;

-- Daily net-worth history. Plaid reports only a current balance, so the trend
-- line is something this app accumulates; it cannot be backfilled after the fact.
CREATE TABLE IF NOT EXISTS balance_snapshots (
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  on_date       TEXT NOT NULL,                  -- YYYY-MM-DD
  current_cents INTEGER NOT NULL,
  PRIMARY KEY (account_id, on_date)
);

CREATE TABLE IF NOT EXISTS categories (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  kind     TEXT NOT NULL DEFAULT 'expense',     -- income | expense | transfer
  grp      TEXT,
  sort     INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

-- amount_cents is normalised so that negative means money left the account and
-- positive means money arrived. Plaid's own convention is the opposite; the
-- inversion happens once, at ingest.
CREATE TABLE IF NOT EXISTS transactions (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,                -- plaid | import
  external_id     TEXT,
  dedupe_hash     TEXT NOT NULL,
  posted_on       TEXT NOT NULL,                -- YYYY-MM-DD
  amount_cents    INTEGER NOT NULL,
  description     TEXT NOT NULL,
  merchant        TEXT,
  plaid_category  TEXT,
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_locked INTEGER NOT NULL DEFAULT 0,   -- set when you categorise by hand
  pending         INTEGER NOT NULL DEFAULT 0,
  is_transfer     INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_external
  ON transactions(source, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS transactions_dedupe
  ON transactions(account_id, dedupe_hash);
CREATE INDEX IF NOT EXISTS transactions_posted ON transactions(posted_on);
CREATE INDEX IF NOT EXISTS transactions_category ON transactions(category_id);

-- Investments have no sync cursor, so holdings are replaced wholesale per
-- account on each run rather than merged.
CREATE TABLE IF NOT EXISTS holdings (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id      TEXT NOT NULL,
  symbol           TEXT,
  name             TEXT,
  quantity         REAL NOT NULL,
  price_cents      INTEGER,
  value_cents      INTEGER NOT NULL,
  cost_basis_cents INTEGER,
  as_of            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS holdings_unique ON holdings(account_id, security_id);

-- The spreadsheet. The formula column holds exactly what was typed, whether
-- that is a literal "1200" or an expression such as "=PREV()*1.03".
CREATE TABLE IF NOT EXISTS budget_cells (
  month       TEXT NOT NULL,                    -- YYYY-MM
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  formula     TEXT NOT NULL,
  PRIMARY KEY (month, category_id)
);

-- Named constants usable in budget formulas: =avg_meal_cost * 20.
--
-- value is REAL rather than integer cents because a variable is not
-- necessarily money — meals_per_week is a count. Formula arithmetic already
-- runs in floating-point dollars and rounds to cents once, at the boundary in
-- budget.ts, so this matches how the rest of the expression is evaluated.
--
-- name is stored upper-cased because the tokenizer upper-cases identifiers,
-- making references case-insensitive; label keeps the spelling as typed.
CREATE TABLE IF NOT EXISTS variables (
  name       TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  value      REAL NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY,
  pattern     TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credentials (
  id           TEXT PRIMARY KEY,                -- base64url credential id
  owner        TEXT NOT NULL,
  public_key   BLOB NOT NULL,
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,
  device_name  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS challenges (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  challenge  TEXT NOT NULL,
  kind       TEXT NOT NULL,                     -- register | authenticate
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,                    -- running | ok | partial | error
  detail      TEXT
);
`;
