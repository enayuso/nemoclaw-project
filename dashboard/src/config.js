// config.js - loads and validates dashboard/.env at startup. Fails fast
// with every missing var listed at once (same shape as bootstrap.sh's
// REQUIRED_VARS check), not one-at-a-time - so a fresh setup doesn't have
// to restart the server repeatedly just to discover the next missing key.
//
// Uses the `dotenv` package rather than the built-in
// process.loadEnvFile() - confirmed live 2026-07-23 that Server 6 runs
// Node v18.19.1, below the v20.6 minimum that function needs. Don't
// switch back to the built-in without re-confirming the real host's
// node version first.

const path = require("node:path");
const dotenv = require("dotenv");

const ENV_PATH = path.join(__dirname, "..", ".env");

const result = dotenv.config({ path: ENV_PATH });
if (result.error && result.error.code !== "ENOENT") {
  throw result.error;
}
// A missing .env file (ENOENT) falls through silently here - the
// REQUIRED_VARS check below reports exactly what's missing rather than
// crashing on a bare stat error.

const REQUIRED_VARS = [
  "NEMOCLAW_GATEWAY_URL",
  "NEMOCLAW_GATEWAY_TOKEN",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_SESSION_SECRET",
  "DASHBOARD_PORT",
];

const missing = REQUIRED_VARS.filter((name) => !process.env[name]);

// TLS key/cert must be set together or not at all - one without the other
// is almost certainly a copy-paste mistake, not an intentional plaintext
// choice, and deserves its own clear error rather than a confusing TLS
// failure later.
const tlsKey = process.env.DASHBOARD_TLS_KEY || "";
const tlsCert = process.env.DASHBOARD_TLS_CERT || "";
if ((tlsKey && !tlsCert) || (!tlsKey && tlsCert)) {
  missing.push(
    "DASHBOARD_TLS_KEY and DASHBOARD_TLS_CERT (must both be set, or both left empty)",
  );
}

if (missing.length > 0) {
  console.error(
    `config: missing/incomplete required vars in ${ENV_PATH}:\n` +
      missing.map((name) => `  - ${name}`).join("\n"),
  );
  process.exit(1);
}

const useTls = Boolean(tlsKey && tlsCert);

if (!useTls) {
  console.warn(
    "config: DASHBOARD_TLS_KEY/DASHBOARD_TLS_CERT not set - starting in " +
      "PLAINTEXT HTTP. Fine for local-only testing, NOT fine once the " +
      "router port-forward is live - credentials and the session cookie " +
      "would transit the open internet unencrypted. See README.md.",
  );
}

module.exports = {
  gatewayUrl: process.env.NEMOCLAW_GATEWAY_URL,
  gatewayToken: process.env.NEMOCLAW_GATEWAY_TOKEN,
  dashboardPassword: process.env.DASHBOARD_PASSWORD,
  sessionSecret: process.env.DASHBOARD_SESSION_SECRET,
  port: Number(process.env.DASHBOARD_PORT),
  useTls,
  tlsKeyPath: tlsKey,
  tlsCertPath: tlsCert,
};
