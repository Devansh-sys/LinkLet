import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { dataFile } from "./config";

export type PersistedAccount = {
  id: string;
  chatId: string;
  createdAt: string;
};

export type PersistedState = {
  version: 1;
  /** Highest message id ever issued, so ids are not reused across restarts. */
  lastMessageId: number;
  accounts: Array<PersistedAccount>;
};

function emptyState(): PersistedState {
  return { version: 1, lastMessageId: 0, accounts: [] };
}

function isAccount(value: unknown): value is PersistedAccount {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.chatId === "string" &&
    typeof candidate.createdAt === "string"
  );
}

/**
 * The small amount of state that must outlive a process restart.
 *
 * Neither message text nor pending pairing codes are written here: text is user
 * content, and pending codes are short-lived credentials. A restart therefore
 * keeps identities and id monotonicity, not unread history.
 */
export function loadState(): PersistedState {
  let raw: string;
  try {
    raw = readFileSync(dataFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[state] cannot read ${dataFile}:`, (error as Error).message);
    }
    return emptyState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const lastMessageId =
      Number.isSafeInteger(parsed.lastMessageId) && (parsed.lastMessageId as number) >= 0
        ? (parsed.lastMessageId as number)
        : 0;
    const accounts = Array.isArray(parsed.accounts)
      ? parsed.accounts.filter(isAccount)
      : [];

    return { version: 1, lastMessageId, accounts };
  } catch (error) {
    // A corrupt file must not stop the server; worst case, users re-pair.
    console.error(`[state] ignoring malformed ${dataFile}:`, (error as Error).message);
    return emptyState();
  }
}

/**
 * Read-modify-write one section of the state file.
 *
 * Synchronous on purpose: Node runs this on one thread, so two saves in the same
 * tick cannot interleave and clobber each other's section.
 */
export function saveState(patch: (state: PersistedState) => void): void {
  const state = loadState();
  patch(state);

  const temporary = `${dataFile}.tmp`;
  try {
    mkdirSync(dirname(dataFile), { recursive: true });
    // Write-then-rename: a crash mid-write can never leave a half file.
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, dataFile);
  } catch (error) {
    console.error(`[state] cannot write ${dataFile}:`, (error as Error).message);
  }
}
