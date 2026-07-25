/**
 * Release note formatting
 */

import { AI_RELEASE_NOTES_VERSION } from "./version.js";
import { readFileSync } from "fs";
import { resolve } from "path";

export const RELEASES_MARKER = "<!-- ai-release-notes:releases -->";
export const RELEASES_END_MARKER = "<!-- ai-release-notes:/releases -->";

export interface OutputIndexLanguageLink {
  language: string;
  href: string;
  active: boolean;
}

/**
 * The shape of one index entry: markup with `{{slot}}` placeholders.
 *
 * Every word of an entry comes from a template, so no label is spelled out in
 * this codebase and a translated template carries its own translated labels.
 */
export type OutputIndexEntryTemplate = string;

/** Replace `{{slot}}` occurrences, leaving an unknown slot visible. */
export function fillTemplateSlots(template: string, values: Record<string, string>): string {
  return template.replace(
    /\{\{\s*(\w+)\s*\}\}/g,
    (match, key: string) => values[key] ?? match
  );
}

/**
 * What an index knows about one release.
 *
 * It is stored in the entry's own marker, so the whole list can be rendered
 * again from the current template: change the template or the language, and
 * every release is relabelled at the next run.
 */
export interface OutputIndexReleaseRecord {
  environment: string;
  fromVersion: string;
  toVersion: string;
  /** As supplied by git, unlocalized: the reader's language decides its form. */
  date: string;
  /** The release notes, relative to the index. */
  href: string;
}

/** What identifies a release inside an index, whatever its wording. */
export function outputIndexReleaseId(record: OutputIndexReleaseRecord): string {
  return [record.environment, record.fromVersion, record.toVersion]
    .map((value) => encodeURIComponent(value))
    .join("_");
}

/** Render one index entry, record marker included, by filling the template. */
export function renderOutputIndexReleaseEntry(params: {
  record: OutputIndexReleaseRecord;
  entryTemplate: OutputIndexEntryTemplate;
  format: "markdown" | "html";
  /** The date as the index shows it, already in the reader's language. */
  date: string;
}): string {
  const { record } = params;
  // An environment, a version, a date and a path reach an HTML index from
  // config, the command line and git, so every value the template receives is
  // escaped there.
  const value = (raw: string) => (params.format === "html" ? escapeHtml(raw) : raw);
  const entry = fillTemplateSlots(params.entryTemplate, {
    environment: value(record.environment),
    date: value(params.date),
    fromVersion: value(record.fromVersion),
    toVersion: value(record.toVersion),
    href: value(record.href),
  });
  return `<!-- ai-release-notes:release ${serializeReleaseRecord(record)} -->\n${entry}`;
}

/**
 * A record as it is written inside its comment marker.
 *
 * `--` ends an HTML comment, so a value carrying one would close the marker and
 * spill the rest into the page. Escaping it keeps the JSON valid and lossless:
 * the parser turns the escape back into a dash.
 */
function serializeReleaseRecord(record: OutputIndexReleaseRecord): string {
  return JSON.stringify(record).replaceAll("--", "\\u002d\\u002d");
}

const RELEASE_MARKER = /<!--\s*ai-release-notes:release\s+([^>]*?)\s*-->/g;
const RELEASE_RECORD_MARKER = /<!--\s*ai-release-notes:release\s+(\{[\s\S]*?\})\s*-->/g;

/** Read the release records an index carries, in the order it lists them. */
export function readOutputIndexReleaseRecords(content: string): OutputIndexReleaseRecord[] {
  return [...content.matchAll(RELEASE_RECORD_MARKER)].flatMap((match) => {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      return isOutputIndexReleaseRecord(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function isOutputIndexReleaseRecord(value: unknown): value is OutputIndexReleaseRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["environment", "fromVersion", "toVersion", "date", "href"]
    .every((key) => typeof candidate[key] === "string");
}

/**
 * Place a release among the ones an index already lists.
 *
 * A release it already knows keeps its position; a new one opens the list,
 * which is ordered newest first.
 */
export function upsertOutputIndexReleaseRecord(
  records: OutputIndexReleaseRecord[],
  record: OutputIndexReleaseRecord
): OutputIndexReleaseRecord[] {
  const id = outputIndexReleaseId(record);
  const index = records.findIndex((candidate) => outputIndexReleaseId(candidate) === id);
  if (index < 0) return [record, ...records];
  return records.map((candidate, position) => (position === index ? record : candidate));
}

/** Render every entry of an index, newest first. */
export function renderOutputIndexReleases(params: {
  records: OutputIndexReleaseRecord[];
  entryTemplate: OutputIndexEntryTemplate;
  format: "markdown" | "html";
  localizeDate: (date: string) => string;
}): string {
  return params.records
    .map((record) => renderOutputIndexReleaseEntry({
      record,
      entryTemplate: params.entryTemplate,
      format: params.format,
      date: params.localizeDate(record.date),
    }))
    .join("\n");
}

/**
 * Entries an index lists without a record, kept word for word.
 *
 * They come from a version that stored no release data, so there is nothing to
 * render them from. Rewriting them would mean inventing what they said.
 */
export function readLegacyOutputIndexEntries(
  content: string,
  renderedIds: string[]
): string[] {
  const markers = [...content.matchAll(RELEASE_MARKER)];
  return markers.flatMap((match, position) => {
    const payload = match[1];
    // An entry that carries a record is rendered from it, and one whose id is
    // now rendered from a record would otherwise be listed twice.
    if (payload.startsWith("{") || renderedIds.includes(payload)) return [];
    const end = markers[position + 1]?.index ?? content.length;
    return [content.slice(match.index, end).trimEnd()];
  });
}

/** The listed releases of an index, between its release markers. */
export function readOutputIndexReleasesRegion(content: string): string {
  const start = content.indexOf(RELEASES_MARKER);
  if (start < 0) return "";
  const from = start + RELEASES_MARKER.length;
  const end = content.indexOf(RELEASES_END_MARKER, from);
  return content.slice(from, end < 0 ? undefined : end);
}

/** Put a freshly rendered list of releases in place of the listed ones. */
export function replaceOutputIndexReleases(content: string, releases: string): string {
  const region = `${RELEASES_MARKER}\n${releases}\n${RELEASES_END_MARKER}`;
  const start = content.indexOf(RELEASES_MARKER);
  if (start < 0) return `${content.trimEnd()}\n\n${region}\n`;

  const end = content.indexOf(RELEASES_END_MARKER, start + RELEASES_MARKER.length);
  return end < 0
    ? content.slice(0, start) + region + content.slice(start + RELEASES_MARKER.length)
    : content.slice(0, start) + region + content.slice(end + RELEASES_END_MARKER.length);
}

/** Render links between the localized variants of an output index. */
export function renderOutputIndexLanguageSwitcher(
  format: "markdown" | "html",
  links: OutputIndexLanguageLink[]
): string {
  const uniqueLinks = links.filter((link, index) =>
    links.findIndex((candidate) => candidate.language === link.language) === index
  );
  // One language is no choice to offer, so the slot is emptied rather than
  // filled: an index that lists a single language shows no switcher at all.
  if (uniqueLinks.length < 2) return "";

  const options = uniqueLinks.map((link) => {
    const label = link.language.toUpperCase();
    const href = link.href.replaceAll("(", "%28").replaceAll(")", "%29");
    if (format === "html") {
      return link.active
        ? `  <span class="language-option is-active" aria-current="page">${escapeHtml(label)}</span>`
        : `  <a class="language-option" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    }
    return link.active
      ? `**${escapeMarkdownLabel(label)}**`
      : `[${escapeMarkdownLabel(label)}](${href})`;
  });

  return format === "html"
    ? `<nav class="language-switcher" aria-label="Languages">\n${options.join("\n")}\n</nav>`
    : options.join(" · ");
}

/**
 * Where a language switcher goes, and what it replaces once it is there.
 *
 * A template says where with `{{languages}}`, and that slot is spent the first
 * time an index is written. From then on the switcher is found by the markup it
 * was rendered as — a `nav` in HTML, a line of language links in Markdown — so
 * a page carries a switcher rather than a marker telling the tool where one is.
 */
const LANGUAGE_SWITCHER = new RegExp([
  String.raw`\{\{\s*(?:languages|langages)\s*\}\}`,
  String.raw`[ \t]*<nav class="language-switcher"[\s\S]*?<\/nav>`,
  // Two options at least: a lone link is a link, not a switcher.
  String.raw`^(?:\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))(?: · (?:\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)))+$`,
].join("|"), "m");

/** Put the switcher in the slot a template offers, or over the one on the page. */
export function applyOutputIndexLanguageSwitcher(
  content: string,
  switcher: string
): string {
  let rendered = false;
  return content.replace(new RegExp(LANGUAGE_SWITCHER.source, "gm"), () => {
    if (rendered) return "";
    rendered = true;
    return switcher;
  });
}

/** Whether an index offers a slot for a switcher, or already shows one. */
export function hasOutputIndexLanguageSwitcher(content: string): boolean {
  return LANGUAGE_SWITCHER.test(content);
}

/** Render a release note inside an HTML template. */
export function renderReleaseNoteHtml(
  template: string,
  content: string,
  params: {
    fromVersion: string;
    toVersion: string;
    environment: string;
    date: string;
    projectName?: string;
  }
): string {
  // One pass over the template, so a `{{slot}}` the model wrote into the note
  // is left where it stands instead of being filled in turn.
  return fillTemplateSlots(template, {
    projectName: escapeHtml(params.projectName || ""),
    fromVersion: escapeHtml(params.fromVersion),
    toVersion: escapeHtml(params.toVersion),
    environment: escapeHtml(params.environment),
    date: escapeHtml(params.date),
    version: AI_RELEASE_NOTES_VERSION,
    content: renderMarkdown(content),
  });
}

/** The bundled release-note template, the shell every generated page shares. */
export const DEFAULT_RELEASE_NOTE_TEMPLATE_PATH = resolve(
  __dirname,
  "../templates/default-release-note.html"
);

let bundledReleaseNoteTemplate: string | undefined;

/** Read the bundled template once: the same shell serves every page of a run. */
function loadBundledReleaseNoteTemplate(): string {
  bundledReleaseNoteTemplate ??= readFileSync(DEFAULT_RELEASE_NOTE_TEMPLATE_PATH, "utf-8");
  return bundledReleaseNoteTemplate;
}

/**
 * Convert Markdown to self-contained, browser-friendly HTML.
 *
 * The page is the bundled release-note template, so how a generated page looks
 * is edited in that file rather than spelled out here. Its title and its footer
 * are part of the template too: a template of your own carries its own wording.
 *
 * Raw HTML is escaped unless the caller vouches for the Markdown. Only content
 * this tool composed itself — an output index and its language switcher — is
 * ever trusted; model output and changelog text never are.
 */
export function markdownToHtml(
  markdown: string,
  options: { trustedHtml?: boolean } = {}
): string {
  return fillTemplateSlots(loadBundledReleaseNoteTemplate(), {
    content: renderMarkdown(markdown, options.trustedHtml === true),
    version: AI_RELEASE_NOTES_VERSION,
  });
}

function renderMarkdown(markdown: string, trustedHtml = false): string {
  const output: string[] = [];
  const paragraph: string[] = [];
  const codeLines: string[] = [];
  const listStack: Array<{ type: "ul" | "ol"; indent: number; itemOpen: boolean }> = [];
  let inCodeBlock = false;

  const closeList = () => {
    while (listStack.length > 0) {
      const list = listStack.pop()!;
      if (list.itemOpen) output.push("</li>");
      output.push(`</${list.type}>`);
    }
  };
  const closeParagraph = () => {
    if (paragraph.length > 0) output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph.length = 0;
  };
  const closeCodeBlock = () => {
    output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines.length = 0;
    inCodeBlock = false;
  };
  const openListItem = (type: "ul" | "ol", indent: number, content: string) => {
    let current = listStack.at(-1);

    while (current && indent < current.indent) {
      const list = listStack.pop()!;
      if (list.itemOpen) output.push("</li>");
      output.push(`</${list.type}>`);
      current = listStack.at(-1);
    }

    if (!current || indent > current.indent) {
      output.push(`<${type}>`);
      current = { type, indent, itemOpen: false };
      listStack.push(current);
    } else if (current.type !== type) {
      if (current.itemOpen) output.push("</li>");
      output.push(`</${current.type}>`);
      listStack.pop();
      output.push(`<${type}>`);
      current = { type, indent, itemOpen: false };
      listStack.push(current);
    } else if (current.itemOpen) {
      output.push("</li>");
    }

    output.push(`<li>${inlineMarkdown(content)}`);
    current.itemOpen = true;
  };

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (inCodeBlock) closeCodeBlock();
      else {
        closeParagraph();
        closeList();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    const listItem = /^(\s*)[-+*]\s+(.+)$/.exec(line);
    const numberedItem = /^(\s*)\d+[.)]\s+(.+)$/.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      const title = heading[2].replace(/\s+#+\s*$/, "");
      output.push(`<h${level}>${inlineMarkdown(title)}</h${level}>`);
    } else if (/^(?:[-*_]\s*){3,}$/.test(line.trim())) {
      closeParagraph();
      closeList();
      output.push("<hr>");
    } else if (listItem || numberedItem) {
      closeParagraph();
      const nextListType = numberedItem ? "ol" : "ul";
      const indentation = (listItem?.[1] || numberedItem?.[1] || "").replace(/\t/g, "  ").length;
      const content = listItem?.[2] || numberedItem?.[2] || "";
      openListItem(nextListType, indentation, content);
    } else if (/^\s{0,3}>\s?/.test(line)) {
      closeParagraph();
      closeList();
      output.push(`<blockquote>${inlineMarkdown(line.replace(/^\s{0,3}>\s?/, ""))}</blockquote>`);
    } else if (
      trustedHtml &&
      (/^<!--.*-->$/.test(line.trim()) || /^<\/?[a-z][\s\S]*>$/i.test(line.trim()))
    ) {
      closeParagraph();
      closeList();
      output.push(line);
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }

  if (inCodeBlock) closeCodeBlock();
  closeParagraph();
  closeList();
  return output.join("\n");
}

function inlineMarkdown(value: string): string {
  const codeTokens: string[] = [];
  const rendered = escapeHtml(value)
    .replace(/`([^`]+)`/g, (_match, code: string) => {
      const token = `\u0000CODE_${codeTokens.length}\u0000`;
      codeTokens.push(`<code>${code}</code>`);
      return token;
    })
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (match, label: string, url: string) =>
      isSafeUrl(url) ? `<a href="${url}">${label}</a>` : match
    )
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_([^\s](?:.*?[^\s])?)_(?!\w)/g, "$1<em>$2</em>");

  return codeTokens.reduce(
    (html, code, index) => html.replace(`\u0000CODE_${index}\u0000`, code),
    rendered
  );
}

/**
 * Whether a link target is safe to place in an href.
 *
 * A release note is written from changelog text nobody on the publishing side
 * reviewed, so a link may carry a scripting scheme. Browsers ignore control
 * characters and surrounding whitespace when they resolve a scheme, so those
 * are removed before the scheme is read.
 */
function isSafeUrl(url: string): boolean {
  const probe = url.replace(/[\u0000-\u0020\u007f-\u009f]/g, "").toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  // Relative paths and fragments carry no scheme and stay within the document.
  return !scheme || ["http", "https", "mailto"].includes(scheme[1]);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\[\]*_`]/g, "\\$&");
}

