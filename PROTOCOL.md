# LinkLet — Protocol v1 (Phase 1)

Status: **frozen for phase 1.** Further changes are additive, not rewrites.

Scope: two-way text between a user's Telegram chat and their Chrome extension. A
link is text; there is no separate link type in v1.

Out of scope for v1: durable message history, cross-restart traceability, rate
limiting, deployment/HTTPS, page injection.

---

## 1. Identifiers

| Name | Source | Meaning |
|---|---|---|
| `chatId` | `update.message.chat.id` | The private chat. Identity **and** routing in v1. |
| `accountId` | server, random UUID | Opaque binding key and JWT subject. Never sent to Telegram. |
| `id` | server counter, `++lastId` | Message cursor. Persisted, so it does not reset on restart. |
| `since` | client-held | Last `id` the client has processed. |

**Assumption: private chats only.** In a private chat `chat.id` and `from.id` are
the same number, so one identifier serves both identity and routing. Enforced in
two places rather than trusted:

1. BotFather `/setjoingroups` → Disable, so the bot cannot be added to a group.
2. Ingest drops any update whose `chat.type` is not `"private"`.

`accountId` keeps the Telegram id out of the token and lets a chat be re-linked
without invalidating unrelated sessions.

## 2. Message record (server-internal)

```ts
type Message = {
  id: number;                    // cursor, strictly increasing across restarts
  text: string;                  // trimmed, non-empty, <= 4096 chars
  direction: "in" | "out";       // which way the record travelled
  chatId: string;                // identity and routing target
  createdAt: string;             // server clock, ISO 8601, never client-supplied
};
```

Field justifications:

- `id` — without it the client cannot say "everything after this", and messages repeat.
- `text` — the payload; the system has no other purpose.
- `direction` — only meaningful because the log stores both directions.
- `chatId` — routing target and the key the read filter partitions on.
- `createdAt` — ordering and incident reconstruction. Server-assigned only.

### Inbound classification

Every inbound text is classified before it can reach the store:

| Input | Handling | Reaches the extension? |
|---|---|---|
| `/command`, `/command@Bot`, `/command payload` | bot traffic: logged, never stored | no |
| `/start CODE` (deep link) | completes pairing if CODE is live | no |
| a live pairing code | completes enrollment | no |
| blank text or text over 4096 characters after trimming | ignored, not stored | no |
| anything else | stored with `direction: "in"` | yes |

Command classification is by prefix, not by an allowlist. Unknown commands are
still bot traffic, so a typo cannot leak into the extension. The tradeoff is that
a user cannot send text starting with `/` to their own extension; that is accepted
in v1.

## 3. Authentication and enrollment

Pairing code (WhatsApp Web model). One manual step, ever.

```
POST /enroll/start
  -> { code: "K7F29Q", enrollToken: "<opaque>", expiresAt }

user sends "K7F29Q" to the bot in Telegram

POST /enroll/claim  { enrollToken }
  -> 200 { jwt, accountId }   once the code has been matched
  -> 202 { status: "pending" }
  -> 410                       expired, unknown, or already claimed
```

Enrollment state, server-side:

```
pending    -> { code, enrollToken, accountId, expiresAt, completed }
binding    -> { accountId, chatId, createdAt }      looked up by JWT subject
```

Rules:

- Codes are single use, expire in 5 minutes, compared case-insensitively.
- The binding is created only when the code arrives through `getUpdates`. An
  extension can never assert its own `chatId`.
- One `accountId` per `chatId`, and one `chatId` per `accountId`. Re-enrolling an
  existing chat reuses its `accountId` and mints a new JWT.
- The enroll token is consumed by the first successful claim; a lost JWT means
  re-enrolling.
- JWT is HS256, `sub = accountId`, expiry 7 days, no refresh in v1.
- Identity lives in the token; **authority lives in the server** and is looked up
  per request, so unbinding and revocation actually work.

## 4. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness, current cursor |
| POST | `/enroll/start` | none | Begin pairing, return code |
| POST | `/enroll/claim` | enroll token | Exchange for a JWT |
| GET | `/messages?since=N&wait=S` | JWT | Cursor read, filtered to the caller |
| POST | `/send` | JWT | Send text to the caller's bound chat |

Dev-only, registered solely when `DEV_INGEST=1`:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/dev/ingest` | none | Simulate a Telegram update without a bot token |

## 5. Read semantics

- `since` must be a non-negative integer, else `400`.
- Result is `id > since`, **and** `chatId` equal to the caller's bound chat, **and**
  `direction: "in"`. Outbound records are stored for traceability but are never
  delivered back to the client that sent them.
- `nextSince` = id of the last delivered message, else `since` unchanged.
- `wait` only applies when the initial read is empty; clamped to 25s.
- An unenrolled caller cannot hold a valid token, so it gets `401`, not `403` and
  never an empty list. (An empty list would look like "no messages".)

## 6. Send semantics

- Body is `{ text }`. Any `chatId` in the body — even `null` or empty — is
  **rejected** (`400 chat_id_not_allowed`) rather than ignored, so the client
  learns the destination is server-derived.
- Server resolves `chatId` from the JWT subject's binding.
- Calls Telegram `sendMessage`, **then** stores the record with `direction: "out"`
  and returns `{ message }`. Nothing is stored when Telegram rejects, so a failed
  send never leaves a phantom in the log.
- The text is trimmed before sending and before storing.
- Errors:

| Status | Code | Cause |
|---|---|---|
| `400` | `invalid_request` | missing `text` |
| `400` | `chat_id_not_allowed` | any `chatId` in the body |
| `400` | `text_too_long` | trimmed text > 4096 chars |
| `401` | `unauthorized` | missing, tampered, or expired token |
| `502` | `telegram_rejected` | Telegram returned `ok: false` (message is its `description`) |
| `503` | `telegram_not_configured` | `TELEGRAM_BOT_TOKEN` unset |

`503` is distinct from `502` on purpose: one is "this server cannot send at all",
the other is "Telegram refused this message". Retrying only helps the first.
- An outbound record is stored and keeps its `direction: "out"`, but `/messages`
  filters it out, so a client cannot echo its own sends. `POST /send` returning
  `{ message }` is how the sender learns the result.

## 7. Error envelope

```json
{ "error": { "code": "not_enrolled", "message": "No chat is linked to this account." } }
```

## 8. Invariants

1. `id` strictly increasing and never reused, including across restarts.
2. The server never accepts `chatId` from a client.
3. Inbound `chatId` originates only from `getUpdates` (or the dev ingest route when
   `DEV_INGEST=1`).
4. Only `chat.type === "private"` updates are accepted; others are dropped at ingest.
5. `createdAt` always comes from the server clock.
6. `text` is trimmed, non-empty, <= 4096 chars.
7. Every `GET /messages` response carries `nextSince`.
8. `accountId` and `chatId` are strictly one-to-one.
9. Telegram commands are never stored and never forwarded. They are logged only.
10. `/messages` returns only `direction: "in"`; outbound records exist for the log
    but are never delivered to a client.
11. Blank inbound text and inbound text over 4096 characters after trimming are
    ignored and never stored.

## 9. Security notes

- Raw `chatId` is PII; do not write it to logs. Log `accountId` or the message id.
- `/enroll/start` is unauthenticated by necessity — needs rate limiting before any
  public deployment.
- `JWT_SECRET` comes from the environment. A generated fallback is for local dev
  only; it invalidates every session on restart.
- `state.json` holds bindings, so it contains raw `chatId` at rest. It is written
  with mode `0600` and gitignored. Message text and pending codes are never
  written to disk.

## 10. Decisions

| # | Decision | Value | Status |
|---|---|---|---|
| O1 | Store outbound messages in the log? | Yes (keeps `direction`) | accepted for phase 1 |
| O2 | JWT lifetime / refresh | 7 days, no refresh | accepted for phase 1 |
| O3 | Code format | 6 chars, 32-symbol alphabet, 5-minute TTL | accepted for phase 1 |
| O4 | `sub` claim | `accountId` (opaque) | **locked** |
| O5 | Access/refresh token split | deferred to phase 6 (§12) | open |

## 11. Verification for phase 1

1. `enroll/start` → code arrives by Telegram → `claim` returns a JWT.
2. A second chat cannot read the first chat's messages.
3. A non-private update is dropped at ingest, not stored.
4. Blank or over-limit inbound text is ignored and not stored.
5. `claim` twice → second attempt is `410`.
6. No request path accepts `chatId` from the client.
7. `send` with a real token delivers to Telegram, stores `direction: "out"`, and
   returns that record in the `POST /send` response. It is not returned by
   `GET /messages`; that endpoint delivers inbound messages only.
8. `send` with `chatId` in the body → `400 chat_id_not_allowed`; without a token →
   `401 unauthorized`; with no bot token configured → `503`; Telegram refusal → `502`.
9. A failed send stores nothing.
10. After a successful send, `GET /messages` still returns only inbound messages,
   and a long-poll waiting on that chat is not woken by the outbound record.

---

## 12. Deferred: token storage and refresh rotation (phase 6)

**Not in v1.** v1 behaviour: one 7-day JWT, no refresh. When it expires, re-enroll.

### Where the token goes (v1 decision)

| Storage | Use | Never |
|---|---|---|
| `chrome.storage.local` | the JWT | `window.localStorage` — absent in a service worker, and reachable by page XSS |

`chrome.storage.local` is not exposed to web pages, so page-level XSS cannot read
it. It **is** readable by the extension's own code and by anyone with access to the
browser profile on disk. Therefore storage secrecy is not the control; **token
lifetime and revocation are.**

### Planned shape (v2)

| Token | Lifetime | Storage | Purpose |
|---|---|---|---|
| access | 15 minutes | `chrome.storage.session` (memory, cleared on browser restart) | authorizes API calls |
| refresh | 30 days, rotating | `chrome.storage.local` | mints new access tokens |

Rules:

- `POST /auth/refresh { refreshToken }` → `{ accessToken, refreshToken, expiresAt }`.
  **Every use rotates the refresh token.**
- Reuse of an already-rotated refresh token revokes the entire token family — that
  is the theft-detection signal.
- The server stores refresh tokens **hashed**, keyed by `jti`, with `accountId`,
  `expiresAt`, and `revokedAt`. Never plaintext.
- The access token lives only in memory. On `401`, the client refreshes once and
  retries; a failed refresh drops back to re-enrollment.
- Refresh rotation and revocation require durable storage, so this depends on the
  phase 6 persistence work.

Open sub-decisions: rotation grace window for retried requests, device limit per
account, and whether logout revokes one token or the whole family.

This also removes v1's worst UX property: a 7-day token with no refresh means the
user must re-pair on a schedule.

---

## 13. Persistence (added after phase 1)

One file, `state.json` (override with `DATA_FILE`), in the working directory.
Written on the two events that must survive a restart, by write-to-`.tmp` then
rename, so a crash mid-write cannot leave a truncated file.

```json
{
  "version": 1,
  "lastMessageId": 3,
  "accounts": [{ "id": "uuid", "chatId": "…", "createdAt": "ISO 8601" }]
}
```

| Survives restart | Does not |
|---|---|
| account bindings (`accountId` ↔ `chatId`) | unread message text (in-memory buffer) |
| the message id counter (no id reuse) | pending pairing codes (5-minute credentials) |
| | Telegram `getUpdates` offset |

Consequences:

- A JWT issued before a restart keeps working **iff** `JWT_SECRET` is unchanged and
  its `accountId` is still in `state.json`. Both conditions are required.
- A client holding cursor `N` is safe: the next message is `N+1`, never a reused id
  it would skip. Messages that existed before the restart but were never read are
  still lost, because text is not persisted.
- Pending codes intentionally do not survive: they are credentials with a 5-minute
  life, and persisting them would widen their exposure window.
- Environment loading uses `node --env-file-if-exists=.env`, so `.env` supplies
  `PORT`, `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `DEV_INGEST`, `DATA_FILE`. Values
  already set in the shell take precedence over the file.

Migration path: SQLite, when message history or refresh-token rotation lands. The
JSON file is a v1 stopgap, not a data store to build on.

## 14. Chrome extension client (v1)

The unpacked Manifest V3 extension is in `extension/`. It pairs using the
enrollment endpoints above, stores the JWT in `chrome.storage.local`, and does
not send a `chatId` in API requests. Remote API URLs must use HTTPS; the
extension requests host access only for the configured server origin.

The extension service worker keeps a 20-second long poll active and immediately
starts the next request when one completes. A 30-second Chrome alarm recovers
polling if the service worker is restarted; opening the popup also requests an
immediate poll. Its cursor is stored per account in extension storage and
advances only from `nextSince`; outbound sends do not advance that cursor.
`/send` returns the outbound record directly to the popup, while the poller
continues to receive inbound records only. On a new inbound message, the worker
sets the toolbar badge and calls `chrome.action.openPopup()`; this requires
Chrome 127 or later. The extension stores a capped local display history of 100
inbound and 100 outbound messages per account; this history is separate from the
server's message buffer and can be cleared locally.
