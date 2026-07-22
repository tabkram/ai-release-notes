import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOutputIndexLanguages } from "../src/output-index.js";

test("discovers indexes in previously generated language folders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-indexes-"));
  const placeholder = "aireleasenoteslanguageplaceholder";

  try {
    await mkdir(join(directory, "PROD", "en"), { recursive: true });
    await mkdir(join(directory, "PROD", "fr"), { recursive: true });
    await mkdir(join(directory, "PROD", "draft"), { recursive: true });
    await writeFile(join(directory, "PROD", "en", "index.html"), "English");
    await writeFile(join(directory, "PROD", "fr", "index.html"), "French");

    const discovered = await discoverOutputIndexLanguages(
      join(directory, "PROD", placeholder, "index.html"),
      placeholder
    );

    assert.deepEqual(
      discovered.map(({ language }) => language),
      ["en", "fr"]
    );
    assert.deepEqual(
      discovered.map(({ path }) => path),
      [
        join(directory, "PROD", "en", "index.html"),
        join(directory, "PROD", "fr", "index.html"),
      ]
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("discovers languages when the placeholder is part of the index filename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-indexes-"));
  const placeholder = "aireleasenoteslanguageplaceholder";

  try {
    await writeFile(join(directory, "INDEX_en.md"), "English");
    await writeFile(join(directory, "INDEX_it.md"), "Italian");
    await writeFile(join(directory, "README.md"), "Ignore me");

    const discovered = await discoverOutputIndexLanguages(
      join(directory, `INDEX_${placeholder}.md`),
      placeholder
    );

    assert.deepEqual(
      discovered.map(({ language }) => language),
      ["en", "it"]
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
