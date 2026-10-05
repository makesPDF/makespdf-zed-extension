// Unit tests for the src -> data: URI rewrite used by Export to PDF.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatImageFailure,
  inlineLocalImages,
  MAX_IMAGE_BYTES,
  type ImageFailure,
} from "./images.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`;

/** Run `fn` in a fresh temp directory pre-populated with `files`. */
async function withDir<T>(
  files: Record<string, string | Buffer>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "makespdf-images-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(dir, name), contents);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Create an empty file of `size` bytes without materialising its contents. */
async function sparseFile(path: string, size: number): Promise<void> {
  await writeFile(path, "");
  await truncate(path, size);
}

test("rewrites relative and absolute local references, preserving alt text and title", async () => {
  await withDir({ "diagram.png": PNG }, async (dir) => {
    const source = `![diagram](diagram.png "The diagram")\n\n![abs](${join(dir, "diagram.png")})\n`;
    const result = await inlineLocalImages(source, dir);
    assert.deepEqual(result.failures, []);
    assert.equal(
      result.markdown,
      `![diagram](${PNG_URI} "The diagram")\n\n![abs](${PNG_URI})\n`,
    );
  });
});

test("rewrites <img src> in single and double quotes, preserving other attributes", async () => {
  await withDir({ "diagram.png": PNG }, async (dir) => {
    const source = `<img src="diagram.png" alt="x" width="10">\n<img src='diagram.png'>\n`;
    const result = await inlineLocalImages(source, dir);
    assert.deepEqual(result.failures, []);
    assert.equal(
      result.markdown,
      `<img src="${PNG_URI}" alt="x" width="10">\n<img src='${PNG_URI}'>\n`,
    );
  });
});

test("rewrites every reference to the same file and angle-bracketed or percent-encoded srcs", async () => {
  await withDir({ "my diagram.png": PNG }, async (dir) => {
    const source =
      "![one](<my diagram.png>)\n![two](my%20diagram.png)\n![three](<my diagram.png>)\n";
    const result = await inlineLocalImages(source, dir);
    assert.deepEqual(result.failures, []);
    assert.equal(result.markdown, `![one](${PNG_URI})\n![two](${PNG_URI})\n![three](${PNG_URI})\n`);
  });
});

test("leaves remote, data:, file:, protocol-relative, fragment and unknown-extension references alone", async () => {
  await withDir({}, async (dir) => {
    const source = [
      "![remote](https://example.com/x.png)",
      "![plain](http://example.com/x.png)",
      "![inline](data:image/png;base64,AAAA)",
      "![file](file:///tmp/x.png)",
      "![proto](//example.com/x.png)",
      "![fragment](#diagram)",
      "![doc](notes.txt)",
      "",
    ].join("\n");
    const result = await inlineLocalImages(source, dir);
    assert.deepEqual(result.failures, []);
    assert.equal(result.markdown, source);
  });
});

test("leaves image-like text inside fenced blocks and inline code untouched", async () => {
  await withDir({ "diagram.png": PNG }, async (dir) => {
    const source = [
      "![real](diagram.png)",
      "",
      "```md",
      "![fenced](diagram.png)",
      '~~~',
      '<img src="diagram.png">',
      "```",
      "",
      "~~~",
      "<img src='diagram.png'>",
      "~~~",
      "",
      "and `![inline](diagram.png)` too, plus ``<img src=\"diagram.png\">``.",
      "",
    ].join("\n");
    const result = await inlineLocalImages(source, dir);
    assert.deepEqual(result.failures, []);
    assert.equal(
      result.markdown,
      [
        `![real](${PNG_URI})`,
        "",
        "```md",
        "![fenced](diagram.png)",
        '~~~',
        '<img src="diagram.png">',
        "```",
        "",
        "~~~",
        "<img src='diagram.png'>",
        "~~~",
        "",
        "and `![inline](diagram.png)` too, plus ``<img src=\"diagram.png\">``.",
        "",
      ].join("\n"),
    );
  });
});

test("an unreadable file is left as-is and reported as unreadable", async () => {
  await withDir({}, async (dir) => {
    const source = "# Missing\n\n![gone](missing.png)\n";
    const result = await inlineLocalImages(source, dir);
    assert.equal(result.markdown, source);
    assert.deepEqual(result.failures, [{ src: "missing.png", reason: "unreadable" }]);
  });
});

test("a file over 5MB is left as-is and reported as too-large", async () => {
  await withDir({}, async (dir) => {
    await sparseFile(join(dir, "big.png"), MAX_IMAGE_BYTES + 1);
    const source = "![big](big.png)\n";
    const result = await inlineLocalImages(source, dir);
    assert.equal(result.markdown, source);
    assert.deepEqual(result.failures, [{ src: "big.png", reason: "too-large" }]);
  });
});

test("a file exactly at the 5MB limit is inlined", async () => {
  await withDir({}, async (dir) => {
    await sparseFile(join(dir, "limit.png"), MAX_IMAGE_BYTES);
    const result = await inlineLocalImages("![limit](limit.png)\n", dir);
    assert.deepEqual(result.failures, []);
    assert.ok(result.markdown.startsWith("![limit](data:image/png;base64,"));
    assert.ok(!result.markdown.includes("limit.png)"));
  });
});

test("mixed outcomes keep document order in failures and rewrite the readable files", async () => {
  await withDir({ "ok.png": PNG }, async (dir) => {
    await sparseFile(join(dir, "big.png"), MAX_IMAGE_BYTES + 1);
    const source = "![ok](ok.png)\n![big](big.png)\n![gone](gone.jpg)\n";
    const result = await inlineLocalImages(source, dir);
    assert.equal(
      result.markdown,
      `![ok](${PNG_URI})\n![big](big.png)\n![gone](gone.jpg)\n`,
    );
    assert.deepEqual(result.failures, [
      { src: "big.png", reason: "too-large" },
      { src: "gone.jpg", reason: "unreadable" },
    ]);
  });
});

test("formatImageFailure names each failed reference and how to fix it", () => {
  assert.equal(formatImageFailure([]), null);
  assert.equal(
    formatImageFailure([{ src: "missing.png", reason: "unreadable" }]),
    "Export stopped, no PDF was written: 1 local image could not be embedded: " +
      "missing.png (could not be read). Fix or remove the reference and export again.",
  );
  assert.equal(
    formatImageFailure([
      { src: "missing.png", reason: "unreadable" },
      { src: "big.png", reason: "too-large" },
    ]),
    "Export stopped, no PDF was written: 2 local images could not be embedded: " +
      "missing.png (could not be read), big.png (too large to embed, max 5MB). " +
      "Fix or remove these references and export again.",
  );
  const many: ImageFailure[] = Array.from({ length: 12 }, (_, i) => ({
    src: `${i}.png`,
    reason: "unreadable",
  }));
  const message = formatImageFailure(many)!;
  assert.match(message, /^Export stopped, no PDF was written: 12 local images/);
  assert.match(message, /9\.png \(could not be read\) and 2 more\./);
  assert.ok(!message.includes("10.png"), "names past the tenth are counted, not listed");
});

test("failures across markdown and HTML references keep document order", async () => {
  await withDir({}, async (dir) => {
    const source = '<img src="first-missing.png">\n\n![second](second-missing.jpg)\n';
    const result = await inlineLocalImages(source, dir);
    assert.deepEqual(result.failures, [
      { src: "first-missing.png", reason: "unreadable" },
      { src: "second-missing.jpg", reason: "unreadable" },
    ]);
  });
});

test("an <img> lazy-loading from data-src has its real src inlined, not data-src", async () => {
  await withDir({ "diagram.png": PNG }, async (dir) => {
    const source = '<img data-src="diagram.png" src="diagram.png" alt="x">\n';
    const result = await inlineLocalImages(source, dir);
    assert.deepEqual(result.failures, []);
    assert.equal(
      result.markdown,
      `<img data-src="diagram.png" src="${PNG_URI}" alt="x">\n`,
    );
  });
});

test("a valid reference after a malformed one is still inlined", async () => {
  await withDir({ "ok.png": PNG }, async (dir) => {
    const result = await inlineLocalImages("![bad](x ![good](ok.png)\n", dir);
    assert.deepEqual(result.failures, []);
    assert.equal(result.markdown, `![bad](x ![good](${PNG_URI})\n`);
  });
});

test("pathological runs of unterminated references are scanned in linear time", async () => {
  await withDir({}, async (dir) => {
    const sources = [
      "![a](".repeat(200_000),
      "<img ".repeat(200_000),
      `${"![a](x".repeat(200_000)} y)`,
    ];
    for (const source of sources) {
      const started = performance.now();
      const result = await inlineLocalImages(source, dir);
      const elapsed = performance.now() - started;
      assert.equal(result.markdown, source, "nothing is rewritten");
      assert.deepEqual(result.failures, []);
      // The backtracking regexes this replaced took ~13s at 160KB on the
      // first pattern and scaled quadratically, so this bound fails loudly
      // on any regression to super-linear scanning.
      assert.ok(elapsed < 2_000, `scanning ${source.length} chars took ${elapsed}ms`);
    }
  });
});
