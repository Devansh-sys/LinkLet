# Concepts

Record durable understanding, not every definition encountered.

## YYYY-MM-DD: Concept

- **Learner's explanation:**
- **Corrected understanding:**
- **Example:**
- **Related concepts:**

## 2026-10-24: `package.json` "type" and tsconfig "module" are two independent votes

- **Learner's explanation:** "module is set to commonjs, it sets require() into the file, and type as module makes node read the same file as esm."
- **Corrected understanding:** Accurate as stated. The refinement worth keeping: `module: "nodenext"` does not choose a format at all — it defers to `package.json`'s `"type"`. That is why flipping `"type"` to `"module"` produces no error under `nodenext`: ESM is emitted and Node agrees. A conflict is only possible when `module` forces a format (`commonjs`) while `"type"` declares the opposite, and the compiler cannot detect it because it never asks how the output will be interpreted.
- **Example:** Same `package.json` (`"type": "module"`), two tsconfigs. `module: nodenext` emitted `import { value } from "./a.js"` and ran fine. `module: commonjs` emitted `require("./a.js")` into the same `.js` file, and Node threw `ReferenceError: exports is not defined in ES module scope`. Build succeeded in both cases; only the second failed at runtime.
- **Related concepts:** source syntax vs emitted format; `esModuleInterop` and the `__importDefault` shim for CJS dependencies; the `nodenext` rule that relative imports name the output path with its extension (`./store.js` for `store.ts`); the async-boundary entries in `mistakes.md`.

## 2026-10-24: A memory leak is unbounded retention, not memory security

- **Learner's explanation:** "isn't memory leak means security for that memory??"
- **Corrected understanding:** A leak is a reference that is never released, so consumption grows without a ceiling until the process degrades or dies. Memory *safety* — out-of-bounds access, use-after-free — is a different property, and the JS runtime removes most of that class. The two intersect only when an attacker controls the growth rate: unbounded input becomes out-of-memory denial of service. "Bounded memory" means a fixed ceiling exists, as with `MAX_MESSAGES = 500` plus `shift()`.
- **Example:** In this project the message array is capped, so message volume cannot grow memory. The remaining retention sites are listener registration on `"add"` (bounded by `off()` in `finish()`), the array (bounded by the cap), and parked long-poll requests (bounded by the 25s timeout, though a closed client does not cancel them early).
- **Related concepts:** resource ceilings vs memory safety; the long-poll listener lifecycle in `server.ts`; rate limiting and input length validation as leak-prevention.

## 2026-10-25: Authorization is a binding, not a field

- **Learner's explanation:** "for one person there would be one chat for the bot, so telegram sends chatId and we know that this body belongs to this chatId... but how would we know that this user has this chatId?"
- **Corrected understanding:** `chatId` is a routing label, not an access-control decision. Routing answers "where does this belong?", authorization answers "is this caller allowed to see it?", and the two use different inputs. Isolation needs three things that a message field cannot supply: a per-requester identity (credential → subject), an ownership binding (subject → allowed chatIds), and enforcement at the handler (filter on read, derive on write).
- **Trust asymmetry (the key insight):** a `chatId` is trustworthy only when it arrives through `getUpdates`, because Telegram asserts it over an authenticated channel. A `chatId` in an extension request is client-written and forgeable. Therefore the server must **derive** the destination from the binding and must never accept `chatId` from a client — otherwise a buggy or hostile extension can address any chat.
- **Identity vs route:** `from.id` is the human (`userId`, bind identity to this); `chat.id` is the conversation (`chatId`, route with this). They are equal in a private chat and differ in groups, so binding the wrong one breaks multi-user as soon as the bot joins a group.
- **Where JWT fits:** enrollment is the source of identity; a JWT is only its container. A JWT does not establish who the user is — something must issue it after a proof. Correct placement: identity (`sub`) in the token, authority (the chat binding) in the database, looked up per request so revocation and rebinding actually work.
- **Enrollment options compared:** config mapping (one entry per user, correct for a handful), pairing code (extension shows a short single-use code, user sends it to the bot, server binds the chat from the trusted side; the WhatsApp Web model; scales without HTTPS hosting), Telegram-proof/Login Widget (seamless but needs an HTTPS-hosted page and HMAC verification).
- **Background delivery is a separate axis from authorization:** server-side buffering loses nothing but is not live; `chrome.alarms` polling runs while Chrome is open; WebSockets from an MV3 service worker are unreliable because idle workers are terminated after ~30s; Web Push can wake the worker but needs HTTPS, VAPID keys, and a push subscription.
- **Related concepts:** the `POST /messages` forged-envelope path in `server.ts` (line 84 reads `body.chatId`); `learning/questions.md` background-delivery decision; the phase-0 spec in `PROTOCOL.md`.
