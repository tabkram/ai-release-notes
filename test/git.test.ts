import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { getChangelog } from "../src/git.js";

test('"start" reads the full history through the target ref', async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-notes-git-"));
  const git = simpleGit(directory);

  try {
    await git.init();
    await git.addConfig("user.name", "Release Notes Test");
    await git.addConfig("user.email", "release-notes@example.com");

    await writeFile(join(directory, "notes.txt"), "first\n", "utf-8");
    await git.add("notes.txt");
    await git.commit("feat: first change");

    await writeFile(join(directory, "notes.txt"), "first\nsecond\n", "utf-8");
    await git.add("notes.txt");
    await git.commit("fix: second change");
    await git.addTag("v0.23.0");

    assert.deepEqual(await getChangelog("start", "v0.23.0", directory), [
      "fix: second change",
      "feat: first change",
    ]);
  } finally {
    await rm(directory, { recursive: true });
  }
});
