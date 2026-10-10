// Structural guards on how the dashboard's top-level views are switched.
// Run directly with `node test/topLevelViews.test.js`, same convention as
// every other test here.
//
// app.js is a browser script with no module exports, so it is read as TEXT and
// asserted against structurally - the same approach opsDecisionSpecs.test.js
// takes, and for the same reason: the alternative is a DOM shim for a
// 6000-line file whose failure mode would be the shim, not the code.
//
// What these pin is one invariant: `showTopLevelView` is the ONLY thing that
// decides which top-level view is visible. That is not a style preference. The
// dashboard has grown from two of these views to four, and both bugs it has
// had here came from the same shape - a transition written by hand at one call
// site, which knew about the views that existed when it was written and
// nothing about the ones added later:
//
//   - 8a23389: showLogin() hid #app-view but not #watcher-history-view, added
//     after it, leaving the run-history page rendered full-page below the
//     login form on any background poller's 401.
//   - The popstate handler ran one independent open/close pair per view, each
//     close() revealing #app-view as its assumed fallback, so a pop between
//     the two page-style views would show one and unhide the app under it.
//
// A test that pinned either specific bug would not have caught the other. The
// invariant catches both, and catches the fifth view too.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`NOT OK - ${name}\n    ${err.message}`);
  }
}

// Comments blanked out, offsets preserved (every removed character becomes a
// space, newlines kept), so line numbers in a failure message still point at
// the real line. Needed because the invariant below is described in prose in
// app.js using the very call shape it forbids - without this, the guard's own
// documentation trips it. String state is tracked so a "//" inside a URL like
// wss:// isn't read as the start of a comment.
function blankComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      if (c === "\\") { out += source.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i += 1; continue; }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const appCode = blankComments(appJs);

// Returns [start, end) of a function's body, by brace matching from its
// declaration. Runs on the comment-blanked source, so braces inside prose
// don't throw it off; string literals containing braces would, which the
// sanity test checks for.
function functionBody(source, name) {
  const decl = source.indexOf(`function ${name}(`);
  assert.notStrictEqual(decl, -1, `could not find function ${name}() in app.js - was it renamed?`);
  const open = source.indexOf("{", decl);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return [open, i + 1];
    }
  }
  throw new Error(`unbalanced braces reading ${name}()`);
}

// id -> const name, from app.js's own getElementById lines.
const idToConst = new Map();
for (const m of appCode.matchAll(/const (\w+) = document\.getElementById\("([^"]+)"\)/g)) {
  idToConst.set(m[2], m[1]);
}

// --- the registry matches the markup ---------------------------------------

test("every top-level view in index.html is registered in topLevelViews", () => {
  // Top-level = a direct child of <body>, i.e. indented exactly two spaces.
  // Those are the ones with their own full-page :not([hidden]) rule in
  // style.css, so those are the ones that stack on each other when two are
  // visible at once.
  const markupIds = [...indexHtml.matchAll(/^ {2}<(?:section|div) id="([a-z0-9-]+-view)"/gm)].map((m) => m[1]);
  assert.ok(markupIds.length >= 4, `expected at least the 4 known views, found ${markupIds.length}`);

  const arrayMatch = appCode.match(/const topLevelViews = \[([^\]]+)\]/);
  assert.ok(arrayMatch, "could not find app.js's topLevelViews array - was it renamed?");
  const registered = arrayMatch[1].split(",").map((s) => s.trim()).filter(Boolean);

  for (const id of markupIds) {
    const constName = idToConst.get(id);
    assert.ok(constName, `#${id} is a top-level view in index.html but app.js has no const for it`);
    assert.ok(
      registered.includes(constName),
      `#${id} is a top-level view in index.html but is missing from topLevelViews - ` +
        `it will be left visible underneath whichever view is shown next, which is bug 8a23389 again`
    );
  }
});

// --- nothing else decides visibility ---------------------------------------

test("setHidden() is never called on a top-level view outside showTopLevelView", () => {
  const arrayMatch = appCode.match(/const topLevelViews = \[([^\]]+)\]/);
  const registered = arrayMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
  const [bodyStart, bodyEnd] = functionBody(appCode, "showTopLevelView");

  const offenders = [];
  for (const constName of registered) {
    const re = new RegExp(`setHidden\\(\\s*${constName}\\s*,`, "g");
    for (const m of appCode.matchAll(re)) {
      if (m.index > bodyStart && m.index < bodyEnd) continue;
      offenders.push(`${constName} at line ${appCode.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    "a top-level view's visibility is being set outside showTopLevelView(): " +
      offenders.join(", ") +
      " - that call site hides the views it happens to know about, which is how both stacked-view bugs happened"
  );
});

test("the teardown helpers change no visibility at all", () => {
  // The popstate handler can only pick one destination if leaving a page and
  // choosing where you land are separate. If a teardown helper starts showing
  // something again, the handler is back to two halves racing on order.
  for (const name of ["resetWatcherHistoryState", "stopMonitoringStreams"]) {
    const [start, end] = functionBody(appCode, name);
    const body = appCode.slice(start, end);
    assert.ok(
      !body.includes("setHidden(") && !body.includes("showTopLevelView("),
      `${name}() changes what is visible - it must only tear down state, or the popstate handler cannot own the destination`
    );
  }
});

test("popstate settles on exactly one destination", () => {
  const listener = appCode.match(/window\.addEventListener\("popstate",[\s\S]*?\n\}\);/);
  assert.ok(listener, "could not find the popstate listener");
  const body = listener[0];

  // Show-helpers and the direct app landing are mutually exclusive branches of
  // one if/else chain. Two of them running in sequence is precisely the bug.
  const branches = (body.match(/(?:^|\s)(?:if|else if|else)\s/g) || []).length;
  assert.ok(branches > 0, "popstate has no branching at all - unexpected shape");
  assert.ok(
    !/showWatcherHistory\([\s\S]*?\n\s*showMonitoring\(/.test(body.replace(/else if/g, "ELSEIF")) ||
      body.includes("else if (monitoring"),
    "popstate can run more than one destination in sequence - they must be else-if branches"
  );
  assert.ok(
    body.includes("leftWatcherHistory") && body.includes("leftMonitoring"),
    "popstate no longer computes what it is leaving before moving - those flags must be read before the view changes"
  );
});

test("showLogin discards session-scoped view state, not just the views", () => {
  // Hiding a view is not the same as forgetting what was on it. The dashboard
  // password is SHARED, so anything remembered across showLogin() is shown to
  // whoever logs in next. 8a23389 established this for the run list; the
  // monitoring pane set arrived on a branch cut before that fix and kept its
  // remembered set, so the next operator's Monitoring view reopened on the
  // previous one's chosen workloads.
  const [start, end] = functionBody(appCode, "showLogin");
  const body = appCode.slice(start, end);

  assert.ok(
    body.includes("resetWatcherHistoryState()"),
    "showLogin() no longer clears the run-history paging state - the dead session's runs will reappear on next login"
  );
  assert.ok(
    body.includes("closeAllMonitoringPanes()"),
    "showLogin() no longer closes the log panes - production logs would keep rendering into a page whose session is gone"
  );
  assert.ok(
    /monitoringLastKeys\s*=\s*\[\]/.test(body),
    "showLogin() no longer discards the remembered pane set - the next login restores the previous operator's workloads"
  );
  assert.ok(
    body.includes("passwordInput.value"),
    "showLogin() no longer clears the password field"
  );
});

// --- sanity: the text-matching above is actually finding things ------------

test("sanity: the parser finds the functions it asserts on", () => {
  const [s, e] = functionBody(appCode, "showTopLevelView");
  const body = appCode.slice(s, e);
  assert.ok(body.includes("setHidden("), "showTopLevelView's body should contain the setHidden call");
  assert.ok(e - s < 400, "showTopLevelView's body is suspiciously large - brace matching may have run away");
  assert.ok(idToConst.size > 10, "getElementById parse found almost nothing - app.js shape changed");
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: top-level view switching has exactly one owner");
