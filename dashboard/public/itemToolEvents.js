// itemToolEvents.js - pure (DOM-free) normalisation of the gateway's
// "item" event stream into the shape renderToolCard already consumes.
//
// Split out of app.js for the same reason revealQueueDiff.js was: none of
// this touches the DOM, and keeping it requireable means
// test/itemToolEvents.test.js can replay REAL captured gateway frames
// through the exact code the browser runs, rather than through a
// reimplementation that can drift from it.
//
// WHY THIS EXISTS AT ALL. A run started from the dashboard goes through
// chat.send and emits stream:"tool" events. A run started by a watcher
// cron does not - it is a one-shot
// `openclaw agent --agent X --session-key Y --message Z`
// (templates/watcher-k8s.sh.tmpl) and emits a completely different event
// set. Live capture 2026-08-06 of a real CLI run with three tool calls
// found ZERO stream:"tool" events, which is why live-viewing a running
// cron escalation from Recents showed no tool cards at all - not even
// wrong ones. Every rule below is derived from those captures, not from
// reading the gateway's source or guessing.
//
// The observed shapes, one tool call each:
//
//   stream:"item"  kind:"tool"     name:"tool_call"    generic wrapper
//   stream:"item"  kind:"tool"     name:"exec"/"read"  the REAL call
//   stream:"item"  kind:"command"  name:"exec"         exec-ONLY duplicate
//                                                      of the real call,
//                                                      same toolCallId
//   stream:"command_output"                            exec-ONLY, the
//                                                      actual output
//
// phase is "start" | "update" | "end" (not the "result" the stream:"tool"
// path uses); status is "running" | "completed" | "failed", all three
// observed live - "failed" via a deliberately failing command, which also
// carries the message in data.error.
//
// Ordering, from the capture: session.message (carrying the arguments)
// always precedes the real tool's "start", and stream:"command_output"
// always arrives AFTER that tool's own "end" (seq 12 vs 10). So arguments
// can be looked up synchronously, but output necessarily re-renders an
// already-completed card.

// Records any tool-call arguments carried by a session.message frame.
// On a CLI/cron run this is the ONLY place a tool's command/path ever
// appears - the tool's own events never carry arguments.
function recordItemToolArgs(store, message) {
  if (!store || !message || !Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (part && part.type === "toolCall" && part.id) {
      store.set(part.id, part.arguments || null);
    }
  }
}

// The session.message part's `id` is the WRAPPER's toolCallId, and that
// id appears as a colon-delimited segment inside the real tool's id
// (tool_search_code:<wrapper-id>:exec:1). Verified 4/4 across two
// captures and two different tools.
//
// Segment-exact rather than a substring scan: the wrapper id is always a
// complete segment, and matching on segments cannot be fooled by an id
// that merely happens to contain another's text.
function lookupItemToolArgs(store, toolCallId) {
  if (!store || typeof toolCallId !== "string") return null;
  const segments = toolCallId.split(":");
  for (const segment of segments) {
    if (store.has(segment)) return store.get(segment);
  }
  return null;
}

// Returns the object to hand to renderToolCard, or null when this event
// should not produce a card at all.
function normalizeItemToolEvent(store, data) {
  if (!data) return null;
  // kind:"command" is exec's duplicate view of a call that kind:"tool"
  // already reported under the SAME toolCallId. Rendering both would
  // double every exec card while leaving non-exec tools single.
  if (data.kind !== "tool") return null;
  // Same wrapper the stream:"tool" path already skips.
  if (data.name === "tool_call") return null;

  const wrapperArgs = lookupItemToolArgs(store, data.toolCallId);
  const inner =
    wrapperArgs && typeof wrapperArgs === "object" && wrapperArgs.args ? wrapperArgs.args : null;
  const ended = data.phase === "end";

  return {
    toolCallId: data.toolCallId,
    name: data.name,
    // renderToolCard keys its running/finished state off phase === "result".
    phase: ended ? "result" : "start",
    isError: data.status === "failed",
    args: inner && typeof inner === "object" ? inner : undefined,
    // Only failures carry their message inline; successful exec output
    // arrives separately on stream:"command_output".
    result:
      ended && typeof data.error === "string" && data.error
        ? { details: { aggregated: data.error } }
        : undefined,
    // Fallback label for tools with no command at all. A `read` call
    // carries only the gateway's human-readable title ("read from
    // /etc/hostname") - confirmed live, its end event has no output
    // field of any kind.
    itemLabel: typeof data.title === "string" ? data.title : null,
  };
}

// exitCode is surfaced only on failure: a successful command reporting
// "exit 0" beside its output is noise, whereas a failing one's code is
// usually the whole story.
function normalizeCommandOutput(data) {
  if (!data || !data.toolCallId) return null;
  const output = typeof data.output === "string" ? data.output : "";
  const failed = data.status === "failed";
  const suffix = failed && typeof data.exitCode === "number" ? `\n(exit code ${data.exitCode})` : "";
  const aggregated = output ? output + suffix : suffix.replace(/^\n/, "");
  return {
    toolCallId: data.toolCallId,
    name: data.name || "exec",
    phase: "result",
    isError: failed,
    result: { details: { aggregated } },
    itemLabel: typeof data.title === "string" ? data.title : null,
  };
}

// No effect in the browser (no `module` global there) - lets
// test/itemToolEvents.test.js require() this exact file directly.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    recordItemToolArgs,
    lookupItemToolArgs,
    normalizeItemToolEvent,
    normalizeCommandOutput,
  };
}
