import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

const MINIMAL_CONFIG = "provider: openai\nproviders:\n  openai:\n    model: gpt-4o\n";

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-config-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withCwd(directory: string, run: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    await run();
  } finally {
    process.chdir(previous);
  }
}

// ─────────────────────────────────────────
// Local config discovery
// ─────────────────────────────────────────

test("finds the config inside .ai-release-notes/ by default", async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, ".ai-release-notes"), { recursive: true });
    await writeFile(join(directory, ".ai-release-notes", ".ai-release-notes.yml"), MINIMAL_CONFIG, "utf-8");

    await withCwd(directory, async () => {
      const config = await loadConfig();
      assert.equal(config.provider, "openai");
    });
  });
});

test("still finds a root-level dotfile for projects not yet migrated", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, ".ai-release-notes.yml"), MINIMAL_CONFIG, "utf-8");

    await withCwd(directory, async () => {
      const config = await loadConfig();
      assert.equal(config.provider, "openai");
    });
  });
});

test("prefers .ai-release-notes/ over a root-level dotfile when both exist", async () => {
  await withDirectory(async (directory) => {
    await writeFile(
      join(directory, ".ai-release-notes.yml"),
      "provider: anthropic\nproviders:\n  anthropic:\n    model: claude-sonnet-4-20250514\n",
      "utf-8"
    );
    await mkdir(join(directory, ".ai-release-notes"), { recursive: true });
    await writeFile(join(directory, ".ai-release-notes", ".ai-release-notes.yml"), MINIMAL_CONFIG, "utf-8");

    await withCwd(directory, async () => {
      const config = await loadConfig();
      assert.equal(config.provider, "openai");
    });
  });
});

test("resolves instructions beside a config nested in .ai-release-notes/", async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, ".ai-release-notes"), { recursive: true });
    await writeFile(
      join(directory, ".ai-release-notes", ".ai-release-notes.yml"),
      `${MINIMAL_CONFIG}prompt:\n  languages:\n    - en\n  instructions:\n    file: ./.ai-release-instructions.md\n`,
      "utf-8"
    );
    await writeFile(
      join(directory, ".ai-release-notes", ".ai-release-instructions.md"),
      "Write in a friendly tone.",
      "utf-8"
    );

    // process.cwd() reports the realpath after chdir, which on macOS differs
    // from mkdtemp's /tmp-prefixed result (a symlink to /private/tmp).
    const realDirectory = await realpath(directory);

    await withCwd(directory, async () => {
      const config = await loadConfig();
      assert.equal(
        (config.prompt?.instructions as { file: string }).file,
        join(realDirectory, ".ai-release-notes", ".ai-release-instructions.md")
      );
    });
  });
});
