# Questions

Keep unresolved questions concise. Add a date or context when it helps.

## YYYY-MM-DD: Question

- **Context:**
- **Current hypothesis:**
- **Evidence to check:**
- **Status:** unresolved

## 2026-10-24: Which id scheme for durable, collision-free message ids? (phase 6)

- **Context:** The current `id` is a per-process counter (`++lastId`), so it restarts at 1 after a server restart and cannot distinguish messages across restarts. Traceability across restarts is deferred to phase 6.
- **Current hypothesis:** A time-sortable globally unique id (UUIDv7 or ULID) assigned at ingestion, stored alongside the in-memory counter and used for durable records.
- **Evidence to check:** Whether ordering must survive clock skew; whether the storage layer is SQLite (a sequence would suffice) or potentially multi-process later.
- **Status:** unresolved — revisit when phase 6 starts.

## 2026-10-25: How should the extension receive messages while the popup is closed?

- **Context:** Pairing-code enrollment answers *who owns which chat*, but delivery while the popup is closed is a separate axis. MV3 service workers are terminated after roughly 30 seconds idle, so a long-lived socket from the worker is unreliable.
- **Current hypothesis:** `chrome.alarms` polling every 30–60 seconds for v1 — no message loss, modest battery cost — with Web Push (VAPID) added later if phone-style notifications are needed.
- **Evidence to check:** the current minimum `chrome.alarms` period for released extensions (Chrome has changed it); whether Chrome extension service workers support the Push API with VAPID; whether Web Push requires Chrome to be running or only installed.
- **Status:** unresolved — decide during the extension phase.
