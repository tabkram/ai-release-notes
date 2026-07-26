/**
 * Asking, in your own words, for a change to release notes already written.
 *
 * A generated note is rarely wrong so much as not yet right: it repeats a line,
 * it says more about the build than anyone wants to read, or it drifted from
 * the project's own writing rules. Regenerating it answers none of that — the
 * changelog has not changed, so the same note comes back, and every correction
 * already made to it is lost.
 *
 * A session reads the notes an environment holds, keeps them in hand, and
 * applies one request at a time to all of them. Nothing reaches the disk until
 * it is saved, so a request that reads badly is undone rather than repaired,
 * and a run of requests is reviewed once, together.
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { z } from "zod";
import { loadConfig, resolveProviderAlias } from "./config.js";
import { loadReleaseNoteTemplate, stripEnclosingCodeFence } from "./generator.js";
import { callLLM, type LLMCallResult } from "./llm.js";
import {
  discoverReleases,
  formatOutputPath,
  isReleaseSpecificPath,
  normalizeLanguage,
  type DiscoveredRelease,
} from "./output-path.js";
import {
  buildEditSystemPrompt,
  buildEditUserPrompt,
  buildSessionRouterSystemPrompt,
  buildSessionRouterUserPrompt,
  resolveInstructions,
} from "./prompts/builder.js";
import { compareVersions } from "./promote.js";
import {
  dedupeReleaseDocument,
  extractReleaseContent,
  replaceReleaseContent,
  type ReleaseFormat,
} from "./release-document.js";
import { sanitizeReleaseHtml } from "./release.js";
import type { GenerationUsage, ProviderName, ReleaseNotesConfig } from "./types.js";

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

/** Answers one revision request. Supplied to run a session on your own model. */
export type EditModelCall = (request: {
  system: string;
  user: string;
}) => Promise<LLMCallResult>;

export interface PromptSessionOptions {
  /** Whose release notes are opened: PROD, QUA, DEV... */
  environment: string;
  /** Narrow the session to the releases a range covers. */
  fromVersion?: string;
  toVersion?: string;
  /** Open one language only. */
  language?: string;
  /** LLM provider override. */
  provider?: string;
  configPath?: string;
  /** Answer requests with this instead of the configured provider. */
  callModel?: EditModelCall;
}

/** One release note a session has open. */
export interface PromptDocument {
  path: string;
  format: ReleaseFormat;
  language?: string;
  fromVersion?: string;
  toVersion?: string;
  /** The file as the last save left it. */
  saved: string;
  /** The file as it now reads, every applied request included. */
  content: string;
  /** The template its page was rendered with, for an HTML release note. */
  template?: string;
  /** Why this file cannot be revised, when it cannot. */
  unrevisable?: string;
}

/** What one request did to one file. */
export interface PromptEdit {
  path: string;
  before: string;
  after: string;
  changed: boolean;
  /** Why this file was left alone, when it was. */
  skipped?: string;
  /** The lines a de-duplication dropped, as they were written. */
  removed?: string[];
}

export interface PromptEditResult {
  edits: PromptEdit[];
  usage: GenerationUsage;
  /**
   * What did the work: a model, or this tool comparing the lines itself.
   *
   * Not the same question as whether any tokens were spent — a request whose
   * every model call failed spends none, and saying no model was called would
   * be reporting the opposite of what happened.
   */
  via: "model" | "comparison";
}

/** What someone at the desk can be asking for. */
export const SESSION_ACTIONS = [
  "revise",
  "dedupe",
  "undo",
  "reset",
  "save",
  "list",
  "done",
  "unclear",
] as const;

export type SessionActionName = (typeof SESSION_ACTIONS)[number];

/** What one message turned out to mean. */
export interface SessionAction {
  action: SessionActionName;
  /** For `revise`: the request, restated for the model that rewrites the note. */
  instruction: string;
  /** One sentence back to the person who asked. */
  reply: string;
}

const SessionActionSchema = z.object({
  action: z.enum(SESSION_ACTIONS),
  instruction: z.string().optional(),
  reply: z.string().optional(),
});

/** A file this session found, before it was read. */
interface FoundFile {
  path: string;
  language?: string;
  fromVersion?: string;
  toVersion?: string;
}

const UNREADABLE_PAGE =
  "its release note cannot be told apart from the page around it — revise the Markdown output instead";

/**
 * The release notes of one environment, open for revision.
 *
 * Open it with `PromptSession.open`, apply requests, then `save`. Nothing is
 * written before that, and `undo` steps back through the requests one by one.
 */
export class PromptSession {
  private readonly history: Array<Map<string, string>> = [];

  private constructor(
    readonly config: ReleaseNotesConfig,
    readonly environment: string,
    readonly provider: ProviderName,
    readonly documents: PromptDocument[],
    private readonly callModel: EditModelCall
  ) {}

  static async open(options: PromptSessionOptions): Promise<PromptSession> {
    const config = await loadConfig(options.configPath);
    const provider = (options.provider
      ? resolveProviderAlias(options.provider)
      : config.provider) as ProviderName;

    // A session on your own model needs no key and no provider entry; one that
    // will call a provider is told now rather than after the first request.
    const providerConfig = config.providers[provider];
    if (!options.callModel && !providerConfig) {
      throw new PromptError(
        `Provider "${provider}" not configured. ` +
        `Add it to your config file under providers.${provider}`
      );
    }

    const outputs = config.output
      ? (Array.isArray(config.output) ? config.output : [config.output])
      : [];
    if (outputs.length === 0) {
      throw new PromptError(
        "Revising reuses the files a generation wrote, so it needs to know where they are. " +
        "Add an output with a saveTo path to your config."
      );
    }

    const documents: PromptDocument[] = [];
    for (const output of outputs) {
      const patterns = output.saveTo
        ? (Array.isArray(output.saveTo) ? output.saveTo : [output.saveTo])
        : [];
      const template = output.format === "html"
        ? await loadReleaseNoteTemplate(output.template)
        : undefined;

      for (const pattern of patterns) {
        for (const found of await findFiles(pattern, options, config)) {
          // Two configured outputs can name one file; it is opened once.
          if (documents.some((document) => document.path === found.path)) continue;
          documents.push(await readDocument(found, output.format, template));
        }
      }
    }

    if (documents.length === 0) {
      throw new PromptError(
        `No release notes found for ${options.environment}` +
        rangeDescription(options.fromVersion, options.toVersion) + ". " +
        "Generate them first, or check the environment name against your output.saveTo paths."
      );
    }

    const callModel: EditModelCall = options.callModel
      ?? ((request) => callLLM(provider, providerConfig!, request.system, request.user));

    return new PromptSession(config, options.environment, provider, documents, callModel);
  }

  /** The files revised since the last save. */
  pending(): PromptDocument[] {
    return this.documents.filter((document) => document.content !== document.saved);
  }

  /** Whether anything at all can be revised. */
  get revisable(): PromptDocument[] {
    return this.documents.filter((document) => !document.unrevisable);
  }

  /**
   * Read what someone answered and say what they are asking for.
   *
   * Everything is said in words — "drop the docker part", "actually put that
   * back", "that's it, write them" — so a model reads the answer rather than a
   * list of commands the person would have to learn first. It is given the
   * message and the state of the session; the release notes themselves never
   * reach it.
   *
   * An answer it cannot place is taken as a request to revise, which is what
   * nearly every answer is: a session is never blocked by its own front desk.
   */
  async route(message: string): Promise<SessionAction> {
    const said = message.trim();
    if (!said) {
      return { action: "unclear", instruction: "", reply: "" };
    }

    try {
      const answer = await this.callModel({
        system: await buildSessionRouterSystemPrompt(),
        user: buildSessionRouterUserPrompt({
          message: said,
          environment: this.environment,
          openFiles: this.documents.length,
          unsavedFiles: this.pending().length,
          canUndo: this.history.length > 0,
        }),
      });
      return readSessionAction(answer.text, said);
    } catch {
      // The provider failing here would otherwise swallow the request. Revising
      // is what was almost certainly meant, and it reports its own failure.
      return { action: "revise", instruction: said, reply: "" };
    }
  }

  /**
   * Apply one request, in your own words, to every open release note.
   *
   * Each note is revised on its own, so a request about a section only reaches
   * the notes that have one. A note the model fails on is reported and left as
   * it was, and the rest of the run is abandoned rather than repeated against a
   * provider that has just refused.
   */
  async revise(instruction: string): Promise<PromptEditResult> {
    const request = instruction.trim();
    if (!request) throw new PromptError("A request needs some words to act on.");

    const startedAt = Date.now();
    const usage = emptyUsage();
    const system = await buildEditSystemPrompt(
      await resolveInstructions(this.config.prompt?.instructions)
    );

    const edits: PromptEdit[] = [];
    const revised = new Map<string, string>();
    let failed = false;

    for (const document of this.documents) {
      if (failed) {
        edits.push(unchanged(document, "not attempted: the request was abandoned"));
        continue;
      }

      const note = noteOf(document);
      if (note === undefined) {
        edits.push(unchanged(document, document.unrevisable ?? UNREADABLE_PAGE));
        continue;
      }

      let answer: LLMCallResult;
      try {
        answer = await this.callModel({
          system,
          user: buildEditUserPrompt({
            instruction: request,
            document: note,
            format: document.format,
            projectName: this.config.projectName,
            environment: this.environment,
            fromVersion: document.fromVersion,
            toVersion: document.toVersion,
            language: document.language,
          }),
        });
      } catch (error) {
        failed = true;
        edits.push(unchanged(document, error instanceof Error ? error.message : String(error)));
        continue;
      }

      addUsage(usage, answer.usage);
      const written = this.applyAnswer(document, answer.text);
      if (typeof written === "string") {
        revised.set(document.path, written);
        edits.push({
          path: document.path,
          before: document.content,
          after: written,
          changed: written !== document.content,
        });
        continue;
      }
      edits.push(unchanged(document, written.skipped));
    }

    this.commit(revised);
    usage.durationMs = Date.now() - startedAt;
    return { edits, usage, via: "model" };
  }

  /**
   * Drop every line an open release note lists more than once.
   *
   * Comparing lines is something this can do exactly, so it does it itself: no
   * request is built, no provider is called, and what comes back is the note
   * minus the lines it repeated, never a rewording of the ones it keeps.
   */
  dedupe(): PromptEditResult {
    const startedAt = Date.now();
    const usage = emptyUsage();
    const edits: PromptEdit[] = [];
    const revised = new Map<string, string>();

    for (const document of this.documents) {
      const note = noteOf(document);
      if (note === undefined) {
        edits.push(unchanged(document, document.unrevisable ?? UNREADABLE_PAGE));
        continue;
      }

      const { content, removed } = dedupeReleaseDocument(note, document.format);
      const written = withNote(document, content);
      if (written === undefined) {
        edits.push(unchanged(document, UNREADABLE_PAGE));
        continue;
      }

      if (written !== document.content) revised.set(document.path, written);
      edits.push({
        path: document.path,
        before: document.content,
        after: written,
        changed: written !== document.content,
        removed,
      });
    }

    this.commit(revised);
    usage.durationMs = Date.now() - startedAt;
    return { edits, usage, via: "comparison" };
  }

  /** Step back one request. Returns whether there was one to step back from. */
  undo(): boolean {
    const previous = this.history.pop();
    if (!previous) return false;

    for (const document of this.documents) {
      const content = previous.get(document.path);
      if (content !== undefined) document.content = content;
    }
    return true;
  }

  /** Drop every request applied since the last save. */
  reset(): void {
    for (const document of this.documents) {
      document.content = document.saved;
    }
    this.history.length = 0;
  }

  /**
   * Write the revised notes.
   *
   * A revision changes what a release note says, never which release it is, so
   * the release index still describes it correctly and is left alone.
   */
  async save(): Promise<string[]> {
    const written: string[] = [];
    for (const document of this.pending()) {
      await writeFile(document.path, document.content, "utf-8");
      document.saved = document.content;
      written.push(document.path);
    }
    return written;
  }

  /**
   * The model's answer, ready to be written back — or why it cannot be.
   *
   * The answer is a release note, so a fence the model wrapped it in is removed
   * as it is after a generation. An answer that is markup goes back onto a
   * published page, so it is reduced to the markup a release note is made of
   * first: the note the model was given was itself written from changelog text
   * nobody reviewed.
   */
  private applyAnswer(
    document: PromptDocument,
    answer: string
  ): string | { skipped: string } {
    const revised = document.format === "html"
      ? sanitizeReleaseHtml(stripEnclosingCodeFence(answer)).trim()
      : stripEnclosingCodeFence(answer).trim();

    if (!revised) {
      return { skipped: "the model answered with nothing, so the file was left as it was" };
    }

    const written = withNote(document, revised);
    return written === undefined ? { skipped: UNREADABLE_PAGE } : written;
  }

  /** Take the revised files into the session, one step back always available. */
  private commit(revised: Map<string, string>): void {
    const changed = this.documents.filter(
      (document) => revised.get(document.path) !== undefined
        && revised.get(document.path) !== document.content
    );
    if (changed.length === 0) return;

    this.history.push(new Map(this.documents.map((document) => [document.path, document.content])));
    for (const document of changed) {
      document.content = revised.get(document.path)!;
    }
  }
}

// ─────────────────────────────────────────
// Reading what was asked for
// ─────────────────────────────────────────

/**
 * Read the front desk's answer.
 *
 * An answer that is not the object asked for means the message was not placed,
 * and the message itself becomes the request: a session where a malformed
 * answer stopped the work would be worse than one that simply tries the
 * revision, which reports for itself whether it changed anything.
 */
export function readSessionAction(answer: string, message: string): SessionAction {
  const parsed = SessionActionSchema.safeParse(parseJsonObject(stripEnclosingCodeFence(answer)));
  if (!parsed.success) return { action: "revise", instruction: message, reply: "" };

  return {
    action: parsed.data.action,
    // A revision with nothing to do is the message as it was typed: the front
    // desk placed it, so its own words still say what to do.
    instruction: parsed.data.instruction?.trim() || message,
    reply: parsed.data.reply?.trim() || "",
  };
}

/** The JSON object an answer carries, wherever in the answer it sits. */
function parseJsonObject(answer: string): unknown {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;

  try {
    return JSON.parse(answer.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────
// Finding what to revise
// ─────────────────────────────────────────

/** The files one configured output holds for the environment being revised. */
async function findFiles(
  pattern: string,
  options: PromptSessionOptions,
  config: ReleaseNotesConfig
): Promise<FoundFile[]> {
  if (isReleaseSpecificPath(pattern)) {
    const releases = await discoverReleases(pattern, {
      environment: options.environment,
      language: options.language,
    });
    return releases.filter((release) => covers(release, options.fromVersion, options.toVersion));
  }

  // A path naming no version holds every release in one file, so it is not a
  // release and no range names it. Asked for a range, it is left out; asked for
  // an environment, it is one more file to revise.
  if (options.fromVersion || options.toVersion) return [];

  const languages = options.language
    ? [options.language]
    : (config.prompt?.languages ?? []);
  const paths = pattern.includes("{lang}")
    ? languages.map((language) => ({
        path: formatOutputPath(pattern, { environment: options.environment, language }),
        language: normalizeLanguage(language),
      }))
    : [{ path: formatOutputPath(pattern, { environment: options.environment }) }];

  return paths
    .filter((candidate) => !candidate.path.includes("{") && existsSync(resolve(candidate.path)))
    .map((candidate) => ({ ...candidate, path: resolve(candidate.path) }));
}

/**
 * Whether a release falls inside the range asked for.
 *
 * A file naming both ends of what it covers is placed by both; one naming only
 * where it arrived is placed by that, which is the most its own name says.
 */
function covers(
  release: DiscoveredRelease,
  fromVersion?: string,
  toVersion?: string
): boolean {
  if (fromVersion) {
    const startsInRange = release.fromVersion
      ? compareVersions(release.fromVersion, fromVersion) >= 0
      : compareVersions(release.toVersion, fromVersion) > 0;
    if (!startsInRange) return false;
  }

  return !toVersion || compareVersions(release.toVersion, toVersion) <= 0;
}

async function readDocument(
  found: FoundFile,
  format: ReleaseFormat,
  template?: string
): Promise<PromptDocument> {
  const content = await readFile(found.path, "utf-8");
  const document: PromptDocument = {
    path: found.path,
    format,
    language: found.language,
    fromVersion: found.fromVersion,
    toVersion: found.toVersion,
    saved: content,
    content,
    template,
  };

  if (noteOf(document) === undefined) document.unrevisable = UNREADABLE_PAGE;
  return document;
}

// ─────────────────────────────────────────
// A file, and the release note inside it
// ─────────────────────────────────────────

/**
 * The words a request acts on.
 *
 * A Markdown output is the release note; an HTML output is a whole page, and
 * only the note on it is ever sent or replaced, so the page keeps its head, its
 * styles, its footer and the values the template filled in when it was written.
 */
function noteOf(document: PromptDocument): string | undefined {
  if (document.format !== "html") return document.content;
  // Reading the note is not enough: it has to be possible to put one back.
  return replaceReleaseContent(document.content, "", document.template) === undefined
    ? undefined
    : extractReleaseContent(document.content, document.template);
}

/** The file as it reads once its release note is revised. */
function withNote(document: PromptDocument, note: string): string | undefined {
  return document.format === "html"
    ? replaceReleaseContent(document.content, note, document.template)
    : `${note.trim()}\n`;
}

function unchanged(document: PromptDocument, skipped: string): PromptEdit {
  return {
    path: document.path,
    before: document.content,
    after: document.content,
    changed: false,
    skipped,
  };
}

function rangeDescription(fromVersion?: string, toVersion?: string): string {
  if (fromVersion && toVersion) return ` between ${fromVersion} and ${toVersion}`;
  if (fromVersion) return ` from ${fromVersion} onwards`;
  if (toVersion) return ` up to ${toVersion}`;
  return "";
}

function emptyUsage(): GenerationUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0, durationMs: 0 };
}

function addUsage(
  total: GenerationUsage,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.totalTokens += usage.totalTokens;
  total.modelCalls += 1;
}
