// Shell-safety and flag-correctness test for src/logStream.js's spawn argv -
// run directly with `node test/logStreamSpawnArgs.test.js`. Hermetic.
//
// Why this test exists at all: logStream.js is the ONE place in this
// dashboard that genuinely invokes `sh -c`. Everywhere else, execFile with
// an argv array means arguments never reach a shell and injection is
// structurally impossible - a property routes/ops.js leans on explicitly.
// Here a shell IS involved, so that property has to be re-established
// deliberately, and this test is what pins it.
//
// The value at risk is `label_selector` (and `namespace`) out of
// registry/repos.json. Those are written by register-repo.sh from operator
// input, so "the registry is trusted" is a weaker claim than it sounds -
// and the blast radius is command execution inside the sandbox, against a
// live cluster credential.
//
// The design that makes it safe: the script is a FIXED string with no
// interpolation, and every value travels as its own positional parameter.
// Confirmed live on Server 6 (2026-08-12) that positional parameters
// survive `nemoclaw exec` unevaluated - a selector of `wo rld;$(id)`
// arrived as that literal text rather than a command substitution.
//
// To watch this test earn its keep, change buildArgs() in logStream.js to
// interpolate the selector into SCRIPT (e.g. `... -l ${sel} ...`) and
// re-run: the injection checks below fail immediately.

const assert = require("node:assert");
const path = require("node:path");
const { installFakeSpawn, makeCollector, check, report } = require("./logStreamHarness");

const logStream = require(path.join(__dirname, "..", "src", "logStream.js"));
const { STREAM_TIMEOUT_SECONDS } = logStream._constants;

// Everything that would break a naive shell interpolation, in the two
// fields that actually come from the registry. Same adversarial-content
// approach sandboxWriteRoundTrip.test.js already takes for file writes.
const EVIL_SELECTOR = `app=x'";$(touch /tmp/pwned)\`id\`|& >/tmp/out #`;
const EVIL_NAMESPACE = `dev$(whoami)`;

(async () => {
  const spawns = installFakeSpawn();

  const unsub = logStream.subscribe(
    {
      repoKey: "rag",
      namespace: EVIL_NAMESPACE,
      labelSelector: EVIL_SELECTOR,
      tail: 200,
      maxLogRequests: 5,
    },
    makeCollector().handlers,
  );

  const { bin, args, opts } = spawns.lastArm();

  // --- the shell script itself -------------------------------------------
  const scriptIdx = args.indexOf("-c") + 1;
  const script = args[scriptIdx];

  check("the sh -c script is a fixed string with no interpolated value", () => {
    assert.strictEqual(
      script,
      'echo $$ > "$1"; shift; exec timeout "$@"',
      "the script changed - if that was deliberate, re-verify it cannot carry a value",
    );
  });

  check("no argv element splices a registry value into shell text", () => {
    // The selector must appear ONLY as a standalone argv element. If it ever
    // shows up embedded in a longer string containing shell syntax, that is
    // the injection this whole design exists to prevent.
    for (const arg of args) {
      if (typeof arg !== "string") continue;
      if (arg === EVIL_SELECTOR || arg === EVIL_NAMESPACE) continue;
      assert.ok(
        !arg.includes(EVIL_SELECTOR) && !arg.includes(EVIL_NAMESPACE),
        `registry value embedded inside another argument: ${arg}`,
      );
    }
  });

  check("the selector and namespace are each their own argv element", () => {
    const nsIdx = args.indexOf("-n");
    const selIdx = args.indexOf("-l");
    assert.ok(nsIdx > -1 && selIdx > -1, "-n / -l flags missing");
    assert.strictEqual(args[nsIdx + 1], EVIL_NAMESPACE, "namespace was mangled in transit");
    assert.strictEqual(args[selIdx + 1], EVIL_SELECTOR, "selector was mangled in transit");
  });

  // --- the exec context ---------------------------------------------------
  check("invoked via nemoclaw by FULL path, not a bare name on PATH", () => {
    // The nemoclaw-dashboard systemd unit's PATH has no ~/.local/bin (unlike
    // an interactive shell, which sources .bashrc) - a bare "nemoclaw" here
    // fails with ENOENT the first time this runs in production, exactly as
    // routes/ops.js already found.
    assert.strictEqual(bin, "/home/ops-s006/.local/bin/nemoclaw");
  });

  check("NEMOCLAW_GATEWAY_PORT is set explicitly on the child env", () => {
    // Without it nemoclaw resolves a hardcoded default gateway name, fails
    // to find it, then reports this running sandbox as "does not exist".
    assert.strictEqual(opts.env.NEMOCLAW_GATEWAY_PORT, "8180");
  });

  check("goes through `nemoclaw exec`, never `docker exec`", () => {
    // Confirmed live 2026-08-12: docker exec lands in a different network
    // context and cannot reach the k8s tunnel at all (connection refused),
    // while nemoclaw exec works. This assertion is the guard against
    // someone later "simplifying" this to match routes/ops.js's other calls.
    assert.strictEqual(args[0], "ops-nemoclaw");
    assert.strictEqual(args[1], "exec");
    assert.strictEqual(args[2], "--");
    assert.ok(!args.includes("docker"), "a docker exec path crept in");
  });

  // --- the orphan guard ---------------------------------------------------
  check("the pidfile is written and the timeout cap is applied", () => {
    const pidPath = args[scriptIdx + 2]; // after script, after $0 placeholder
    assert.match(pidPath, /^\/tmp\/dashlogs-[0-9a-f-]+\.pid$/, `unexpected pidfile: ${pidPath}`);
    assert.strictEqual(
      args[scriptIdx + 3],
      String(STREAM_TIMEOUT_SECONDS),
      "the timeout cap is not the first argument to timeout(1)",
    );
  });

  check("$0 placeholder is present so $1 really is the pidfile", () => {
    // `sh -c <script> <arg0> <arg1>...` assigns the FIRST following argument
    // to $0, not $1. Without the placeholder every positional shifts by one
    // and the pidfile silently becomes $0 - the stream would still appear to
    // work while writing its pidfile nowhere.
    assert.strictEqual(args[scriptIdx + 1], "_");
  });

  // --- kubectl flags whose defaults are traps -----------------------------
  check("--tail is explicit (its default is 10 whenever a selector is used)", () => {
    assert.ok(args.includes("--tail=200"), `--tail missing from: ${args.join(" ")}`);
  });

  check("--max-log-requests is explicit (default 5 is an error, not a truncation)", () => {
    assert.ok(args.includes("--max-log-requests=5"));
  });

  check("--timestamps is present (reattach continuity and de-dup depend on it)", () => {
    assert.ok(args.includes("--timestamps"));
  });

  check("--prefix and --all-containers are present for multi-pod workloads", () => {
    assert.ok(args.includes("--prefix"));
    assert.ok(args.includes("--all-containers=true"));
  });

  check("read-only kubeconfig is pinned explicitly", () => {
    assert.ok(args.includes("--kubeconfig=/sandbox/.kube/config"));
    assert.ok(args.includes("/sandbox/.local/bin/kubectl"), "kubectl must be called by full path - it is not on PATH in the sandbox");
  });

  check("no write verb, exec, or port-forward can appear in a log stream", () => {
    // Cheap standing guard on the RBAC boundary's intent: this module has no
    // business ever emitting anything but `logs`.
    //
    // Scoped to the kubectl tail of argv, NOT the whole array: `exec` and
    // `--` appear earlier as nemoclaw's own subcommand, so a whole-argv
    // scan reports a false positive on every healthy stream. (It did on the
    // first run of this test.)
    const kubectlIdx = args.indexOf("/sandbox/.local/bin/kubectl");
    const kubectlArgs = args.slice(kubectlIdx);
    assert.strictEqual(kubectlArgs[2], "logs", "kubectl verb is not `logs`");
    const verbs = ["create", "delete", "patch", "apply", "scale", "exec", "port-forward", "rollout"];
    for (const v of verbs) {
      assert.ok(!kubectlArgs.includes(v), `unexpected kubectl verb in argv: ${v}`);
    }
  });

  unsub();
  spawns.restore();
  report();
})().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
