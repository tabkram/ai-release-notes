import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { normalizeEnvironment } from "./output-path.js";

export const GenerationStateSchema = z.object({
  operation: z.enum(["generate", "promote"]),
  date: z.string(),
  status: z.enum(["pending", "complete"]).default("pending"),
  requestHash: z.string().optional(),
  files: z.record(z.string(), z.object({ hash: z.string(), sourceHash: z.string().optional() })),
  indexes: z.record(z.string(), z.boolean()),
  pending: z.array(z.string()).default([]),
});

export const ReleaseStateEntrySchema = z.object({
  environment: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  revision: z.string().optional(),
  deployment: z.object({ date: z.string(), notesSkipped: z.boolean() }).optional(),
  generation: GenerationStateSchema.optional(),
});

export const ReleaseStateSchema = z.object({
  version: z.literal(1),
  releases: z.array(ReleaseStateEntrySchema),
});

export type ReleaseState = z.infer<typeof ReleaseStateSchema>;
export type ReleaseStateEntry = z.infer<typeof ReleaseStateEntrySchema>;
export type GenerationState = z.infer<typeof GenerationStateSchema>;

export function releaseStateId(entry: Pick<ReleaseStateEntry, "environment" | "fromVersion" | "toVersion">): string {
  return JSON.stringify([normalizeEnvironment(entry.environment), entry.fromVersion, entry.toVersion]);
}

/** Incoming generation progress wins; the original deployment record is retained. */
export function mergeReleaseStates(base: ReleaseState, incoming: ReleaseState): ReleaseState {
  const entries = new Map(base.releases.map(entry => [releaseStateId(entry), entry]));
  for (const entry of incoming.releases) {
    const id = releaseStateId(entry), previous = entries.get(id);
    entries.set(id, previous ? {
      ...previous, ...entry,
      deployment: previous.deployment ?? entry.deployment,
      generation: entry.generation ?? previous.generation,
    } : entry);
  }
  return { version: 1, releases: [...entries.values()] };
}

export async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read the shared ledger, importing the former skipped-deployment ledger when present. */
export async function loadReleaseState(path: string, environment?: string): Promise<ReleaseState> {
  const text = await readOptional(path);
  let state: ReleaseState = text === undefined ? { version: 1, releases: [] } : ReleaseStateSchema.parse(JSON.parse(text));
  if (environment) {
    const legacy = await readOptional(join(dirname(path), ".pending-release-notes.json"));
    if (legacy !== undefined) {
      const records = z.array(z.object({ from: z.string(), to: z.string(), date: z.string() })).parse(JSON.parse(legacy));
      state = mergeReleaseStates(state, { version: 1, releases: records.map(record => ({
        environment: normalizeEnvironment(environment), fromVersion: record.from, toVersion: record.to,
        deployment: { date: record.date, notesSkipped: true },
      })) });
    }
  }
  return state;
}

/** Update one ledger without dropping other ranges; remove the old ledger only after a successful write. */
export async function saveReleaseState(path: string, state: ReleaseState, environment?: string): Promise<void> {
  const merged = mergeReleaseStates(await loadReleaseState(path, environment), ReleaseStateSchema.parse(state));
  await atomicWrite(path, JSON.stringify(merged, null, 2) + "\n");
  if (environment) await rm(join(dirname(path), ".pending-release-notes.json"), { force: true });
}

export async function recordSkippedRelease(options: {
  path: string; environment: string; fromVersion: string; toVersion: string; date: string; revision?: string;
}): Promise<void> {
  const { path, date, ...identity } = options;
  await saveReleaseState(path, { version: 1, releases: [{
    ...identity, environment: normalizeEnvironment(identity.environment), deployment: { date, notesSkipped: true },
  }] }, options.environment);
}

/** Default to one ledger in the common output directory; an explicit config path can override it. */
export function defaultReleaseStatePath(paths: string[], patterns: string[] = paths): string {
  const directories = patterns.map(pattern => {
    const parts = dirname(resolve(pattern)).split(sep);
    const variable = parts.findIndex(part => /\{(?:lang|from|to)\}/.test(part));
    return variable < 0 ? dirname(resolve(pattern)) : parts.slice(0, variable).join(sep) || sep;
  });
  let directory = directories[0];
  for (const target of directories.slice(1)) {
    while (target !== directory && !target.startsWith(directory.endsWith(sep) ? directory : directory + sep)) {
      directory = dirname(directory);
    }
  }
  return join(directory, ".release-notes-state.json");
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
