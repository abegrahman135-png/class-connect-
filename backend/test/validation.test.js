import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanText,
  normalizeInvite,
  allowedMime
} from "../src/index.js";

test("trims valid display names", () => {
  assert.equal(cleanText("  Priya  ", 1, 60, "Name"), "Priya");
});

test("rejects empty names", () => {
  assert.throws(() => cleanText("   ", 1, 60, "Name"));
});

test("rejects oversized messages", () => {
  assert.throws(() => cleanText("x".repeat(4001), 0, 4000, "Message"));
});

test("normalizes invitation codes", () => {
  assert.equal(normalizeInvite("abcd-efgh"), "ABCDEFGH");
});

test("accepts supported MediaRecorder MIME parameters", () => {
  assert.equal(allowedMime("audio/webm;codecs=opus"), "audio/webm");
});

test("rejects active document types", () => {
  assert.throws(() => allowedMime("text/html"));
  assert.throws(() => allowedMime("image/svg+xml"));
  assert.throws(() => allowedMime("application/javascript"));
});
