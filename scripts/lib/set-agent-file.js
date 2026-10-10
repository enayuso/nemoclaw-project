#!/usr/bin/env node
// set-agent-file.js - config-over-RPC pilot (2026-08-03): deploys ONE file
// into an agent's workspace via the gateway's agents.files.set RPC instead
// of docker cp. Standalone, not the dashboard process itself - reuses
// dashboard/node_modules' ws/dotenv rather than duplicating a whole
// dependency tree for one pilot script, and reuses dashboard/.env for the
// same NEMOCLAW_GATEWAY_URL/TOKEN dashboard/src/gatewayClient.js already
// uses (same paired device identity).
//
// Does NOT reuse gatewayClient.js's own connect() - that module hardcodes
// scopes:["operator.read","operator.write"] for the dashboard's own
// persistent connection (deliberately narrow - see routes/ops.js's own
// comment on why the dashboard was never granted operator.pairing either).
// agents.files.set requires operator.admin (confirmed live 2026-08-03: the
// dashboard's own connection gets "missing scope: operator.admin" calling
// it) - a materially more sensitive scope than the dashboard should hold as
// a standing grant. This script requests it explicitly, in its own
// short-lived connection, only for this one pilot task.
//
// Usage: node set-agent-file.js <agentId> <workspaceFileName> <localFilePath>
// Example: node set-agent-file.js api-rag-escalation AGENTS.md ../../rendered/api-rag/escalation-AGENTS.md

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DASHBOARD_DIR = path.join(__dirname, "..", "..", "dashboard");
const WebSocket = require(path.join(DASHBOARD_DIR, "node_modules", "ws"));
require(path.join(DASHBOARD_DIR, "node_modules", "dotenv")).config({
  path: path.join(DASHBOARD_DIR, ".env"),
});

const GATEWAY_URL = process.env.NEMOCLAW_GATEWAY_URL;
const GATEWAY_TOKEN = process.env.NEMOCLAW_GATEWAY_TOKEN;
const REQUEST_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

function fail(message) {
  console.error(`set-agent-file: ${message}`);
  process.exit(1);
}

const [, , agentId, fileName, localPath] = process.argv;
if (!agentId || !fileName || !localPath) {
  fail("usage: node set-agent-file.js <agentId> <workspaceFileName> <localFilePath>");
}
if (!GATEWAY_URL || !GATEWAY_TOKEN) {
  fail("NEMOCLAW_GATEWAY_URL/NEMOCLAW_GATEWAY_TOKEN not set - check dashboard/.env");
}

let content;
try {
  content = fs.readFileSync(localPath, "utf8");
} catch (err) {
  fail(`could not read '${localPath}': ${err.message}`);
}

// Same bare-origin-plus-/ws convention as gatewayClient.js's own
// buildWsTarget() - see that file's comment for why both the path and the
// Origin header matter.
const url = new URL(GATEWAY_URL);
const origin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
const wsUrl = new URL("/ws", GATEWAY_URL.replace(/^ws/, "http"));
wsUrl.protocol = url.protocol;

const ws = new WebSocket(wsUrl.toString(), { headers: { Origin: origin } });
let handshakeDone = false;
let nextRequestId = 1;
const pending = new Map();

const handshakeTimer = setTimeout(() => {
  if (!handshakeDone) fail(`handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`);
}, HANDSHAKE_TIMEOUT_MS);

function call(method, params) {
  const id = `req-${nextRequestId++}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`request '${method}' timed out`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

ws.on("message", async (raw) => {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (!handshakeDone) {
    if (frame.type === "event" && frame.event === "connect.challenge") {
      // Field names/shape confirmed the same way gatewayClient.js's own
      // _respondToChallenge comment documents (2026-07-23, against a real
      // gateway's INVALID_REQUEST schema error) - the only difference here
      // is the scopes array, which is the entire reason this is a separate
      // script rather than reusing that module's connect().
      const params = {
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: "openclaw-control-ui",
          displayName: "set-agent-file pilot script",
          version: "0.1.0",
          platform: process.platform,
          mode: "ui",
          instanceId: crypto.randomUUID(),
        },
        caps: ["tool-events"],
        scopes: ["operator.read", "operator.write", "operator.admin"],
        auth: { token: GATEWAY_TOKEN },
      };
      ws.send(JSON.stringify({ type: "req", id: `handshake-${crypto.randomUUID()}`, method: "connect", params }));
      return;
    }
    if (frame.type === "res" && (frame.method === "connect" || frame.ok === true)) {
      handshakeDone = true;
      clearTimeout(handshakeTimer);
      try {
        const result = await call("agents.files.set", { agentId, name: fileName, content });
        console.log(`set-agent-file: ${fileName} -> ${agentId} workspace: ok`);
        console.log(JSON.stringify(result));
        ws.close();
        process.exit(0);
      } catch (err) {
        fail(`agents.files.set failed: ${err.message}`);
      }
      return;
    }
  }

  if (frame.type === "res" && pending.has(frame.id)) {
    const entry = pending.get(frame.id);
    clearTimeout(entry.timeout);
    pending.delete(frame.id);
    if (frame.ok) entry.resolve(frame.payload);
    else entry.reject(new Error((frame.error && frame.error.message) || "gateway request failed"));
  }
});

ws.on("error", (err) => fail(`socket error: ${err.message}`));
ws.on("close", (code, reason) => {
  if (!handshakeDone) fail(`connection closed before handshake completed (code=${code} reason=${reason || "none"})`);
});
