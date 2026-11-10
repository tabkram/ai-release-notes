import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveProviderConfig } from "../src/config.js";

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

const MINIMAL_CONFIG = "provider: openai\nproviders:\n  openai:\n    model: gpt-4o\n";

test("runtime provider options override only the values supplied", () => {
  assert.deepEqual(
    resolveProviderConfig(
      {
        model: "mistral-large-latest",
        baseURL: "https://api.example.com/v1",
        temperature: 0.3,
        maxTokens: 4000,
      },
      { model: "ministral-3b-latest", maxTokens: 2000 }
    ),
    {
      model: "ministral-3b-latest",
      baseURL: "https://api.example.com/v1",
      temperature: 0.3,
      maxTokens: 2000,
    }
  );
});

test("runtime provider options ignore absent values and validate overrides", () => {
  assert.deepEqual(
    resolveProviderConfig({ model: "gpt-4o", temperature: 0.3 }, {}),
    { model: "gpt-4o", temperature: 0.3 }
  );
  assert.throws(
    () => resolveProviderConfig({ model: "gpt-4o" }, { temperature: 3 }),
    /Too big/
  );
});

test("retry settings remain optional for existing provider configurations", () => {
  assert.deepEqual(resolveProviderConfig({ model: "gpt-4o" }, {}), { model: "gpt-4o" });
});

test("retry settings survive provider resolution and explicit overrides", () => {
  assert.deepEqual(
    resolveProviderConfig({ model: "gpt-4o", maxRetries: 5, initialRetryDelayMs: 5000 }, {}),
    { model: "gpt-4o", maxRetries: 5, initialRetryDelayMs: 5000 }
  );
  assert.deepEqual(
    resolveProviderConfig({ maxRetries: 5, initialRetryDelayMs: 5000 }, { maxRetries: 0, initialRetryDelayMs: 0 }),
    { maxRetries: 0, initialRetryDelayMs: 0 }
  );
});

test("rejects negative, fractional, and non-finite retry settings", () => {
  for (const key of ["maxRetries", "initialRetryDelayMs"] as const) {
    for (const value of [-1, 1.5, Infinity, NaN]) {
      assert.throws(() => resolveProviderConfig({ [key]: value }, {}));
    }
  }
});

test("loads retry settings from the selected provider's YAML configuration", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "config.yml");
    await writeFile(path, `${MINIMAL_CONFIG}    maxRetries: 5\n    initialRetryDelayMs: 5000\n`, "utf-8");
    const config = await loadConfig(path);
    assert.equal(config.providers.openai.maxRetries, 5);
    assert.equal(config.providers.openai.initialRetryDelayMs, 5000);
  });
});

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
