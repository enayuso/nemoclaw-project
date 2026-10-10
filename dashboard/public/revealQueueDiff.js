// revealQueueDiff.js - vanilla JS, no build step, loaded via a plain
// <script> tag in index.html BEFORE app.js (see index.html - both files
// share one global scope, same as marked/purify's own vendor scripts).
//
// Split out of app.js on its own: unlike the rest of that file, these
// functions have no DOM dependency of their own (findContentMatchEnd,
// normalizeWhitespace and extractSnapshotText are pure; pushSnapshotDiff only
// touches its `queue` parameter) - moving them here lets
// test/revealQueueDiff.test.js require() this file directly in plain Node,
// without needing to shim out app.js's much larger top-level browser surface
// (DOM queries, WS/fetch calls) just to reach a few string functions.

// Walks fullText/previousSnapshot together, treating any whitespace difference
// between them as a reformatting artifact rather than a content change.
// Confirmed live via captured frame data (0730, second occurrence): the gateway
// re-delivered a growing cumulative snapshot with "Let me" resent as "Let\nme" -
// a single substituted character three characters into the string, nowhere near
// the boundary where new content was actually being added. That one substitution
// fails a strict character-for-character startsWith check even though the
// content hasn't materially changed there, and the genuinely new text (" errors.")
// was sitting right after it. Returns the index into fullText where
// previousSnapshot's content has been fully matched (i.e. where truly NEW
// content begins), or -1 if a real, non-whitespace difference was hit first -
// meaning this isn't a reformatting artifact, it's actually different content.
//
// 0805: the whitespace tolerance used to require whitespace on BOTH sides at
// once (a newline matching a space), which only covers SUBSTITUTED whitespace.
// A real capture that day - the reply to a dashboard Deny click - had the same
// text re-delivered with whitespace INSERTED where the other side had none:
// streamed as "Understood — ..." but re-announced as "Under\n\nstood — ...",
// because the gateway had split that one message into four content parts
// (["", "\n\nUnder", "", "stood — ..."]) and extractFinalText joins parts with
// "\n\n". One-sided insertion hit the `return -1` below - reported as genuinely
// new content - so the whole response was appended a second time, cut mid-word
// exactly at the part boundary. Skipping a whitespace run on EITHER side (not
// only both) makes the comparison whitespace-insensitive in the direction that
// actually occurs, which is the property this function was always reaching for.
// Progress is still guaranteed: the branch only fires when at least one side is
// whitespace, and that side's run always advances at least one character.
function findContentMatchEnd(fullText, previousSnapshot) {
  let i = 0;
  let j = 0;
  while (i < fullText.length && j < previousSnapshot.length) {
    if (fullText[i] === previousSnapshot[j]) {
      i++;
      j++;
      continue;
    }
    if (/\s/.test(fullText[i]) || /\s/.test(previousSnapshot[j])) {
      while (i < fullText.length && /\s/.test(fullText[i])) i++;
      while (j < previousSnapshot.length && /\s/.test(previousSnapshot[j])) j++;
      continue;
    }
    return -1;
  }
  // Trailing whitespace on previousSnapshot that fullText simply ran out
  // before reaching is still a full match - same reasoning as the loop
  // above, just at the end of the string where the loop can't reach it.
  while (j < previousSnapshot.length && /\s/.test(previousSnapshot[j])) j++;
  return j === previousSnapshot.length ? i : -1;
}

// Comparison key for whitespace-insensitive containment - the same tolerance
// findContentMatchEnd applies to the prefix case, in the form String.includes()
// can use. Used by app.js's reconcileTranscriptText for its "is this snapshot a
// redundant re-delivery of text already shown?" check, which was a strict
// includes() and so missed a re-delivery whose only difference was an injected
// part-boundary "\n\n" (see the 0805 note above).
//
// Strips whitespace outright rather than collapsing runs to a single space:
// collapsing still fails the case this exists for, because the injected
// whitespace landed INSIDE a word ("Under\n\nstood" collapses to "Under stood",
// which is still not a substring of "Understood"). Zero-length is exactly what
// findContentMatchEnd's own elastic runs already treat whitespace as matching.
// For COMPARISON only - never for anything rendered.
function stripWhitespace(text) {
  return text.replace(/\s+/g, "");
}

// Reconstructs the cumulative text of one message from its `content` array.
// Joined with "" and NOT "\n\n": the parts of a single message are stream
// fragments, not paragraphs - a real 0805 capture split the word "Understood"
// across two of them ("\n\nUnder" + "stood — ..."), so any injected separator
// lands mid-word. Whatever real paragraph breaks the model wrote are already
// literal "\n\n" characters inside the parts themselves. Same reasoning (and
// same conclusion) as extractHistoryText's own join in app.js, which was fixed
// this way on 0728 for the replay path while this live path kept reading only
// content[0].
//
// Returns null - not "" - when there's no usable text, so a caller can tell
// "this frame carries no snapshot" apart from "this frame says the text so far
// is empty". app.js depends on that distinction: it assigns the result to
// lastTranscriptSnapshot, and a frame whose content[0] happened to be an empty
// part used to reset that back to "", after which every later frame diffed the
// full response against nothing and re-pushed all of it. That was the actual
// root cause of the duplicated reply reported 0805.
function extractSnapshotText(content) {
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(
      (part) =>
        part &&
        part.type !== "thinking" &&
        typeof part.text === "string" &&
        part.text,
    )
    .map((part) => part.text)
    .join("");
  return text || null;
}

// This is the THIRD confirmed instance of the glue-text bug class (see the
// two "session.message glue"/"chat state:final glue" fixes in app.js's own
// history) - each previous fix added an explicit turn-boundary flag for one
// more specific event type (chat state:"final", then session.message), but
// a real run on 2026-07-24 showed it recurring yet again for reasoning
// narration that arrives without triggering either of those flags. Rather
// than chase a fourth specific event name, this fixes it structurally: a
// mismatched snapshot (fullText doesn't extend previousSnapshot) IS a turn
// boundary, full stop, regardless of which event delivered it or whether
// renderFrame() (app.js) knows to flag it explicitly. Previously this
// branch called queue.reset() - wiping everything already revealed and
// re-typing just the new text from scratch - which is exactly what "the
// thinking text appears/disappears randomly" was: every unrecognized
// boundary blanked the pane. Appending (with a break, since nothing else
// marked this one) instead of wiping fixes both the flicker and the
// sibling zero-separator gluing bug at the same root cause, for ANY
// boundary-carrying event - known or not yet discovered.
function pushSnapshotDiff(queue, fullText, previousSnapshot) {
  if (fullText.startsWith(previousSnapshot)) {
    queue.push(fullText.slice(previousSnapshot.length));
    return;
  }
  const matchEnd = findContentMatchEnd(fullText, previousSnapshot);
  if (matchEnd !== -1) {
    queue.push(fullText.slice(matchEnd));
    return;
  }
  queue.push((queue.hasContent() ? "\n\n" : "") + fullText);
}

// No effect in the browser (no `module` global there) - lets
// test/revealQueueDiff.test.js require() this exact file directly.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    findContentMatchEnd,
    pushSnapshotDiff,
    stripWhitespace,
    extractSnapshotText,
  };
}
