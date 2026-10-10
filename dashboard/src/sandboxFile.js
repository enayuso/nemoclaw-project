// sandboxFile.js - writing a file INTO the sandbox container from the
// dashboard, without ever putting its content on a command line.
//
// Split out of routes/ops.js for the same reason public/revealQueueDiff.js
// was split out of app.js: this has no dependency on config/auth/the gateway
// client, so test/sandboxWriteRoundTrip.test.js can require it directly
// without a populated .env, which requiring the whole route module would
// demand (confirmed - it fails at config load on any machine that isn't
// Server 6).

const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

// The real constraint on this approach is Linux's MAX_ARG_STRLEN - 131072
// bytes for a SINGLE argument (32 pages), which is a much lower and much
// less well-known ceiling than the ~2MB total ARG_MAX. Measured directly
// against Server 6 on 2026-08-05: 122880 bytes of base64 in one `sh -c`
// argument goes through, 131072 fails with a bare E2BIG ("argument list too
// long") that reads like a docker fault rather than a size one. base64
// inflates by 4/3, so a single-shot write tops out around 96KB of content.
//
// Rather than cap at that, anything larger is streamed in chunks: the base64
// TEXT is appended to a temp file across several execs and decoded once at
// the end. Chunking the base64 text (not the decoded bytes) is what makes
// the split safe - no chunk has to land on a 4-character base64 boundary,
// because nothing decodes until the whole thing is reassembled.
//
// Worth the extra code because the denials file goes through here and grows
// by one entry per denial forever. A hard cap would mean that, at some
// unknown future point, denials silently start failing - and a failed denial
// write is exactly what leaves a repo's watcher frozen (see routes/ops.js's
// own comment on why that file is what releases the stage-4 gate). That's
// not a failure mode worth accepting to save fifteen lines.
const ARG_CHUNK_B64_BYTES = 60 * 1024;

// Content goes in as base64 in an argument and is decoded in the container.
// The content here is agent-authored (incident text, patch bodies) and can
// contain quotes, newlines, backticks, "$(...)" - anything. base64's
// alphabet is shell-inert, so the only interpolated values are ones the
// caller built. execFile's own `input` option doesn't exist (that's
// execFileSync), which is the other reason not to reach for stdin here.
async function writeSandboxFile(container, absPath, content) {
  const dir = absPath.slice(0, absPath.lastIndexOf("/"));
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const run = (script) =>
    execFileAsync("docker", ["exec", container, "sh", "-c", script], {
      maxBuffer: 32 * 1024 * 1024,
    });

  if (b64.length <= ARG_CHUNK_B64_BYTES) {
    await run(`mkdir -p '${dir}' && printf '%s' '${b64}' | base64 -d > '${absPath}'`);
    return;
  }

  // Temp name is random so two concurrent writes can't interleave into one
  // another's buffer. base64's alphabet contains no quote, so every
  // interpolation below is still shell-inert.
  const tmp = `/tmp/.dashboard-write-${crypto.randomUUID()}.b64`;
  try {
    await run(`mkdir -p '${dir}' && : > '${tmp}'`);
    for (let i = 0; i < b64.length; i += ARG_CHUNK_B64_BYTES) {
      await run(`printf '%s' '${b64.slice(i, i + ARG_CHUNK_B64_BYTES)}' >> '${tmp}'`);
    }
    await run(`base64 -d '${tmp}' > '${absPath}'`);
  } finally {
    await run(`rm -f '${tmp}'`).catch(() => {});
  }
}

module.exports = { writeSandboxFile, ARG_CHUNK_B64_BYTES };
