import { randomBytes, randomUUID } from "node:crypto";

import { loadState, saveState } from "./state";

export type Account = {
  id: string;
  chatId: string;
  createdAt: string;
};

type Pending = {
  code: string;
  enrollToken: string;
  accountId: string;
  expiresAt: number;
  completed: boolean;
};

const CODE_TTL_MS = 5 * 60_000;
const CODE_LENGTH = 6;
/** 32 symbols, and 256 is divisible by 32, so `byte % 32` is unbiased. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type ClaimResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "ok"; account: Account };

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[bytes[index]! % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Pairing state and the account bindings it produces.
 *
 * The binding is written only by `complete()`, which is only reachable from the
 * Telegram ingest path. Nothing in the HTTP API can create a binding, which is
 * what stops an extension from claiming a chat it does not own.
 *
 * Completed bindings survive restarts via the state file; pending codes do not,
 * because they are short-lived credentials and re-running pairing is cheap.
 */
class AccountStore {
  private readonly byCode = new Map<string, Pending>();
  private readonly byToken = new Map<string, Pending>();
  private readonly byChatId = new Map<string, Account>();
  private readonly byId = new Map<string, Account>();

  constructor() {
    this.load();
  }

  start(now: number = Date.now()): { code: string; enrollToken: string; expiresAt: string } {
    this.sweep(now);

    let code = generateCode();
    while (this.byCode.has(code)) {
      code = generateCode();
    }

    const pending: Pending = {
      code,
      enrollToken: randomBytes(32).toString("base64url"),
      accountId: randomUUID(),
      expiresAt: now + CODE_TTL_MS,
      completed: false,
    };

    this.byCode.set(pending.code, pending);
    this.byToken.set(pending.enrollToken, pending);

    return {
      code: pending.code,
      enrollToken: pending.enrollToken,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  /**
   * Called when inbound text arrives. Returns the account if the text matched a
   * live pairing code, otherwise null so the caller stores it as a normal message.
   */
  complete(rawText: string, chatId: string, now: number = Date.now()): Account | null {
    const code = normalizeCode(rawText);
    const pending = this.byCode.get(code);
    if (!pending) {
      return null;
    }

    if (now > pending.expiresAt) {
      this.drop(pending);
      return null;
    }

    // One account per chat: re-enrolling reuses the existing identity.
    const existing = this.byChatId.get(chatId);
    const account: Account =
      existing ?? {
        id: pending.accountId,
        chatId,
        createdAt: new Date(now).toISOString(),
      };

    if (!existing) {
      this.byChatId.set(chatId, account);
      this.byId.set(account.id, account);
      this.save();
    }

    pending.accountId = account.id;
    pending.completed = true;

    return account;
  }

  claim(enrollToken: string, now: number = Date.now()): ClaimResult {
    const pending = this.byToken.get(enrollToken);
    if (!pending) {
      return { status: "expired" };
    }

    if (now > pending.expiresAt) {
      this.drop(pending);
      return { status: "expired" };
    }

    if (!pending.completed) {
      return { status: "pending" };
    }

    const account = this.byId.get(pending.accountId);
    if (!account) {
      return { status: "expired" };
    }

    // Single use: consumed by the first successful claim.
    this.drop(pending);
    return { status: "ok", account };
  }

  get(accountId: string): Account | undefined {
    return this.byId.get(accountId);
  }

  /** Used for logging an account reference without exposing the chatId. */
  forChat(chatId: string): Account | undefined {
    return this.byChatId.get(chatId);
  }

  private drop(pending: Pending): void {
    this.byCode.delete(pending.code);
    this.byToken.delete(pending.enrollToken);
  }

  private load(): void {
    for (const row of loadState().accounts) {
      // The file is the only copy of the binding, so trust it over nothing.
      this.byId.set(row.id, row);
      this.byChatId.set(row.chatId, row);
    }

    if (this.byId.size > 0) {
      console.log(`[accounts] restored ${this.byId.size} account(s)`);
    }
  }

  private save(): void {
    saveState((state) => {
      state.accounts = [...this.byId.values()];
    });
  }

  private sweep(now: number): void {
    for (const pending of [...this.byToken.values()]) {
      if (now > pending.expiresAt) {
        this.drop(pending);
      }
    }
  }
}

export const accounts = new AccountStore();
