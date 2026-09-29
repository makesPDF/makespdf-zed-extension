import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, mergeSettings, sendableToken, tokenAllowedFor } from "./settings.ts";

test("defaults match the VS Code plugin's settings", () => {
  assert.deepEqual(mergeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings({}), {
    serviceUrl: "https://makespdf.com",
    apiToken: "",
    pageSize: "A4",
    fontFamily: "Inter",
    fontSize: 10,
    margins: [40, 40, 40, 40],
  });
});

test("valid settings are carried through, with the key trimmed", () => {
  assert.deepEqual(
    mergeSettings({
      serviceUrl: "http://127.0.0.1:8080/",
      apiToken: "  key_123  ",
      pageSize: "Letter",
      fontFamily: "NotoSans",
      fontSize: 12,
      margins: [10, 20, 30, 40],
    }),
    {
      serviceUrl: "http://127.0.0.1:8080/",
      apiToken: "key_123",
      pageSize: "Letter",
      fontFamily: "NotoSans",
      fontSize: 12,
      margins: [10, 20, 30, 40],
    },
  );
});

test("each invalid field falls back individually", () => {
  assert.deepEqual(
    mergeSettings({
      serviceUrl: "   ",
      apiToken: 42,
      pageSize: "A0",
      fontFamily: "ComicSans",
      fontSize: 25,
      margins: [1, 2, 3],
    }),
    DEFAULT_SETTINGS,
  );
});

test("font size is bounded to 6..24 like the server schema", () => {
  assert.equal(mergeSettings({ fontSize: 6 }).fontSize, 6);
  assert.equal(mergeSettings({ fontSize: 24 }).fontSize, 24);
  // The server schema accepts any number in range, never just integers.
  assert.equal(mergeSettings({ fontSize: 10.5 }).fontSize, 10.5);
  assert.equal(mergeSettings({ fontSize: 5 }).fontSize, 10);
  assert.equal(mergeSettings({ fontSize: 25 }).fontSize, 10);
  assert.equal(mergeSettings({ fontSize: Number.NaN }).fontSize, 10);
});

test("margins must be four non-negative numbers", () => {
  assert.deepEqual(mergeSettings({ margins: [0, 0, 0, 0] }).margins, [0, 0, 0, 0]);
  assert.deepEqual(mergeSettings({ margins: [1, 2, 3, "4"] }).margins, [40, 40, 40, 40]);
  assert.deepEqual(mergeSettings({ margins: [1, -2, 3, 4] }).margins, [40, 40, 40, 40]);
});

test("the token only goes to makesPDF origins and loopback addresses", () => {
  for (const url of [
    "https://makespdf.com",
    "https://makespdf.com/",
    "https://staging.makespdf.com",
    "http://localhost:8788",
    "http://127.0.0.1:1234/",
    "http://[::1]:8788",
  ]) {
    assert.equal(tokenAllowedFor(url), true, url);
  }
  for (const url of [
    "http://makespdf.com",
    "https://makespdf.com.evil.example",
    "https://evil.example",
    "https://evil.example/?https://makespdf.com",
    "https://localhost.evil.example",
    "not a url",
  ]) {
    assert.equal(tokenAllowedFor(url), false, url);
  }
});

test("a project that redirects serviceUrl does not receive the user's token", () => {
  const redirected = mergeSettings({ serviceUrl: "https://evil.example", apiToken: "key_123" });
  assert.equal(sendableToken(redirected), "");
  assert.equal(sendableToken(mergeSettings({ apiToken: "key_123" })), "key_123");
  assert.equal(sendableToken(mergeSettings({})), "");
});
