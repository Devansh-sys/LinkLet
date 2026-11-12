import { EventEmitter } from "node:events";

import { loadState, saveState } from "./state";

export type Direction = "in" | "out";

export type LinkMessage = {
  id: number;
  text: string;
  direction: Direction;
  chatId: string;
  createdAt: string;
};

/** Oldest messages are dropped once the buffer is full. */
const MAX_MESSAGES = 500;

/**
 * In-memory, append-only message log with monotonically increasing ids.
 *
 * Ids are never reused, which is what makes the `since` cursor safe: a client
 * that last saw id 42 asks for everything > 42 and cannot miss or double-read.
 * The counter is persisted, so a restart resumes numbering instead of handing
 * out ids a client has already consumed.
 *
 * Message text is deliberately not persisted in v1; swap this class for SQLite
 * when restarts must preserve unread history.
 */
class MessageStore extends EventEmitter {
  private messages: Array<LinkMessage> = [];
  private lastId = 0;

  constructor() {
    super();
    // Every open long-poll adds a listener, so the default cap of 10 is too low.
    this.setMaxListeners(0);

    this.lastId = loadState().lastMessageId;
    if (this.lastId > 0) {
      console.log(`[store] resuming message ids at ${this.lastId}`);
    }
  }

  add(input: { text: string; direction: Direction; chatId: string }): LinkMessage {
    const message: LinkMessage = {
      id: ++this.lastId,
      text: input.text,
      direction: input.direction,
      chatId: input.chatId,
      createdAt: new Date().toISOString(),
    };

    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
    }

    saveState((state) => {
      state.lastMessageId = this.lastId;
    });

    this.emit("add", message);
    return message;
  }

  /**
   * Messages for one chat strictly newer than `cursor`, oldest first.
   * The chat filter is part of the read, not something a caller could forget.
   * Passing `direction` narrows it further; `/messages` passes `"in"` so a client
   * never reads back what it just sent.
   */
  sinceForChat(chatId: string, cursor: number, direction?: Direction): Array<LinkMessage> {
    return this.messages.filter(
      (message) =>
        message.chatId === chatId &&
        message.id > cursor &&
        (direction === undefined || message.direction === direction),
    );
  }

  /** Highest id ever issued, including messages already evicted from the buffer. */
  get cursor(): number {
    return this.lastId;
  }
}

export const store = new MessageStore();
