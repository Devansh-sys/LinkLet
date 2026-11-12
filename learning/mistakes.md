# Mistakes

Record meaningful bugs or recurring misconceptions. Preserve the original reasoning.

## YYYY-MM-DD: Short title

- **Problem:**
- **Mistake:**
- **Original mental model:**
- **Correct mental model:**
- **Category:**
- **Prevention:**
- **Follow-up exercise:**

## 2026-10-22: The async/await rule is one-way, and top-level await is ESM-only

- **Problem:** While reading `tsconfig.json` (`target: es2022`, `module: nodenext`, `"type": "commonjs"`), asked why top-level `await` is rejected even though ES2022 "supports" it.
- **Mistake:** Stated the rule backwards — "for every async need await" — and offered the syntax rule as the entire explanation, without the module-system reason.
- **Original mental model:** "this is the rule that for every async need await, that's why it will reject await without async."
- **Correct mental model:** The dependency runs one way: `await` requires an enclosing `async`; an `async` with no `await` is legal and simply returns a resolved promise. A CommonJS file body is not an async frame, so top-level `await` has nothing to attach to and fails to parse. ESM permits top-level `await` because module evaluation is promise-based, whereas `require` is synchronous and must return before the module finishes.
- **Category:** Conceptual — module systems and async semantics, plus a terminology inversion (rule direction).
- **Prevention:** When restating a rule, check which direction it runs, then ask what mechanism enforces it. A restated rule is not an explanation of behavior.
- **Follow-up exercise:** Take one top-level `await` in a CommonJS file and produce two fixes — wrap it in an async IIFE, and convert the file to ESM by flipping `package.json`'s `"type"`. Then say which fix changed the parsing and which changed the evaluation.

## 2026-10-22: `require` cannot be awaited — the async boundary lives in the export

- **Problem:** Asked what `require` hands back when the required module's body contains an `await`.
- **Mistake:** Assumed the caller can `await` the `require` call to wait for the required module's async work; expected `undefined` or a runtime crash.
- **Original mental model:** "if there is await in b.js to return something then there needs to be await at requiring it too, because otherwise it will return undefined or crash the program."
- **Correct mental model:** `require` is synchronous by contract and returns `module.exports` immediately, so `await require(...)` awaits a non-promise and resolves instantly without waiting for anything. And the scenario cannot reach runtime: an `await` in a CommonJS module body is a parse error, so `require` throws a `SyntaxError` at load time rather than returning `undefined`. The async boundary belongs in the export — the module exposes a promise-returning function and the caller awaits the result of calling it. Genuinely awaiting module loading requires dynamic `import()`.
- **Category:** Conceptual — async boundary placement and CommonJS loading semantics. Same root cause as the previous entry: `await` placed on the wrong expression.
- **Prevention:** Before adding `await`, ask which expression actually produces the promise. `await` on a non-promise silently waits for nothing, so it fails quietly instead of loudly. Also distinguish parse-time from runtime failures before predicting "undefined."
- **Follow-up exercise:** Given a module exporting `async function getUser()`, write the caller three ways — missing `await`, `await` on the `require`, and `await` on the call — and predict the value held in each case before running it.

## 2026-10-25: Enrollment is a one-time setup, not a per-message condition

- **Problem:** Designing how the server learns that an extension belongs to a given Telegram chat.
- **Mistake:** Assumed that establishing the chatId ↔ extension link would require the user to have the extension open at the same moment they send a message, and therefore rejected the approach.
- **Original mental model:** "that would require user to open the ext at the same time when sending data, which I don't want."
- **Correct mental model:** Enrollment happens once. The pairing proves ownership a single time; the server stores the binding permanently. Every later message is routed from that stored binding, so the extension may be closed indefinitely — messages buffer server-side and are delivered on the next poll. Confusing *one-time provisioning* with *per-request evaluation* made a sound design look unusable.
- **Category:** Conceptual — setup-phase vs request-phase reasoning.
- **Prevention:** When rejecting a design because "the user would have to be present," ask at which phase the presence is required: provisioning, or every request. Most credential and pairing flows are provisioning events.
- **Follow-up exercise:** Name three other systems whose one-time setup is mistaken for continuous presence (WhatsApp Web QR, SSH key upload, OAuth app consent), and state what is stored after each so that later requests need no user involvement.

## 2026-10-25: Recurring pattern — mistaking a record for a prerequisite

- **Problem:** Three separate predictions across this session, all failing the same way.
- **Mistake:** Assuming that because something is stored or recorded, it must exist before the operation can work.
- **Original mental models:**
  1. "needs await at requiring it too, because otherwise it will return undefined" — waiting for an async operation, when `require` cannot await anything.
  2. "that would require user to open the ext at the same time" — presence required for every message, when the binding is a one-time artifact.
  3. "if outbound is not stored then server would not know it needs to send msg to telegram chat" — storage treated as an input to the send.
- **Correct mental model:** The record is produced *by* the operation, not consumed by it. Order is perform → record. Before claiming something is required, ask whether it is an **input** or an **artifact**. If B is written after A completes, B cannot be a prerequisite for A.
- **Category:** Recurring reasoning pattern — input vs artifact.
- **Prevention:** For every claimed dependency, draw the arrow: does data flow *into* the operation or *out of* it? Contract, state, and logs are usually outputs.
- **Follow-up exercise:** Classify each of `offset`, the JWT, and the message log as an input or an artifact for the operations that touch them, and name the one case where `offset` genuinely is an input (the next `getUpdates` call).
