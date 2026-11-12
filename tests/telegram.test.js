"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const testDirectory = mkdtempSync(join(tmpdir(), "linklet-tests-"));
process.env.DATA_FILE = join(testDirectory, "state.json");

const { ingestTelegramMessage } = require("../dist/telegram.js");
const { store } = require("../dist/store.js");

test.after(() => {
  rmSync(testDirectory, { recursive: true, force: true });
});

test("inbound text is trimmed and a 4096-character message is stored", () => {
  const chatId = "test-chat-at-limit";
  const text = "x".repeat(4096);

  const result = ingestTelegramMessage({
    chatId,
    text: ` ${text} `,
  });

  assert.equal(result.kind, "stored");
  const messages = store.sinceForChat(chatId, result.id - 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, text);
  assert.equal(messages[0].direction, "in");
});

test("inbound text over 4096 characters is ignored and not stored", () => {
  const chatId = "test-chat-over-limit";
  const cursorBefore = store.cursor;

  const result = ingestTelegramMessage({
    chatId,
    text: "x".repeat(4097),
  });

  assert.deepEqual(result, {
    kind: "ignored",
    reason: "text exceeds 4096 characters",
  });
  assert.equal(store.cursor, cursorBefore);
  assert.deepEqual(store.sinceForChat(chatId, 0), []);
});

test("blank inbound text is ignored and not stored", () => {
  const chatId = "test-chat-blank";
  const cursorBefore = store.cursor;

  const result = ingestTelegramMessage({
    chatId,
    text: " \t\n ",
  });

  assert.deepEqual(result, {
    kind: "ignored",
    reason: "empty text",
  });
  assert.equal(store.cursor, cursorBefore);
  assert.deepEqual(store.sinceForChat(chatId, 0), []);
});

test("non-private inbound text is ignored and not stored", () => {
  const chatId = "test-group-chat";
  const cursorBefore = store.cursor;

  const result = ingestTelegramMessage({
    chatId,
    text: "not a private message",
    chatType: "group",
  });

  assert.deepEqual(result, {
    kind: "ignored",
    reason: "chat type group",
  });
  assert.equal(store.cursor, cursorBefore);
  assert.deepEqual(store.sinceForChat(chatId, 0), []);
});
