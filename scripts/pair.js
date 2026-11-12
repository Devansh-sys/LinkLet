#!/usr/bin/env node
/**
 * Pairing helper: starts enrollment, prints the code, waits for it to arrive via
 * Telegram, then prints a JWT. Uses only the public HTTP API, so it exercises the
 * same path the extension will.
 *
 *   npm run pair
 *   BASE_URL=http://localhost:3100 npm run pair
 *
 * This is a development convenience, not part of the protocol.
 */
"use strict";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 5 * 60 * 1000;

async function main() {
  let start;
  try {
    start = await postJson("/enroll/start", {});
  } catch (error) {
    console.error(`Could not reach ${BASE_URL}/enroll/start`);
    console.error(`  ${error.message}`);
    process.exit(1);
  }

  console.log("");
  console.log("  Pairing code:  " + start.code);
  console.log("");
  console.log("  Send that code to your bot in Telegram within 5 minutes.");
  console.log("  Waiting" + ".".repeat(3));
  console.log("");

  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const response = await fetch(`${BASE_URL}/enroll/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollToken: start.enrollToken }),
    });

    if (response.status === 202) {
      continue;
    }

    const body = await response.json();

    if (response.status === 410) {
      console.error("  Code expired before it was used. Run the command again.");
      process.exit(1);
    }

    if (!response.ok) {
      console.error("  Pairing failed:", body.error?.code ?? response.status);
      process.exit(1);
    }

    console.log("  Paired. accountId=" + body.accountId);
    console.log("");
    console.log("  JWT (send as: Authorization: Bearer <jwt>):");
    console.log("");
    console.log("  " + body.jwt);
    console.log("");
    return;
  }

  console.error("  Timed out waiting for the code.");
  process.exit(1);
}

async function postJson(path, payload) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
