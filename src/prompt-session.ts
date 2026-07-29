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
 * plans each request against the relevant subset. It can answer without
 * changing anything, revise existing contents, or stage a structural merge.
 * Nothing reaches disk until it is saved, so a request that reads badly is
 * undone rather than repaired, and a run of requests is reviewed together.
 */

import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { basename, dirname, relative, resolve, sep } from "path";
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
  buildIndexEditSystemPrompt,
  buildIndexEditUserPrompt,
  buildSessionAnswerSystemPrompt,
  buildSessionAnswerSynthesisUserPrompt,
  buildSessionAnswerUserPrompt,
  buildSessionMergeSystemPrompt,
  buildSessionMergeUserPrompt,
  buildSessionRouterSystemPrompt,
  buildSessionRouterUserPrompt,
  resolveInstructions,
} from "./prompts/builder.js";
import { ensureOutputIndexReleaseBoundary } from "./output-index.js";
import { compareVersions, planPromotion, PromotionError } from "./promote.js";
import {
  dedupeReleaseDocument,
  extractReleaseContent,
  isReleaseDocumentReadable,
  mergeReleaseDocuments,
  releaseContentRange,
  replaceReleaseContent,
  splitReleaseOpening,
  type ReleaseFormat,
} from "./release-document.js";
import {
  readOutputIndexReleaseRecords,
  readOutputIndexReleaseMarkers,
  readOutputIndexReleasesRegion,
  replaceOutputIndexReleases,
  sanitizeReleaseHtml,
  sanitizeReleaseIndexHtml,
  RELEASES_MARKER,
  type OutputIndexReleaseRecord,
} from "./release.js";
import type { GenerationUsage, OutputIndexConfig, ProviderName, ReleaseNotesConfig } from "./types.js";

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

type PromptSessionSelection = Pick<
  PromptSessionOptions,
  "fromVersion" | "toVersion" | "language"
>;

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
  /** The configured output pattern that named this release file. */
  outputPattern?: string;
  /** This file was staged by the session and does not exist on disk yet. */
  created?: boolean;
  /** This file will be removed the next time the session is saved. */
  removed?: boolean;
  /**
   * Whether a request revises one release's own note, or the index listing
   * every release of an environment. The two are asked for the same way, but
   * neither is read as if it were the other.
   */
  kind: "release" | "index";
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
  /** Whether this change updates, creates, or removes a file. */
  operation?: "update" | "create" | "delete";
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
  "answer",
  "merge",
  "dedupe",
  "undo",
  "reset",
  "save",
  "list",
  "done",
  "unclear",
] as const;

export type SessionActionName = (typeof SESSION_ACTIONS)[number];

/** The part of the open shelf one message refers to. */
export interface SessionScope {
  fromVersion?: string;
  toVersion?: string;
  languages?: string[];
  kinds?: Array<"release" | "index">;
}

/** What one message turned out to mean. */
export interface SessionAction {
  action: SessionActionName;
  /**
   * For `revise`: the request, restated for the model that rewrites the note.
   * For `answer`: the question, as it was asked.
   */
  instruction: string;
  /** One sentence back to the person who asked. */
  reply: string;
  /** Versions, languages, and document kinds the message names. */
  scope?: SessionScope;
  /** Which material can answer a read-only question. */
  answerFrom?: "catalog" | "notes" | "both";
}

/** What a question about the open release notes was answered with. */
export interface PromptAnswer {
  text: string;
  usage: GenerationUsage;
}

/** A contiguous set of releases to fold into one release note. */
export interface PromptMergeRequest extends SessionScope {
  instruction?: string;
}

const SessionActionSchema = z.object({
  action: z.enum(SESSION_ACTIONS),
  instruction: z.string().optional(),
  reply: z.string().optional(),
  scope: z.object({
    fromVersion: z.string().optional(),
    toVersion: z.string().optional(),
    languages: z.array(z.string()).optional(),
    kinds: z.array(z.enum(["release", "index"])).optional(),
  }).optional(),
  answerFrom: z.enum(["catalog", "notes", "both"]).optional(),
});

/** A file this session found, before it was read. */
interface FoundFile {
  path: string;
  language?: string;
  fromVersion?: string;
  toVersion?: string;
  outputPattern?: string;
}

interface MergeGroup {
  documents: PromptDocument[];
  outputPattern: string;
  format: ReleaseFormat;
  language?: string;
}

interface MergePlan extends MergeGroup {
  fromVersion: string;
  toVersion: string;
  sources: PromptDocument[];
  ranges: Array<{ fromVersion: string; toVersion: string }>;
}

interface MergeOutcome {
  plan: MergePlan;
  destination: PromptDocument;
  openingAttempted: boolean;
}

interface IndexChange {
  document: PromptDocument;
  content: string;
}

const UNREADABLE_PAGE =
  "its release note cannot be told apart from the page around it — revise the Markdown output instead";
const UNREADABLE_INDEX =
  "its list of releases cannot be found on the page — check that the outputIndex template still carries the releases marker";
const ALTERED_MARKERS =
  "the answer edited the markers that identify each listed release, so the file was left as it was";

/**
 * The release notes of one environment, open for revision.
 *
 * Open it with `PromptSession.open`, apply requests, then `save`. Nothing is
 * written before that, and `undo` steps back through the requests one by one.
 */
export class PromptSession {
  private readonly history: PromptDocument[][] = [];

  /** What was said last and what came of it, so "oui" has something to mean. */
  private lastExchange?: { message: string; action: SessionActionName; reply: string };

  private constructor(
    readonly config: ReleaseNotesConfig,
    readonly environment: string,
    readonly provider: ProviderName,
    readonly documents: PromptDocument[],
    private readonly callModel: EditModelCall,
    private readonly selection: PromptSessionSelection
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
    const outputIndexes: OutputIndexConfig[] = config.outputIndex
      ? (Array.isArray(config.outputIndex) ? config.outputIndex : [config.outputIndex])
      : [];
    if (outputs.length === 0 && outputIndexes.length === 0) {
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
          documents.push(await readDocument(
            { ...found, outputPattern: pattern },
            output.format,
            template,
            "release"
          ));
        }
      }
    }

    // An index names no version, so the same rule that applies to any other
    // versionless output applies to it: narrowing the session to a range
    // leaves it out, since a range asks for one release's own note.
    for (const outputIndex of outputIndexes) {
      for (const found of await findFiles(outputIndex.saveTo, options, config)) {
        if (documents.some((document) => document.path === found.path)) continue;
        documents.push(await readDocument(found, outputIndex.format, undefined, "index"));
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

    return new PromptSession(config, options.environment, provider, documents, callModel, {
      fromVersion: options.fromVersion,
      toVersion: options.toVersion,
      language: options.language,
    });
  }

  /** The files revised since the last save. */
  pending(): PromptDocument[] {
    return this.documents.filter(
      (document) => document.created || document.removed || document.content !== document.saved
    );
  }

  /** Whether anything at all can be revised. */
  get revisable(): PromptDocument[] {
    return this.documents.filter((document) => !document.removed && !document.unrevisable);
  }

  /**
   * Read what someone answered and say what they are asking for.
   *
   * Everything is said in words — "drop the docker part", "actually put that
   * back", "that's it, write them" — so a model reads the answer rather than a
   * list of commands the person would have to learn first. It is given the
   * message, the state of the session, and the exchange before it; the release
   * notes themselves never reach it.
   *
   * The exchange before it is what makes a conversation one. "Oui" answers the
   * question just asked and nothing else, so a desk that saw only the word
   * would have to ask what was meant — and asking again is the one reply that
   * gets nobody any further.
   *
   * An answer it cannot place stays unclear. The model chooses the action;
   * deterministic code later validates its scope before anything can change.
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
          openFiles: this.activeDocuments().length,
          unsavedFiles: this.pending().length,
          canUndo: this.history.length > 0,
          selection: this.selection,
          previous: this.lastExchange,
          catalog: this.activeDocuments().map((document) => ({
            kind: document.kind,
            language: document.language,
            fromVersion: document.fromVersion,
            toVersion: document.toVersion,
            dirty: document.created || document.content !== document.saved,
            readable: !document.unrevisable,
          })),
        }),
      });
      return this.remember(
        said,
        this.completeSelectedMergeScope(readSessionAction(answer.text, said))
      );
    } catch {
      // Planning failed, so no mutating action is guessed. A question must
      // never turn into a broadcast revision because a provider was unavailable.
      return this.remember(said, { action: "unclear", instruction: said, reply: "" });
    }
  }

  /**
   * Complete execution scope only after the model has chosen a structural
   * merge. The command-line selection is safe to reuse when it supplied both
   * boundaries and the request did not name a narrower range of its own.
   */
  private completeSelectedMergeScope(action: SessionAction): SessionAction {
    if (
      action.action !== "merge"
      || action.scope?.fromVersion
      || action.scope?.toVersion
      || !this.selection.fromVersion
      || !this.selection.toVersion
    ) {
      return action;
    }

    const releases = this.activeDocuments().filter(
      (document) => document.kind === "release" && document.outputPattern
    );
    const mentioned = resolveMentionedVersions(action.instruction, releases);
    if (mentioned.fromVersion || mentioned.toVersion) return action;

    return {
      ...action,
      scope: {
        ...action.scope,
        fromVersion: this.selection.fromVersion,
        toVersion: this.selection.toVersion,
        kinds: ["release"],
      },
    };
  }

  /**
   * Answer a question about the release notes this session has open.
   *
   * Someone with two dozen notes in front of them asks about them before
   * asking for a change to them — which versions are here, whether one is
   * missing between two others, what is still unsaved. None of that is a
   * revision, and a session that could only revise had to turn every question
   * into one, or ask what was meant until the question was given up on.
   *
   * Nothing here reaches a file: it reads what is open and says what it found.
   */
  async answer(
    question: string,
    scope?: SessionScope,
    answerFrom: SessionAction["answerFrom"] = "both"
  ): Promise<PromptAnswer> {
    const asked = question.trim();
    if (!asked) throw new PromptError("A question needs some words to answer.");

    const startedAt = Date.now();
    const usage = emptyUsage();
    const quoted = this.notesForQuestion(asked, scope);
    const chunks = answerFrom === "catalog"
      ? [[]]
      : chunkAnswerDocuments(quoted.included);
    const findings: Array<{ covers: string; text: string }> = [];
    const system = await buildSessionAnswerSystemPrompt();

    for (const included of chunks) {
      const batch: QuotedNotes = {
        included,
        omitted: quoted.included.filter((document) => !included.includes(document)),
        language: quoted.language,
      };
      const answered = await this.callModel({
        system,
        user: buildSessionAnswerUserPrompt({
          question: asked,
          summary: this.describeOpenFiles(batch),
          notes: included.map((document) => ({
            covers: coverage(document),
            language: document.language,
            text: readableNote(noteOf(document) ?? "", document.format),
          })),
          projectName: this.config.projectName,
        }),
      });
      addUsage(usage, answered.usage);
      findings.push({
        covers: included.map((document) => coverage(document)).join(", ") || "open-file catalog",
        text: stripEnclosingCodeFence(answered.text).trim(),
      });
    }

    let text = findings[0]?.text ?? "";
    if (findings.length > 1) {
      const synthesized = await this.callModel({
        system,
        user: buildSessionAnswerSynthesisUserPrompt({
          question: asked,
          findings,
          projectName: this.config.projectName,
        }),
      });
      addUsage(usage, synthesized.usage);
      text = stripEnclosingCodeFence(synthesized.text).trim();
    }

    usage.durationMs = Date.now() - startedAt;
    return { text, usage };
  }

  /**
   * The notes one question carries, and the ones it leaves behind.
   *
   * A question about what the releases brought is answered from the notes
   * themselves, so they travel with it — but a session holds every release of
   * an environment in every language it publishes, and a narrowly scoped
   * request should not pay to carry unrelated pages.
   *
   * So three things narrow it, in order. One language: the others are the same
   * releases translated, and an answer is written in the language it was asked
   * in whichever it read. The versions the question names, when it names any.
   * Then the newest of what is left, until the material is as much as one
   * question may carry — and whatever did not fit is named in the summary, so
   * an answer drawn from part of the shelf says so.
   */
  private notesForQuestion(question: string, scope?: SessionScope): QuotedNotes {
    const readable = this.activeDocuments().filter(
      (document) => document.kind === "release" && noteOf(document) !== undefined
    );
    const requestedLanguages = normalizedLanguages(scope?.languages);
    const language = requestedLanguages[0] ?? this.preferredLanguage(readable);
    const candidates = readable.filter(
      (document) => (document.language ?? "") === language
    );
    const versions = resolveMentionedVersions(question, candidates, scope);
    const included = selectReleaseDocuments(candidates, versions).sort(compareCoverage);

    return {
      included,
      omitted: candidates.filter((document) => !included.includes(document)),
      language,
    };
  }

  /** Which language's notes a question is answered from. */
  private preferredLanguage(documents: PromptDocument[]): string {
    const open = new Set(documents.map((document) => document.language ?? ""));
    if (open.size <= 1) return [...open][0] ?? "";

    const configured = (this.config.prompt?.languages ?? [])
      .map((language) => normalizeLanguage(language))
      .find((language) => open.has(language));
    return configured ?? [...open][0]!;
  }

  /**
   * What this session has open, as a question about it is answered from.
   *
   * Whether a release is missing between two others is a question about version
   * numbers, and ordering those is something this can do exactly — so it does
   * it here rather than leaving a model to work out whether `v1.8.2` comes
   * before or after `v1.12.0`. What the model receives is the chain already
   * ordered and every break in it already found; it reads that back in the
   * language the question was asked in, and works nothing out for itself.
   */
  describeOpenFiles(quoted?: QuotedNotes): string {
    const notes = this.activeDocuments().filter((document) => document.kind === "release");
    const indexes = this.activeDocuments().filter((document) => document.kind === "index");

    const lines = [
      `Environment: ${this.environment}`,
      `Release notes open: ${notes.length}`,
      `Release indexes open: ${indexes.length}`,
      `Holding changes that are not saved yet: ${this.pending().length}`,
    ];

    for (const [language, group] of byLanguage(notes)) {
      lines.push("", `Releases with a note${language ? ` [${language}]` : ""}, oldest first:`);
      lines.push(...describeReleaseChain(group));
    }

    for (const [language, group] of byLanguage(indexes)) {
      lines.push("", `Release index${language ? ` [${language}]` : ""}, listing every release of the environment:`);
      lines.push(...group.map((index) => `  ${basename(index.path)}`));
    }

    // Which notes are quoted is a fact about the answer, not about the shelf.
    // An answer read off part of it is worth having and worth saying so, and
    // the alternative — a model left to assume it holds everything listed —
    // is an answer about releases nobody showed it.
    if (quoted) {
      const language = quoted.language ? ` [${quoted.language}]` : "";
      lines.push("", `Quoted in full below${language}: ${
        quoted.included.map((document) => coverage(document)).join(", ") || "nothing"}`);
      if (quoted.omitted.length > 0) {
        lines.push(`Listed above but not quoted below, so nothing is known about what they say: ${
          quoted.omitted.map((document) => coverage(document)).join(", ")}`);
      }
      if (quoted.language) {
        lines.push("The other languages hold these same releases, written in their own words.");
      }
    }

    return lines.join("\n");
  }

  /**
   * Apply one request, in your own words, to its selected open documents.
   *
   * Each target is revised on its own. Named versions and planner scope keep
   * unrelated files out of the calls entirely. A target the model fails on is
   * reported and left as it was, and the rest of the run is abandoned rather
   * than repeated against a provider that has just refused.
   */
  async revise(instruction: string, scope?: SessionScope): Promise<PromptEditResult> {
    const request = instruction.trim();
    if (!request) throw new PromptError("A request needs some words to act on.");

    const startedAt = Date.now();
    const usage = emptyUsage();
    const releaseSystem = await buildEditSystemPrompt(
      await resolveInstructions(this.config.prompt?.instructions)
    );
    // Built only if an index is actually open: most sessions have none.
    let indexSystem: string | undefined;

    const edits: PromptEdit[] = [];
    const revised = new Map<string, string>();
    let failed = false;
    const targets = this.documentsForRevision(request, scope);
    if (targets.length === 0) {
      throw new PromptError("No open release note matches the requested versions, language, and file type.");
    }

    for (const document of targets) {
      if (failed) {
        edits.push(unchanged(document, "not attempted: the request was abandoned"));
        continue;
      }

      const note = noteOf(document);
      if (note === undefined) {
        edits.push(unchanged(document, document.unrevisable ?? (document.kind === "index" ? UNREADABLE_INDEX : UNREADABLE_PAGE)));
        continue;
      }

      let answer: LLMCallResult;
      try {
        answer = document.kind === "index"
          ? await this.callModel({
              system: indexSystem ??= await buildIndexEditSystemPrompt(),
              user: buildIndexEditUserPrompt({
                instruction: request,
                document: note,
                format: document.format,
                projectName: this.config.projectName,
                environment: this.environment,
                language: document.language,
              }),
            })
          : await this.callModel({
              system: releaseSystem,
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
          operation: "update",
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
   * Fold a contiguous run of release files into one staged release note.
   *
   * The planner supplies only the range. Chaining, document selection, output
   * paths, section merging, source removals, and index reconciliation are
   * deterministic so a model can never merge the wrong files.
   */
  async merge(request: PromptMergeRequest | string): Promise<PromptEditResult> {
    const input: PromptMergeRequest = typeof request === "string"
      ? { instruction: request }
      : request;
    const releases = this.activeDocuments().filter(
      (document) => document.kind === "release" && document.outputPattern
    );
    if (releases.length === 0) {
      throw new PromptError("No release-specific files are open to merge.");
    }

    const mentioned = resolveMentionedVersions(input.instruction ?? "", releases, input);
    if (!mentioned.fromVersion || !mentioned.toVersion) {
      throw new PromptError(
        "Merging needs both ends of the range, and each must be a version shown in the open release catalog."
      );
    }
    if (sameVersion(mentioned.fromVersion, mentioned.toVersion)) {
      throw new PromptError("A merged range must start and end at different versions.");
    }
    if (compareVersions(mentioned.fromVersion, mentioned.toVersion) > 0) {
      throw new PromptError(
        `The merged range ends at ${mentioned.toVersion}, which comes before ${mentioned.fromVersion}.`
      );
    }

    const startedAt = Date.now();
    const usage = emptyUsage();
    const languages = normalizedLanguages(input.languages);
    const availableLanguages = new Set(releases.map((document) => document.language ?? ""));
    const missingLanguages = languages.filter((language) => !availableLanguages.has(language));
    if (missingLanguages.length > 0) {
      throw new PromptError(
        `No open release notes match ${missingLanguages.join(", ")}.`
      );
    }
    const groups = groupMergeCandidates(releases.filter((document) =>
      languages.length === 0 || languages.includes(document.language ?? "")
    ));
    if (groups.length === 0) {
      throw new PromptError("No open release notes match the requested language.");
    }

    const plans: MergePlan[] = [];
    for (const group of groups) {
      const plan = planMergeGroup(group, mentioned.fromVersion, mentioned.toVersion);
      // An output/language that has neither boundary is not another requested
      // target. One carrying either boundary is, and must carry the whole chain.
      if (!plan) continue;
      if (plan.sources.length < 2) {
        throw new PromptError(
          `${displayRange(mentioned.fromVersion, mentioned.toVersion)} is already covered by one ` +
          `release note${group.language ? ` in ${group.language}` : ""}.`
        );
      }
      plans.push(plan);
    }
    if (plans.length === 0) {
      throw new PromptError(
        `No open release chain leads from ${mentioned.fromVersion} to ${mentioned.toVersion}.`
      );
    }

    // Build every result before changing session state. A missing language,
    // unreadable page, or colliding destination therefore leaves all groups
    // untouched rather than half-merging a multilingual release.
    const outcomes: MergeOutcome[] = [];
    for (const plan of plans) {
      outcomes.push(await this.buildMergedOutcome(plan, usage));
    }

    const sourcePaths = new Set(outcomes.flatMap((outcome) =>
      outcome.plan.sources.map((document) => document.path)
    ));
    const destinationPaths = new Set(outcomes.map((outcome) => outcome.destination.path));
    for (const destination of destinationPaths) {
      const collision = this.activeDocuments().find(
        (document) => document.path === destination && !sourcePaths.has(document.path)
      );
      if (collision) {
        throw new PromptError(`Cannot merge into ${destination}: that path already holds another open file.`);
      }
    }

    const indexChanges = this.buildMergedIndexChanges(outcomes);
    this.history.push(cloneDocuments(this.documents));

    const edits: PromptEdit[] = [];
    for (const outcome of outcomes) {
      const existingDestination = this.documents.find(
        (document) => document.path === outcome.destination.path
      );
      for (const source of outcome.plan.sources) {
        if (source.path === outcome.destination.path) continue;
        source.removed = true;
        edits.push({
          path: source.path,
          before: source.content,
          after: "",
          changed: true,
          operation: "delete",
        });
      }

      if (existingDestination) {
        const before = existingDestination.content;
        existingDestination.content = outcome.destination.content;
        existingDestination.fromVersion = outcome.destination.fromVersion;
        existingDestination.toVersion = outcome.destination.toVersion;
        existingDestination.removed = false;
        edits.push({
          path: existingDestination.path,
          before,
          after: existingDestination.content,
          changed: before !== existingDestination.content,
          operation: "update",
        });
      } else {
        this.documents.push(outcome.destination);
        edits.push({
          path: outcome.destination.path,
          before: "",
          after: outcome.destination.content,
          changed: true,
          operation: "create",
        });
      }
    }

    for (const change of indexChanges) {
      const before = change.document.content;
      change.document.content = change.content;
      edits.push({
        path: change.document.path,
        before,
        after: change.content,
        changed: before !== change.content,
        operation: "update",
      });
    }

    usage.durationMs = Date.now() - startedAt;
    return {
      edits,
      usage,
      via: outcomes.some((outcome) => outcome.openingAttempted) ? "model" : "comparison",
    };
  }

  /** Build one combined file without changing the session yet. */
  private async buildMergedOutcome(
    plan: MergePlan,
    usage: GenerationUsage
  ): Promise<MergeOutcome> {
    const notes = plan.sources.map((document) => noteOf(document));
    const unreadable = plan.sources.find((document, index) =>
      notes[index] === undefined ||
      !isReleaseDocumentReadable(notes[index] ?? "", document.format)
    );
    if (unreadable) {
      throw new PromptError(
        `Cannot merge ${relative(process.cwd(), unreadable.path)} without rewriting reviewed wording: ` +
        `${unreadable.unrevisable ?? "its release-note structure could not be read safely"}.`
      );
    }

    const sourceNotes = notes as string[];
    const latest = plan.sources.at(-1)!;
    const latestRange = plan.ranges.at(-1)!;
    let merged = mergeReleaseDocuments(sourceNotes, plan.format, { leadWith: "newest" });
    merged = retargetMergedOpening(
      merged,
      plan.format,
      latestRange.fromVersion,
      plan.fromVersion
    );

    const openings = sourceNotes.map((content, index) => ({
      ...plan.ranges[index]!,
      content: splitReleaseOpening(content, plan.format).opening,
    })).filter((opening) => opening.content.trim());

    const openingAttempted = openings.length > 1;
    if (openingAttempted) {
      try {
        const answer = await this.callModel({
          system: await buildSessionMergeSystemPrompt(
            await resolveInstructions(this.config.prompt?.instructions)
          ),
          user: buildSessionMergeUserPrompt({
            openings,
            format: plan.format,
            environment: this.environment,
            fromVersion: plan.fromVersion,
            toVersion: plan.toVersion,
            projectName: this.config.projectName,
            language: plan.language,
          }),
        });
        addUsage(usage, answer.usage);
        const fenceless = stripEnclosingCodeFence(answer.text).trim();
        const opening = plan.format === "html"
          ? sanitizeReleaseHtml(fenceless).trim()
          : fenceless;
        if (
          opening &&
          splitReleaseOpening(opening, plan.format).sections.trim() === "" &&
          looksLikeSameDocumentKind(
            splitReleaseOpening(merged, plan.format).opening,
            opening,
            plan.format,
            "release"
          )
        ) {
          const sections = splitReleaseOpening(merged, plan.format).sections;
          merged = sections ? `${opening}\n\n${sections}`.trim() : opening;
        }
      } catch {
        // Section merging is deterministic and complete. If the optional
        // opening writer is unavailable, the retargeted newest opening is a
        // safe, factual fallback for the combined range.
      }
    }

    const destinationPath = resolve(formatOutputPath(plan.outputPattern, {
      environment: this.environment,
      language: plan.language,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
    }));
    const existing = this.activeDocuments().find(
      (document) => document.path === destinationPath
    );
    if (!existing && existsSync(destinationPath)) {
      throw new PromptError(
        `Cannot merge into ${destinationPath}: a file exists there but is not part of this session.`
      );
    }

    const content = plan.format === "html"
      ? mergedHtmlPage(latest, merged, latestRange.fromVersion, plan.fromVersion)
      : `${merged.trim()}\n`;
    return {
      plan,
      openingAttempted,
      destination: {
        path: destinationPath,
        format: plan.format,
        language: plan.language,
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        saved: existing?.saved ?? "",
        content,
        template: latest.template,
        outputPattern: plan.outputPattern,
        created: !existing,
        kind: "release",
      },
    };
  }

  /**
   * Replace each index's constituent records with the combined release record.
   *
   * Index wording stays as written: the newest selected entry is retargeted,
   * while its machine-readable marker is rebuilt from values already present.
   */
  private buildMergedIndexChanges(outcomes: MergeOutcome[]): IndexChange[] {
    const changes: IndexChange[] = [];
    for (const document of this.activeDocuments().filter(
      (candidate) => candidate.kind === "index" && noteOf(candidate) !== undefined
    )) {
      const region = noteOf(document)!;
      const entries = splitIndexRecordEntries(region);
      if (entries.length === 0) continue;

      const outcome = chooseIndexMergeOutcome(document, entries, outcomes);
      if (!outcome) continue;
      const selected = entries.filter((entry): entry is RecordedIndexEntry => {
        const record = entry.record;
        return !!record && outcome.plan.ranges.some((range) =>
          sameVersion(record.fromVersion, range.fromVersion) &&
          sameVersion(record.toVersion, range.toVersion)
        );
      });
      if (selected.length === 0) continue;
      if (selected.length !== outcome.plan.ranges.length) {
        throw new PromptError(
          `Cannot update ${relative(process.cwd(), document.path)} safely: its release list carries only ` +
          `${selected.length} of the ${outcome.plan.ranges.length} notes being merged.`
        );
      }

      const newest = selected.find((entry) =>
        sameVersion(entry.record.toVersion, outcome.plan.toVersion)
      );
      if (!newest) {
        throw new PromptError(
          `Cannot update ${relative(process.cwd(), document.path)} safely: its newest merged release is missing.`
        );
      }

      const href = toPortablePath(relative(dirname(document.path), outcome.destination.path));
      const record = {
        ...newest.record,
        fromVersion: outcome.plan.fromVersion,
        toVersion: outcome.plan.toVersion,
        href,
      };
      const marker = serializeIndexRecord(record);
      const visible = newest.content
        .replace(newest.marker, marker);
      const retargeted = replaceWholeValue(
        replaceWholeValue(visible, newest.record.fromVersion, record.fromVersion),
        newest.record.href,
        record.href
      );
      const selectedIndexes = new Set(selected.map((entry) => entry.index));
      const insertion = Math.min(...selectedIndexes);
      const rebuilt = entries.flatMap((entry) => {
        if (entry.index === insertion) return [retargeted.trimEnd()];
        if (selectedIndexes.has(entry.index)) return [];
        return [entry.content.trimEnd()];
      }).join("\n");
      const prefix = region.slice(0, entries[0]!.start);
      const content = replaceOutputIndexReleases(
        document.content,
        `${prefix}${rebuilt}`.trim()
      );
      changes.push({ document, content });
    }
    return changes;
  }

  /**
   * Drop every line an open release note lists more than once.
   *
   * Comparing lines is something this can do exactly, so it does it itself: no
   * request is built, no provider is called, and what comes back is the note
   * minus the lines it repeated, never a rewording of the ones it keeps.
   *
   * An index is not one note repeating itself: it is many, each listed once
   * already, so it has nothing here to drop and is left out of this pass.
   */
  dedupe(): PromptEditResult {
    const startedAt = Date.now();
    const usage = emptyUsage();
    const edits: PromptEdit[] = [];
    const revised = new Map<string, string>();

    for (const document of this.activeDocuments()) {
      if (document.kind === "index") {
        edits.push(unchanged(document, "deduplication applies to release notes, not to the release index"));
        continue;
      }

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
        operation: "update",
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

    this.documents.splice(0, this.documents.length, ...cloneDocuments(previous));
    return true;
  }

  /** Drop every request applied since the last save. */
  reset(): void {
    const existing = this.documents.filter((document) => !document.created);
    for (const document of existing) {
      document.content = document.saved;
      document.removed = false;
    }
    this.documents.splice(0, this.documents.length, ...existing);
    this.history.length = 0;
  }

  /** Write staged updates and creations, then remove replaced source files. */
  async save(): Promise<string[]> {
    const written: string[] = [];
    const pending = this.pending();

    // A combined destination is made durable before any source is removed. If
    // writing fails, the originals are therefore still present.
    const writes = pending
      .filter((candidate) => !candidate.removed)
      .sort((left, right) =>
        Number(right.created && right.kind === "release") -
        Number(left.created && left.kind === "release")
      );
    for (const document of writes) {
      await mkdir(dirname(document.path), { recursive: true });
      await writeFile(document.path, document.content, "utf-8");
      document.saved = document.content;
      document.created = false;
      written.push(document.path);
    }

    for (const document of pending.filter((candidate) => candidate.removed)) {
      await rm(document.path, { force: true });
      written.push(document.path);
    }

    this.documents.splice(
      0,
      this.documents.length,
      ...this.documents.filter((document) => !document.removed)
    );
    // Once file topology reached disk, an in-memory undo could no longer make
    // the removed files real again. A later edit starts a fresh history.
    this.history.length = 0;
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
   *
   * An index's list is held to one thing more. Its entries carry the markers a
   * later run recognizes each release by, so an answer may drop a marker along
   * with the release it opens, and may never write, repeat or edit one — an
   * index that gained a marker nobody generated would list a release that was
   * never released.
   */
  private applyAnswer(
    document: PromptDocument,
    answer: string
  ): string | { skipped: string } {
    const fenceless = stripEnclosingCodeFence(answer);
    const revised = document.format !== "html"
      ? fenceless.trim()
      : document.kind === "index"
        ? sanitizeReleaseIndexHtml(fenceless).trim()
        : sanitizeReleaseHtml(fenceless).trim();

    if (!revised) {
      return { skipped: "the model answered with nothing, so the file was left as it was" };
    }
    if (document.kind === "index" && !keepsItsMarkers(noteOf(document) ?? "", revised)) {
      return { skipped: ALTERED_MARKERS };
    }
    if (!looksLikeSameDocumentKind(noteOf(document) ?? "", revised, document.format, document.kind)) {
      return {
        skipped: "the model returned commentary instead of a release document, so the file was left as it was",
      };
    }

    const written = withNote(document, revised);
    return written === undefined ? { skipped: UNREADABLE_PAGE } : written;
  }

  /** Keep what was just said, so the next message has it to lean on. */
  private remember(message: string, action: SessionAction): SessionAction {
    this.lastExchange = { message, action: action.action, reply: action.reply };
    return action;
  }

  /** Take the revised files into the session, one step back always available. */
  private commit(revised: Map<string, string>): void {
    const changed = this.documents.filter(
      (document) => revised.get(document.path) !== undefined
        && revised.get(document.path) !== document.content
    );
    if (changed.length === 0) return;

    this.history.push(cloneDocuments(this.documents));
    for (const document of changed) {
      document.content = revised.get(document.path)!;
    }
  }

  /** Files that have not been staged for removal. */
  private activeDocuments(): PromptDocument[] {
    return this.documents.filter((document) => !document.removed);
  }

  /** The open documents a regular in-place revision should reach. */
  private documentsForRevision(instruction: string, scope?: SessionScope): PromptDocument[] {
    let candidates = this.activeDocuments();
    const languages = normalizedLanguages(scope?.languages);
    if (languages.length > 0) {
      candidates = candidates.filter((document) =>
        !document.language || languages.includes(document.language)
      );
    }
    if (scope?.kinds?.length) {
      candidates = candidates.filter((document) => scope.kinds!.includes(document.kind));
    }

    const releases = candidates.filter((document) => document.kind === "release");
    const versions = resolveMentionedVersions(instruction, releases, scope);
    if (!versions.fromVersion && !versions.toVersion) return candidates;
    return selectReleaseDocuments(releases, versions);
  }
}

// ─────────────────────────────────────────
// What a question is answered from
// ─────────────────────────────────────────

/**
 * How much release-note text one question may carry.
 *
 * Two dozen notes is a normal shelf and every provider has a ceiling, so there
 * is a point past which a question either fails or costs more than the answer
 * is worth. What does not fit is named rather than quietly dropped.
 */
const ANSWER_MATERIAL_LIMIT = 60_000;

/** The notes one question carries, and the ones it leaves behind. */
interface QuotedNotes {
  included: PromptDocument[];
  omitted: PromptDocument[];
  /** The language they were read from, when the session holds more than one. */
  language: string;
}

/** The range a note covers, as an answer would name it. */
function coverage(document: PromptDocument): string {
  return [document.fromVersion, document.toVersion].filter(Boolean).join(" → ")
    || basename(document.path);
}

/** Release order, oldest first, for two notes of one language. */
function compareCoverage(left: PromptDocument, right: PromptDocument): number {
  return compareVersions(left.toVersion ?? "", right.toVersion ?? "");
}

interface ResolvedVersionRange {
  fromVersion?: string;
  toVersion?: string;
}

/**
 * Resolve version words against the catalog rather than trusting their shape.
 *
 * A missing conventional `v` prefix is accepted only when it points to exactly
 * one known boundary. Everything returned uses the spelling found in the open
 * files, so paths are never built from a model-normalized version.
 */
function resolveMentionedVersions(
  message: string,
  documents: PromptDocument[],
  scope?: Pick<SessionScope, "fromVersion" | "toVersion">
): ResolvedVersionRange {
  const known = knownVersions(documents);
  const resolveExplicit = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const resolved = resolveKnownVersion(value, known);
    if (!resolved) {
      throw new PromptError(`Version "${value}" is not a boundary in the open release catalog.`);
    }
    return resolved;
  };

  const explicitFrom = resolveExplicit(scope?.fromVersion);
  const explicitTo = resolveExplicit(scope?.toVersion);
  if (scope?.fromVersion || scope?.toVersion) {
    return { fromVersion: explicitFrom, toVersion: explicitTo };
  }

  const mentioned: string[] = [];
  for (const token of message.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? []) {
    const resolved = resolveKnownVersion(token, known);
    if (resolved && !mentioned.some((version) => sameVersion(version, resolved))) {
      mentioned.push(resolved);
    }
  }
  if (mentioned.length === 1) return { toVersion: mentioned[0] };
  if (mentioned.length > 1) {
    return {
      fromVersion: mentioned[0],
      toVersion: mentioned[mentioned.length - 1],
    };
  }
  return {};
}

/** Select one release, a whole bounded range, or everything when unbounded. */
function selectReleaseDocuments(
  documents: PromptDocument[],
  range: ResolvedVersionRange
): PromptDocument[] {
  if (range.fromVersion && range.toVersion) {
    if (compareVersions(range.fromVersion, range.toVersion) >= 0) {
      throw new PromptError(
        `The requested range runs from ${range.fromVersion} to ${range.toVersion}; ` +
        "its end must come after its start."
      );
    }
    return documents.filter((document) =>
      !!document.fromVersion &&
      !!document.toVersion &&
      compareVersions(document.fromVersion, range.fromVersion!) >= 0 &&
      compareVersions(document.toVersion, range.toVersion!) <= 0
    );
  }
  if (range.toVersion) {
    return documents.filter((document) =>
      !!document.toVersion && sameVersion(document.toVersion, range.toVersion!)
    );
  }
  if (range.fromVersion) {
    return documents.filter((document) =>
      !!document.fromVersion && sameVersion(document.fromVersion, range.fromVersion!)
    );
  }
  return [...documents];
}

function knownVersions(documents: PromptDocument[]): Map<string, string[]> {
  const known = new Map<string, string[]>();
  for (const version of documents.flatMap((document) =>
    [document.fromVersion, document.toVersion].filter((value): value is string => !!value)
  )) {
    const canonical = canonicalVersion(version);
    const spellings = known.get(canonical) ?? [];
    if (!spellings.some((candidate) => candidate.toLowerCase() === version.toLowerCase())) {
      spellings.push(version);
    }
    known.set(canonical, spellings);
  }
  return known;
}

function resolveKnownVersion(
  value: string,
  known: Map<string, string[]>
): string | undefined {
  const exact = [...known.values()].flat().find(
    (candidate) => candidate.toLowerCase() === value.toLowerCase()
  );
  if (exact) return exact;
  const candidates = known.get(canonicalVersion(value)) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function canonicalVersion(version: string): string {
  return version.trim().toLowerCase().replace(/^v(?=\d)/, "");
}

function sameVersion(left: string, right: string): boolean {
  return canonicalVersion(left) === canonicalVersion(right);
}

function normalizedLanguages(languages?: string[]): string[] {
  return [...new Set((languages ?? []).map(normalizeLanguage))];
}

/** Pack every selected note into bounded model calls without omitting any. */
function chunkAnswerDocuments(documents: PromptDocument[]): PromptDocument[][] {
  if (documents.length === 0) return [[]];
  const chunks: PromptDocument[][] = [];
  let current: PromptDocument[] = [];
  let size = 0;
  for (const document of documents) {
    const documentSize = (noteOf(document) ?? "").length;
    if (current.length > 0 && size + documentSize > ANSWER_MATERIAL_LIMIT) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(document);
    size += documentSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** The open notes of one language, in the order they were released. */
function byLanguage(documents: PromptDocument[]): Map<string, PromptDocument[]> {
  const groups = new Map<string, PromptDocument[]>();
  for (const document of documents) {
    const language = document.language ?? "";
    groups.set(language, [...(groups.get(language) ?? []), document]);
  }
  return groups;
}

/**
 * The releases of one language, oldest first, every break in the chain named.
 *
 * This is the whole of what a question like "is a version missing between two
 * of these" is answered from, and it is worked out here rather than asked of a
 * model: `v1.8.2` before `v1.12.0` is a comparison a model gets wrong often
 * enough to matter, and a release reported missing that is not, or held to be
 * present when nothing covers it, is worse than no answer.
 */
function describeReleaseChain(documents: PromptDocument[]): string[] {
  const ordered = [...documents]
    .filter((document) => document.toVersion)
    .sort(compareCoverage);
  const versionless = documents.filter((document) => !document.toVersion);

  const lines: string[] = [];
  let previous: PromptDocument | undefined;
  let breaks = 0;

  for (const document of ordered) {
    if (previous?.toVersion && document.fromVersion && previous.toVersion !== document.fromVersion) {
      breaks += 1;
      lines.push(compareVersions(document.fromVersion, previous.toVersion) > 0
        ? `  ⚠ nothing covers ${previous.toVersion} → ${document.fromVersion}: no note picks up where the one above left off`
        : `  ⚠ ${coverage(document)} covers ground the note above already covered`);
    }
    previous = document;
    lines.push(`  ${coverage(document)}${document.unrevisable ? "  (open, but its note cannot be read)" : ""}`);
  }

  for (const document of versionless) {
    lines.push(`  ${basename(document.path)}  (its name carries no version)`);
  }

  if (ordered.length > 1) {
    lines.push(breaks === 0
      ? `  No break in the chain: every note starts where the one above it ended, ${
          coverage(ordered[0]!)} through ${ordered[ordered.length - 1]!.toVersion}.`
      : `  ${breaks} break${breaks === 1 ? "" : "s"} in the chain, marked ⚠ above. Every other note starts where the one above it ended.`);
  }

  return lines;
}

/**
 * A release note as words, with the markup that carried them taken off.
 *
 * A question is asked about what a release brought, never about the tags it is
 * written in, and a page of markup spends the material a question may carry on
 * text nobody is asking about.
 */
function readableNote(note: string, format: ReleaseFormat): string {
  if (format !== "html") return note.trim();

  return note
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/div|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─────────────────────────────────────────
// Merging a range in place
// ─────────────────────────────────────────

function groupMergeCandidates(documents: PromptDocument[]): MergeGroup[] {
  const groups = new Map<string, MergeGroup>();
  for (const document of documents) {
    if (!document.outputPattern) continue;
    const key = [
      document.outputPattern,
      document.format,
      document.language ?? "",
    ].join("\u0000");
    const group = groups.get(key) ?? {
      documents: [],
      outputPattern: document.outputPattern,
      format: document.format,
      language: document.language,
    };
    group.documents.push(document);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Resolve one output/language through the same shortest contiguous-chain
 * planner used by promotion.
 */
function planMergeGroup(
  group: MergeGroup,
  requestedFrom: string,
  requestedTo: string
): MergePlan | undefined {
  const known = knownVersions(group.documents);
  const fromVersion = resolveKnownVersion(requestedFrom, known);
  const toVersion = resolveKnownVersion(requestedTo, known);
  if (!fromVersion && !toVersion) return undefined;
  if (!fromVersion || !toVersion) {
    throw new PromptError(
      `The ${group.language ? `${group.language} ` : ""}${group.format} output does not cover both ` +
      `${requestedFrom} and ${requestedTo}.`
    );
  }

  try {
    const planned = planPromotion({
      available: group.documents.map((document, index) => ({
        path: document.path,
        environment: undefined,
        language: document.language,
        fromVersion: document.fromVersion,
        toVersion: document.toVersion!,
        modifiedAt: index,
      })),
      fromVersion,
      toVersion,
    });
    const sources = planned.segments.map((segment) => {
      const source = group.documents.find(
        (document) => segment.releases.some((release) => release.path === document.path)
      );
      if (!source) {
        throw new PromptError(`The planned release ${segment.fromVersion} → ${segment.toVersion} is not open.`);
      }
      return source;
    });
    return {
      ...group,
      fromVersion: planned.fromVersion,
      toVersion: planned.toVersion,
      sources,
      ranges: planned.segments.map((segment) => ({
        fromVersion: segment.fromVersion,
        toVersion: segment.toVersion,
      })),
    };
  } catch (error) {
    if (error instanceof PromptError) throw error;
    if (error instanceof PromotionError) {
      throw new PromptError(
        `Cannot merge the ${group.language ? `${group.language} ` : ""}${group.format} notes: ` +
        error.message
      );
    }
    throw error;
  }
}

/** Keep the newest opening but point its comparison at the combined range. */
function retargetMergedOpening(
  merged: string,
  format: ReleaseFormat,
  previousVersion: string,
  fromVersion: string
): string {
  const { opening, sections } = splitReleaseOpening(merged, format);
  const retargeted = replaceWholeValue(opening, previousVersion, fromVersion);
  return sections ? `${retargeted.trimEnd()}\n\n${sections}` : retargeted;
}

/** Put a combined note into the newest HTML shell and retarget shell metadata. */
function mergedHtmlPage(
  latest: PromptDocument,
  merged: string,
  previousVersion: string,
  fromVersion: string
): string {
  const range = releaseContentRange(latest.content, latest.template);
  if (!range) throw new PromptError(`${latest.path} has no safely replaceable release-note region.`);
  const before = replaceWholeValue(
    latest.content.slice(0, range.start),
    previousVersion,
    fromVersion
  );
  const after = replaceWholeValue(
    latest.content.slice(range.end),
    previousVersion,
    fromVersion
  );
  return `${before}\n${merged.trim()}\n${after}`;
}

interface IndexRecordEntry {
  index: number;
  start: number;
  marker: string;
  content: string;
  record?: OutputIndexReleaseRecord;
}

type RecordedIndexEntry = IndexRecordEntry & { record: OutputIndexReleaseRecord };

const INDEX_ENTRY_MARKER =
  /<!--\s*ai-release-notes:release\s+([^>]*?)\s*-->/g;

/** Read every index entry, preserving legacy entries without JSON records. */
function splitIndexRecordEntries(region: string): IndexRecordEntry[] {
  const matches = [...region.matchAll(INDEX_ENTRY_MARKER)];
  return matches.map((match, index) => {
    const marker = match[0];
    const record = readOutputIndexReleaseRecords(marker)[0];
    const start = match.index;
    const end = matches[index + 1]?.index ?? region.length;
    return {
      index,
      start,
      marker,
      content: region.slice(start, end),
      record,
    };
  });
}

/** Match a localized index to the release output whose links it carries. */
function chooseIndexMergeOutcome(
  index: PromptDocument,
  entries: IndexRecordEntry[],
  outcomes: MergeOutcome[]
): MergeOutcome | undefined {
  if (index.language) {
    const localized = outcomes.filter(
      (outcome) => (outcome.plan.language ?? "") === index.language
    );
    if (localized.length === 1) return localized[0];
  }

  const linked = outcomes.filter((outcome) => {
    const sources = new Set(outcome.plan.sources.map((document) => resolve(document.path)));
    return entries.some((entry) =>
      !!entry.record && sources.has(resolve(dirname(index.path), entry.record.href))
    );
  });
  if (linked.length === 1) return linked[0];
  return outcomes.length === 1 ? outcomes[0] : undefined;
}

function serializeIndexRecord(record: OutputIndexReleaseRecord): string {
  const serialized = JSON.stringify(record).replaceAll("--", "\\u002d\\u002d");
  return `<!-- ai-release-notes:release ${serialized} -->`;
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

/** Replace one standalone catalog value without touching longer values. */
function replaceWholeValue(text: string, from: string, to: string): string {
  if (!from || from === to) return text;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}.-])${escapeRegExp(from)}(?![\\p{L}\\p{N}.-])`,
    "giu"
  );
  return text.replace(pattern, to);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function displayRange(fromVersion: string, toVersion: string): string {
  return `${fromVersion} → ${toVersion}`;
}

/** A history snapshot owns its objects; later mutations cannot reach it. */
function cloneDocuments(documents: PromptDocument[]): PromptDocument[] {
  return documents.map((document) => ({ ...document }));
}

/**
 * Reject prose wrapped around a document. This is a structural check, not a
 * phrase list: a note that arrived as markup or a heading must return as one.
 */
function looksLikeSameDocumentKind(
  original: string,
  revised: string,
  format: ReleaseFormat,
  kind: PromptDocument["kind"]
): boolean {
  if (kind === "index") return true;
  if (format === "html") {
    return /^\s*</.test(revised) && /<h[1-6]\b/i.test(revised);
  }
  return !/^\s{0,3}#{1,6}\s/.test(original) || /^\s{0,3}#{1,6}\s/.test(revised);
}

// ─────────────────────────────────────────
// Reading what was asked for
// ─────────────────────────────────────────

/**
 * Read the front desk's answer.
 *
 * An answer that is not the object asked for means the message was not placed.
 * It is left unclear rather than guessed as a mutation: provider trouble must
 * never turn a read-only question into a revision of every open file.
 */
export function readSessionAction(answer: string, message: string): SessionAction {
  const parsed = SessionActionSchema.safeParse(parseJsonObject(stripEnclosingCodeFence(answer)));
  if (!parsed.success) return { action: "unclear", instruction: message, reply: "" };

  return {
    action: parsed.data.action,
    // A revision with nothing to do is the message as it was typed: the front
    // desk placed it, so its own words still say what to do.
    instruction: parsed.data.instruction?.trim() || message,
    reply: parsed.data.reply?.trim() || "",
    ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
    ...(parsed.data.answerFrom ? { answerFrom: parsed.data.answerFrom } : {}),
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
  template: string | undefined,
  kind: "release" | "index"
): Promise<PromptDocument> {
  const file = await readFile(found.path, "utf-8");
  // An index whose list was never closed runs to the end of the page, footer
  // and all. Closing it is how a run reads the list back, so a revision reads
  // it the same way — and the boundary reaches the file only if something else
  // about the list changes too.
  const content = kind === "index" ? ensureOutputIndexReleaseBoundary(file, format) : file;
  const document: PromptDocument = {
    path: found.path,
    format,
    language: found.language,
    fromVersion: found.fromVersion,
    toVersion: found.toVersion,
    outputPattern: found.outputPattern,
    saved: content,
    content,
    template,
    kind,
  };

  if (noteOf(document) === undefined) {
    document.unrevisable = kind === "index" ? UNREADABLE_INDEX : UNREADABLE_PAGE;
  }
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
 *
 * An index is never only its list either: only the region its release markers
 * bound is sent, whatever format the page around it is written in.
 */
function noteOf(document: PromptDocument): string | undefined {
  if (document.kind === "index") {
    return document.content.includes(RELEASES_MARKER)
      ? readOutputIndexReleasesRegion(document.content).trim()
      : undefined;
  }
  if (document.format !== "html") return document.content;
  // Reading the note is not enough: it has to be possible to put one back.
  return replaceReleaseContent(document.content, "", document.template) === undefined
    ? undefined
    : extractReleaseContent(document.content, document.template);
}

/** The file as it reads once its release note, or its list of releases, is revised. */
function withNote(document: PromptDocument, note: string): string | undefined {
  if (document.kind === "index") return replaceOutputIndexReleases(document.content, note.trim());
  return document.format === "html"
    ? replaceReleaseContent(document.content, note, document.template)
    : `${note.trim()}\n`;
}

/**
 * Whether a revised list still stands for the releases it was given.
 *
 * Dropping a release drops its marker, which is a revision anyone may ask for.
 * Everything else is a marker the list did not have: one written from nothing,
 * one repeated so a later run lists its release twice, or one whose values were
 * edited so it no longer names the release its entry describes.
 */
function keepsItsMarkers(before: string, after: string): boolean {
  const original = readOutputIndexReleaseMarkers(before);
  const revised = readOutputIndexReleaseMarkers(after);
  return new Set(revised).size === revised.length
    && revised.every((marker) => original.includes(marker));
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
