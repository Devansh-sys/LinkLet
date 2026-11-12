"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const test = require("node:test");

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local test port.");
  }
  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Test server did not become ready.");
}

async function postJson(baseUrl, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("enrollment and inbound delivery follow the extension client contract", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "linklet-server-test-"));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    PORT: String(port),
    DATA_FILE: join(directory, "state.json"),
    DEV_INGEST: "1",
    JWT_SECRET: "server-test-secret-with-enough-entropy",
  };
  delete environment.TELEGRAM_BOT_TOKEN;

  const child = spawn(process.execPath, ["dist/server.js"], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverErrors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    serverErrors += chunk;
  });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  });

  try {
    await waitForServer(baseUrl, child);
  } catch (error) {
    throw new Error(`${error.message}\n${serverErrors}`);
  }

  const enrollmentResponse = await postJson(baseUrl, "/enroll/start", {});
  assert.equal(enrollmentResponse.status, 201);
  const enrollment = await enrollmentResponse.json();

  const chatId = "integration-test-chat";
  const ingestPairingResponse = await postJson(baseUrl, "/dev/ingest", {
    chatId,
    text: enrollment.code,
    chatType: "private",
  });
  assert.equal(ingestPairingResponse.status, 200);
  assert.equal((await ingestPairingResponse.json()).kind, "enrolled");

  const claimResponse = await postJson(baseUrl, "/enroll/claim", {
    enrollToken: enrollment.enrollToken,
  });
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json();

  const inboundResponse = await postJson(baseUrl, "/dev/ingest", {
    chatId,
    text: "hello extension",
    chatType: "private",
  });
  assert.equal((await inboundResponse.json()).kind, "stored");

  const messagesResponse = await fetch(`${baseUrl}/messages?since=0`, {
    headers: { Authorization: `Bearer ${claim.jwt}` },
  });
  assert.equal(messagesResponse.status, 200);
  const messages = await messagesResponse.json();
  assert.equal(messages.messages.length, 1);
  assert.equal(messages.messages[0].text, "hello extension");
  assert.equal(messages.messages[0].direction, "in");
  assert.equal(messages.nextSince, messages.messages[0].id);

  const sendWithoutTelegramResponse = await postJson(
    baseUrl,
    "/send",
    { text: "reply" },
    claim.jwt,
  );
  assert.equal(sendWithoutTelegramResponse.status, 503);

  const afterFailedSendResponse = await fetch(
    `${baseUrl}/messages?since=0`,
    { headers: { Authorization: `Bearer ${claim.jwt}` } },
  );
  const afterFailedSend = await afterFailedSendResponse.json();
  assert.deepEqual(afterFailedSend.messages, messages.messages);
});
