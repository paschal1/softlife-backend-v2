# SoftLife Backend

Modular NestJS monolith implementing the foundation from the SoftLife Product Plan
(Technology Stack & Scale and Event-Driven Architecture tabs): multi-tenancy enforced
by Postgres Row-Level Security, PIN + password auth, and a transactional outbox that
feeds an append-only audit log.

## Quick start

```bash
cp .env.example .env            # then set JWT_ACCESS_SECRET (command is in the file)
cp .env.test.example .env.test
docker compose up -d            # Postgres 16 + roles + softlife and softlife_test databases
npm install
npm run db:migrate
npm run start:dev               # API on http://localhost:3000/api/v1
npm run start:worker:dev        # in a second terminal: outbox relay → audit log
```

API docs (Swagger): **http://localhost:3000/api/docs** — sign up or log in there, click
*Authorize*, paste the `accessToken`, and every endpoint is callable from the browser.
The raw OpenAPI JSON (for generating Flutter/TypeScript clients) is at `/api/docs-json`.

Try it:

```bash
curl -X POST localhost:3000/api/v1/auth/signup -H 'content-type: application/json' \
  -d '{"businessName":"Aqua Pure Water","fullName":"Ada Obi","phone":"08031234567","password":"a-strong-password"}'
```

Within a second of signing up, the worker writes three rows to `audit_log`
(organization.created, location.created, user.created).

## Tests

```bash
npm test            # unit tests, no database
npm run test:int    # integration tests against softlife_test (Postgres must be running)
```

`test/tenant-isolation.int-spec.ts` is the most important test here. It proves that one
business cannot read, insert into, update or delete another business's rows, that a
query with no tenant returns nothing, and that the audit log cannot be altered. Keep it
green, and extend it whenever a new tenant table is added.

## Processes

| Process | Entry | Does |
|---|---|---|
| API | `src/main.ts` | HTTP requests. Writes state + outbox rows in one transaction. |
| Worker | `src/worker.ts` | Relays outbox events to subscribers (audit log today; inventory, delivery, insight hub, notifications later). Run **one** instance for now to preserve event order. |

## The rules (read before adding a module)

1. **Tenant data only through `TenantDatabase`.** `tenantDb.transaction(trx => …)` sets
   `app.current_org_id` for that transaction and RLS does the filtering. The raw app
   connection isn't exported, on purpose.
2. **`SYSTEM_DB` is for auth, the outbox relay and health checks only.** Anything else
   importing it should be questioned in review.
3. **Every state change records a domain event in the same transaction**:
   `events.record(trx, {...})`. Include `before`/`after` snapshots; never include secrets.
4. **Modules don't call each other to react to changes; they subscribe to events.**
   Sales raises `sale.completed`; Inventory subscribes and decrements stock.
5. **Subscribers must be idempotent.** Delivery is at-least-once. Use the event id
   (e.g. a unique column + `ON CONFLICT DO NOTHING`), like `AuditLogSubscriber`.
6. **Every new tenant table**, in its migration: `organization_id NOT NULL`,
   `UNIQUE (organization_id, id)`, composite foreign keys to parents, an
   `(organization_id, created_at)` index, and RLS policies (see `tenantRls()` in `0001`).
7. **IDs are UUIDv7, generated in the app** (`uuidv7()`), so the offline POS can create
   records before it can reach the server.
8. **Money is `bigint` kobo, and the API speaks kobo** (`...Kobo` fields, integers). Never floats.
   Sum with `sum(x)::bigint` so results come back as numbers.

## Database roles

| Role | Used by | Access |
|---|---|---|
| `softlife_owner` | migrations only (direct connection, never via PgBouncer) | owns the schema |
| `softlife_app` | API tenant queries | confined to one organization by RLS |
| `softlife_system` | login/refresh lookups, outbox relay, health | explicit cross-tenant policies (no `BYPASSRLS` needed, so it works on managed Postgres) |

In production, put PgBouncer in **transaction** pooling mode in front of the app and
system connections. The tenant setting is transaction-local, so it can't leak between
pooled clients.

## API (all under `/api/v1`)

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/auth/signup` | public | Creates organization + first branch + owner |
| POST | `/auth/login` | public | Email or phone (any Nigerian format) + password |
| POST | `/auth/refresh` | public | Rotates the refresh token; reuse of an old one revokes the login |
| POST | `/auth/pin-login` | signed-in till | Staff hand-off by PIN; locks for 15 min after 5 wrong tries |
| POST | `/auth/logout` | signed in | Revokes the login's refresh tokens |
| GET | `/auth/me` | signed in | |
| GET | `/organizations/current` | signed in | |
| GET/POST | `/locations` | GET any, POST owner | |
| GET/POST | `/users` | GET any, POST owner/manager | Owners manage managers/cashiers/drivers; managers manage cashiers/drivers |
| PUT | `/users/:id/pin` | self, or a manager of that role | |
| PATCH | `/organizations/current/settings` | owner | EOD variance threshold, credit limit mode (soft/hard), default credit limit |
| GET/POST | `/registers` | GET any, POST owner/manager | GET includes live open/closed status (REG-03) |
| POST | `/registers/:id/clock-in` | signed in | Opening float; one session per till and per person (REG-01/02) |
| GET | `/register-sessions/current` | signed in | Caller's open session or null: the POS start-up check |
| POST | `/register-sessions/:id/cash-movements` | holder or manager | Pay-in / pay-out, reason required |
| GET | `/register-sessions/:id/eod-preview` | holder or manager | Expected cash in till (EOD-01) |
| POST | `/register-sessions/:id/close` | holder or manager | Counted cash → variance → flag + alert (EOD-01/02) |
| GET | `/register-sessions` | signed in | EOD reports, filterable, paginated (EOD-03) |
| GET | `/register-sessions/:id` | holder or manager | One EOD report with full cash breakdown |
| GET | `/products` | signed in | Search / scan / browse; `locationId` adds stock on hand (POS-01) |
| GET | `/products/categories` | signed in | For POS browse tabs |
| GET | `/products/:id` | signed in | With stock at every branch |
| POST / PATCH | `/products`, `/products/:id` | owner/manager | Price changes are audited before → after |
| GET | `/inventory/levels` | signed in | Per branch, or totals across branches; `lowStockOnly` |
| GET | `/inventory/movements` | owner/manager | Full stock history |
| POST | `/inventory/receipts` | owner/manager | Supplier delivery or production run |
| POST | `/inventory/adjustments` | owner/manager | Wastage, correction or stock count (reason required) |
| POST | `/inventory/transfers` | owner/manager | Between branches, atomic |
| GET / POST / PATCH | `/customers`, `/customers/:id` | signed in | Search by name or phone; tags need owner/manager, credit limits need owner |
| GET | `/customers/:id/wallet/transactions` | signed in | History with running balance (WAL-03) |
| POST | `/customers/:id/wallet/top-ups` | signed in | Cash (into caller's till) or transfer (reference required) |
| POST | `/customers/:id/wallet/adjustments` | owner | Correction with reason |
| POST | `/sales` | clocked-in staff | Complete a sale: stock, wallet, debt and till cash in one transaction |
| GET | `/sales`, `/sales/:id` | signed in | Cashiers see their own; `/sales/:id` is receipt data |
| POST | `/sales/:id/void` | owner/manager, or cashier + manager PIN | Reverses stock, wallet, debt and till cash |
| GET | `/sales/:id/receipt` | signed in | `format=text&width=32` for 58mm printers, `48` for 80mm, or HTML |
| POST | `/sales/:id/receipt/link` | signed in | Signed link the customer opens without login (WhatsApp/SMS) |
| GET | `/deliveries` | signed in | Queue by date (DEL-01); drivers see only theirs, without codes |
| POST | `/deliveries/:id/assign` | owner/manager | Driver + expected time (DEL-02) |
| POST | `/deliveries/:id/dispatch` | driver / manager | Out for delivery |
| POST | `/deliveries/:id/confirm` | driver / manager / shop staff (pickups) | Code proof, collect what's due, log returns (DEL-03) |
| POST | `/deliveries/:id/fail` | driver / manager | Failed attempt with reason; can be reassigned |
| GET | `/deliveries/driver-cash` | signed in | Cash collected at doors, not yet handed in |
| POST | `/deliveries/remittances` | clocked-in staff | Driver hands in cash; shortfalls flagged |
| POST | `/sync/push` | the till's token | Upload offline operations, in order, exactly once |
| GET | `/sync/pull` | the till's token | Catalogue, customers, balances, stock, staff changed since `since` |
| GET | `/sync/review` | owner/manager | Rejected or flagged offline operations |
| POST | `/sync/review/:opId/resolve` | owner/manager | Record what was done about it |
| GET | `/notifications` | signed in | My alerts and digests, newest first |
| GET | `/notifications/unread-count` | signed in | Badge count |
| POST | `/notifications/:id/read`, `/notifications/read-all` | signed in | |
| GET / PUT | `/notifications/settings` | signed in | Push, SMS, digest on/off; mute kinds |
| POST | `/notifications/devices`, `/notifications/devices/unregister` | signed in | Firebase push token on login / sign-out |
| GET | `/insights/daily-summary` | owner/manager | One day at a glance (INS-01); same figures as the digest |
| GET | `/audit-log` | owner/manager | Filter by date, staff, action (`sale.*`), record, branch, text (AUD-02) |
| GET | `/audit-log/:id` | owner/manager | One entry with full before/after |
| POST | `/audit-log/exports` | owner/manager | CSV or PDF, built in the background; notified when ready |
| GET | `/audit-log/exports`, `/audit-log/exports/:id` | owner/manager | Status and a 15-minute download link |
| GET | `/deliveries/:id/signature` | owner/manager, assigned driver | Link to the signature captured at the door |
| GET | `/customers/:id/debts` | signed in | Debts with age and bucket |
| POST | `/customers/:id/debts/repayments` | signed in | Oldest first; cash into till, transfer, card or wallet (DEBT-04) |
| GET | `/customers/:id/debts/repayments` | signed in | Repayment history with what each cleared |
| GET | `/debts/aging` | owner/manager | 0–30 / 31–60 / 61–90 / 90+ days (DEBT-03) |
| GET | `/health` | public | Point uptime monitoring here |

### How stock works

`stock_movements` is an append-only ledger: every change to stock is one row with a
type (purchase, sale, wastage, transfer, count...), who did it, and why. `stock_levels`
(quantity per product per branch) is maintained by a database trigger from that ledger,
and the API role cannot write it at all, so the two can never disagree. All modules
change stock through `StockLedger.record()` inside their own transaction. Manual
operations can't take stock below zero; sales can (a paying customer is never blocked
because records were off). Falling to a product's reorder level raises `threshold.crossed`.

### How a sale works

`POST /sales` runs as one transaction: check the caller's open register session (REG-02),
price every line from the catalogue (never from the client), check payments add up (POS-03),
enforce credit limits (DEBT-02), then record the sale, remove stock through the ledger
(POS-04), charge the wallet, open a debt for any credit (DEBT-01), and put cash in the till.
Anything failing undoes everything.

Cashiers need a manager for discounts and for going over a *soft* credit limit. The API
answers `409` with `error: "MANAGER_APPROVAL_REQUIRED"` and the `reasons`; the manager enters
their PIN on the till and the POS resubmits the same sale with `managerApproval`. Wrong PINs
count toward that manager's lockout. Always send a client-generated `id`: a retried sale
returns the original instead of charging twice.

### How deliveries work

A delivery order or pre-order joins the queue in the same transaction as the sale. The
customer's receipt carries a 4-digit code; the driver enters it at the door as proof of
delivery (5 wrong tries locks it and a manager confirms with the recipient's name instead).
Anything due on delivery must be collected in full to mark it delivered. Cash the driver
collects is tracked per person until handed in at a till (`/deliveries/remittances`), where
it joins that till's EOD; a short hand-in is flagged like an EOD variance. Returned empties
or refused goods go back into stock through the ledger. Pickup pre-orders are confirmed at
the shop, and their balance goes straight into the till.

### How offline sync works

The Flutter POS works from a local SQLite copy of what `GET /sync/pull` returns, and records
everything it does as operations with device-generated ids (UUIDv7): `register.clock_in`,
`sale.create`, `wallet.top_up`, `debt.repayment`, `register.cash_movement`, `register.close`,
`customer.create`, `delivery.confirm`. On reconnect it sends them, in the order they happened,
to `POST /sync/push`.

- **Exactly once.** Re-sending an `opId` returns the stored outcome; nothing is applied twice.
- **In order.** A temporary server error stops the batch at that operation (`not_processed`), so
  a sale is never applied before the clock-in it depends on. Send it and the rest again.
- **Offline sales are facts.** They are recorded at the price the till charged, a wallet
  shortfall becomes debt, credit limits don't block, and a manager's approval given at the till
  is honoured if that person really is a manager. Every such difference becomes a *flag*.
- **Review.** Rejected operations and flagged ones appear in `GET /sync/review` until a manager
  resolves them with a note.
- **Pull.** Pass the previous `nextSince` as `since`; windows overlap slightly, so upsert by id.
  `outstandingDebts` is always a complete list. PIN hashes never leave the server: the app should
  keep its own local verifier for staff who have logged in on that device while online.

### How notifications and jobs work

All of this runs in the **worker** (`npm run start:worker:dev`), on Postgres alone (no Redis needed):

- **Alerts (INS-02).** Events already raised by the system become notifications for owners and
  managers (except whoever caused them): low stock, till and driver-cash variances, credit-limit
  overrides, voids, PIN lockouts, flagged offline sales, failed deliveries. Each event notifies
  a person at most once, even if delivered twice.
- **Scheduled jobs**, on each business's own clock (its timezone): the **daily digest** at the
  owner's chosen hour (`dailyDigestHour`, default 8pm) and **overdue-debt alerts** at 9am when
  a debt crosses 30, 60 or 90 days. A job runs once per business per day, however many workers.
- **Channels.** Every notification lands in the in-app inbox. **Push** (Firebase) switches on when
  `FCM_SERVICE_ACCOUNT_BASE64` is set; **SMS** (Termii) when `TERMII_API_KEY` is set. SMS carries only
  critical alerts and the digest, only to users who turned it on, in plain characters (₦ would
  double the SMS cost). Failed sends retry with backoff; uninstalled apps' tokens are retired.

### How the audit log and files work

Every domain event lands in the append-only `audit_log` (see the audit subscriber). The viewer
turns each entry into one readable sentence ("Changed Pure Water: price ₦300.00 → ₦350.00")
and keeps the exact before/after values beside it. Exports are queued, built by the worker,
stored, and downloaded through a signed link valid for 15 minutes; files are deleted after
7 days, while the record of who exported what stays in the audit log for good. CSVs open
cleanly in Excel (UTF-8 BOM) and neutralise spreadsheet formulas in names and notes.

Files (exports, delivery signatures) go to a local folder by default (`STORAGE_DRIVER=local`)
or any S3-compatible bucket (`STORAGE_DRIVER=s3`: AWS S3, Cloudflare R2, DigitalOcean Spaces).
Keys are always generated by the server, per organization, and downloads are always signed.

### How expected cash works

Every movement of physical cash through a session is an append-only row in
`register_cash_movements`: opening float, pay-ins, pay-outs now; cash sales, cash
refunds, cash wallet top-ups and cash debt repayments as those modules land. Expected
cash is the sum. Nothing is edited after the fact, so an EOD variance can be traced
line by line. Sales will add the payment-method breakdown to the EOD report.

## Not in this foundation yet

Redis/BullMQ (arrives with the first background job: printable/emailed EOD reports or
Insight Hub digests), notifications for `threshold.crossed` events, per-branch staff
assignment, device registration for tills, and the remaining business modules, starting
with Products & Inventory → Sales.
