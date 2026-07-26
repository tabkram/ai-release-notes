/**
 * A generated release note, read back.
 *
 * Promoting a release from one environment to the next reuses the words that
 * were already written and reviewed, so nothing here rewrites a release note:
 * it is taken apart into the sections and lists the model wrote, several of
 * them are put together in the order they were released, and the result is
 * written out in the same shape it came in.
 *
 * Merging is what a reader would do by hand: sections that carry the same
 * heading become one section, their lists become one list, and a line that
 * appears in two releases is listed once.
 */

export type ReleaseFormat = "markdown" | "html";

/**
 * One piece of a section: a list, whose items merge, or anything else, which
 * is kept whole.
 */
export interface ReleaseBlock {
  kind: "list" | "text";
  /** The block as it was written. */
  content: string;
  /** For a list, its items as they were written, in order. */
  items?: string[];
  ordered?: boolean;
}

/** A heading and everything under it, up to the next heading of its level. */
export interface ReleaseSection {
  /** 1 to 6 for a heading; 0 for the document itself. */
  level: number;
  /** The heading as it was written, without its markup. */
  heading: string;
  blocks: ReleaseBlock[];
  children: ReleaseSection[];
}

// ─────────────────────────────────────────
// Reading a release note
// ─────────────────────────────────────────

/** Take a release note apart into its sections. */
export function parseReleaseDocument(content: string, format: ReleaseFormat): ReleaseSection {
  return format === "html" ? parseHtmlDocument(content) : parseMarkdownDocument(content);
}

/** Write a release note back out, in the shape it was read in. */
export function serializeReleaseDocument(section: ReleaseSection, format: ReleaseFormat): string {
  return format === "html" ? serializeHtml(section) : serializeMarkdown(section);
}

// ─────────────────────────────────────────
// Merging release notes
// ─────────────────────────────────────────

/**
 * Put several release notes together, oldest first.
 *
 * A single note is returned untouched: promoting one release copies its words
 * rather than reformatting them.
 */
export function mergeReleaseDocuments(documents: string[], format: ReleaseFormat): string {
  const contents = documents.map((document) => document.trim()).filter(Boolean);
  if (contents.length === 0) return "";
  if (contents.length === 1) return contents[0];

  const merged = contents
    .map((content) => parseReleaseDocument(content, format))
    .reduce((accumulated, next) => mergeSections(accumulated, next));

  return serializeReleaseDocument(merged, format);
}

/**
 * Put several release notes one after another, oldest first, each kept whole.
 *
 * Nothing is read or rewritten, so a note whose shape this cannot follow still
 * reaches the next environment word for word.
 */
export function joinReleaseDocuments(documents: string[], format: ReleaseFormat): string {
  return documents
    .map((document) => document.trim())
    .filter(Boolean)
    .join(format === "html" ? "\n<hr>\n" : "\n\n---\n\n");
}

/**
 * Join two release notes, the later one folded into the earlier.
 *
 * Both are left as they were; the result is a new section tree.
 */
export function mergeSections(target: ReleaseSection, source: ReleaseSection): ReleaseSection {
  const merged: ReleaseSection = {
    level: target.level,
    heading: target.heading,
    blocks: target.blocks.map((block) => ({ ...block, items: block.items?.slice() })),
    children: target.children.map(cloneSection),
  };

  for (const block of source.blocks) {
    addBlock(merged.blocks, block);
  }

  for (const child of source.children) {
    const existing = merged.children.findIndex(
      (candidate) => candidate.level === child.level && sameHeading(candidate.heading, child.heading)
    );
    if (existing >= 0) {
      merged.children[existing] = mergeSections(merged.children[existing], child);
      continue;
    }

    // A release note names itself after the release it describes, so the title
    // of one is never the title of the next. Merged, they are one release note
    // covering the whole range, and it takes the name of the newest release in
    // it rather than opening with two titles.
    if (isTitle(merged, child) && isTitle(source, child)) {
      merged.children[0] = { ...mergeSections(merged.children[0], child), heading: child.heading };
      continue;
    }

    merged.children.push(cloneSection(child));
  }

  return merged;
}

/**
 * Whether a document is one heading with everything under it, and `child` is
 * that heading.
 *
 * A note built that way has a title; a note that opens straight into its
 * sections has none, and nothing is renamed.
 */
function isTitle(section: ReleaseSection, child: ReleaseSection): boolean {
  return section.children.length === 1 && section.children[0].level === child.level;
}

function cloneSection(section: ReleaseSection): ReleaseSection {
  return {
    level: section.level,
    heading: section.heading,
    blocks: section.blocks.map((block) => ({ ...block, items: block.items?.slice() })),
    children: section.children.map(cloneSection),
  };
}

/** Add a block to a section, merging it into a list it belongs to. */
function addBlock(blocks: ReleaseBlock[], block: ReleaseBlock): void {
  if (block.kind === "list") {
    const list = blocks.find(
      (candidate) => candidate.kind === "list" && candidate.ordered === block.ordered
    );
    if (list) {
      const known = new Set((list.items || []).map(comparisonKey));
      for (const item of block.items || []) {
        if (known.has(comparisonKey(item))) continue;
        known.add(comparisonKey(item));
        list.items = [...(list.items || []), item];
      }
      return;
    }
  }

  const key = comparisonKey(block.content);
  if (blocks.some((candidate) => comparisonKey(candidate.content) === key)) return;
  blocks.push({ ...block, items: block.items?.slice() });
}

function sameHeading(left: string, right: string): boolean {
  return headingKey(left) === headingKey(right);
}

/**
 * What makes two headings the same one.
 *
 * A heading is written by a model, so the same section can arrive decorated
 * differently from one release to the next: emphasis, an emoji, trailing
 * punctuation. Only its letters and digits decide.
 */
function headingKey(heading: string): string {
  return stripMarkup(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** What makes two lines the same line, whatever markup carries them. */
function comparisonKey(value: string): string {
  return stripMarkup(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, " ")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─────────────────────────────────────────
// Markdown
// ─────────────────────────────────────────

const MARKDOWN_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const MARKDOWN_LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const MARKDOWN_FENCE = /^\s*(```+|~~~+)/;

function parseMarkdownDocument(markdown: string): ReleaseSection {
  const root: ReleaseSection = { level: 0, heading: "", blocks: [], children: [] };
  const open: ReleaseSection[] = [root];
  let body: string[] = [];

  const closeBody = () => {
    open[open.length - 1].blocks.push(...splitMarkdownBlocks(body));
    body = [];
  };

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  for (const line of lines) {
    if (MARKDOWN_FENCE.test(line)) inFence = !inFence;

    const heading = inFence ? null : MARKDOWN_HEADING.exec(line);
    if (!heading) {
      body.push(line);
      continue;
    }

    closeBody();
    const level = heading[1].length;
    while (open.length > 1 && open[open.length - 1].level >= level) open.pop();
    const section: ReleaseSection = { level, heading: heading[2].trim(), blocks: [], children: [] };
    open[open.length - 1].children.push(section);
    open.push(section);
  }
  closeBody();

  return root;
}

function splitMarkdownBlocks(lines: string[]): ReleaseBlock[] {
  const blocks: ReleaseBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = MARKDOWN_FENCE.exec(line);
    if (fence) {
      const start = index;
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${fence[1][0]}{3,}\\s*$`).test(lines[index])) {
        index += 1;
      }
      index = Math.min(index + 1, lines.length);
      blocks.push({ kind: "text", content: lines.slice(start, index).join("\n").trimEnd() });
      continue;
    }

    if (MARKDOWN_LIST_ITEM.test(line)) {
      const items: string[] = [];
      let current: string[] = [];
      // The first item sets what counts as an item of this list: anything
      // further in belongs to the item above it.
      const baseIndent = (MARKDOWN_LIST_ITEM.exec(line)?.[1] || "").length;
      while (index < lines.length) {
        const candidate = lines[index];
        const item = MARKDOWN_LIST_ITEM.exec(candidate);
        // A blank line ends the list unless the list goes on after it.
        if (!candidate.trim()) {
          const next = lines.slice(index + 1).find((following) => following.trim());
          if (!next || !(MARKDOWN_LIST_ITEM.test(next) || /^\s+\S/.test(next))) break;
          current.push(candidate);
          index += 1;
          continue;
        }
        if (item && item[1].length <= baseIndent) {
          if (current.length > 0) items.push(current.join("\n").trimEnd());
          current = [candidate];
        } else if (item || /^\s+\S/.test(candidate)) {
          // An indented line belongs to the item above it, list marker or not.
          current.push(candidate);
        } else {
          break;
        }
        index += 1;
      }
      if (current.length > 0) items.push(current.join("\n").trimEnd());
      const ordered = /^\s*\d+[.)]\s/.test(items[0] || "");
      blocks.push({ kind: "list", ordered, items, content: items.join("\n") });
      continue;
    }

    const start = index;
    while (index < lines.length && lines[index].trim() && !MARKDOWN_LIST_ITEM.test(lines[index]) && !MARKDOWN_FENCE.test(lines[index])) {
      index += 1;
    }
    blocks.push({ kind: "text", content: lines.slice(start, index).join("\n").trimEnd() });
  }

  return blocks;
}

function serializeMarkdown(section: ReleaseSection): string {
  const parts: string[] = [];
  if (section.level > 0) parts.push(`${"#".repeat(section.level)} ${section.heading}`);
  for (const block of section.blocks) {
    parts.push(block.kind === "list" ? (block.items || []).join("\n") : block.content);
  }
  for (const child of section.children) {
    parts.push(serializeMarkdown(child));
  }
  return parts.filter((part) => part.trim()).join("\n\n");
}

// ─────────────────────────────────────────
// HTML
// ─────────────────────────────────────────

const HTML_VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function parseHtmlDocument(html: string): ReleaseSection {
  const root: ReleaseSection = { level: 0, heading: "", blocks: [], children: [] };
  const open: ReleaseSection[] = [root];

  for (const element of splitHtmlElements(html)) {
    const heading = /^<h([1-6])\b[^>]*>([\s\S]*)<\/h\1>$/i.exec(element.trim());
    if (!heading) {
      open[open.length - 1].blocks.push(toHtmlBlock(element));
      continue;
    }

    const level = Number(heading[1]);
    while (open.length > 1 && open[open.length - 1].level >= level) open.pop();
    const section: ReleaseSection = { level, heading: heading[2].trim(), blocks: [], children: [] };
    open[open.length - 1].children.push(section);
    open.push(section);
  }

  return root;
}

function toHtmlBlock(element: string): ReleaseBlock {
  const list = /^<(ul|ol)\b[^>]*>([\s\S]*)<\/\1>$/i.exec(element.trim());
  if (!list) return { kind: "text", content: element.trim() };

  return {
    kind: "list",
    ordered: list[1].toLowerCase() === "ol",
    items: splitHtmlListItems(list[2]),
    content: element.trim(),
  };
}

/**
 * The top-level elements of an HTML fragment, in order.
 *
 * Depth is counted so that a list, a blockquote or a code block arrives whole,
 * with whatever it contains.
 */
function splitHtmlElements(html: string): string[] {
  const elements: string[] = [];
  let depth = 0;
  let current: string[] = [];

  for (const line of html.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim() && depth === 0) continue;
    current.push(line);
    depth += htmlDepthChange(line);
    if (depth <= 0) {
      const element = current.join("\n").trim();
      if (element) elements.push(element);
      current = [];
      depth = 0;
    }
  }

  const trailing = current.join("\n").trim();
  if (trailing) elements.push(trailing);
  return elements;
}

function htmlDepthChange(line: string): number {
  let change = 0;
  for (const match of line.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = match;
    if (HTML_VOID_ELEMENTS.has(name.toLowerCase()) || selfClosing) continue;
    change += closing ? -1 : 1;
  }
  return change;
}

function splitHtmlListItems(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current: string[] = [];

  for (const line of list.split("\n")) {
    const opensItem = depth === 0 && /^\s*<li\b/i.test(line);
    if (opensItem && current.length > 0) {
      items.push(current.join("\n").trim());
      current = [];
    }
    if (!line.trim() && current.length === 0) continue;
    current.push(line);
    depth = Math.max(0, depth + htmlDepthChange(line));
  }

  const trailing = current.join("\n").trim();
  if (trailing) items.push(trailing);
  return items.filter(Boolean);
}

function serializeHtml(section: ReleaseSection): string {
  const parts: string[] = [];
  if (section.level > 0) parts.push(`<h${section.level}>${section.heading}</h${section.level}>`);
  for (const block of section.blocks) {
    if (block.kind !== "list") {
      parts.push(block.content);
      continue;
    }
    const tag = block.ordered ? "ol" : "ul";
    parts.push([`<${tag}>`, ...(block.items || []), `</${tag}>`].join("\n"));
  }
  for (const child of section.children) {
    parts.push(serializeHtml(child));
  }
  return parts.filter((part) => part.trim()).join("\n");
}

// ─────────────────────────────────────────
// Finding a release note inside a rendered page
// ─────────────────────────────────────────

/**
 * Read the release note out of a rendered HTML page.
 *
 * A page carries no mark of ours saying where the note begins: the template
 * that produced it already says what surrounds it, and failing that the page's
 * own `main` or `article` does. When neither answers — a template of yours this
 * has never seen — nothing is returned, and the page is promoted as it stands
 * rather than cut at a guessed place.
 */
export function extractReleaseContent(page: string, template?: string): string | undefined {
  const anchored = template ? betweenTemplateAnchors(page, template) : undefined;
  if (anchored !== undefined) return anchored.trim();

  for (const element of ["main", "article"] as const) {
    const match = new RegExp(`<${element}\\b[^>]*>([\\s\\S]*)</${element}>`, "i").exec(page);
    if (match) return match[1].replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "").trim();
  }

  return undefined;
}

/**
 * The lines a template puts either side of `{{content}}`, used to find the note.
 *
 * Only the literal text next to the slot can be looked for: everything else in
 * a template is a slot whose value differs from one release to the next. A line
 * that appears more than once in the page is no landmark, and the page is left
 * to the next reader rather than cut at the wrong place.
 */
function betweenTemplateAnchors(page: string, template: string): string | undefined {
  const slot = template.indexOf("{{content}}");
  if (slot < 0) return undefined;

  const opening = lastLiteralLine(template.slice(0, slot));
  const closing = firstLiteralLine(template.slice(slot + "{{content}}".length));
  if (!isLandmark(page, opening) || !isLandmark(page, closing)) return undefined;

  const from = page.indexOf(opening);
  const to = page.indexOf(closing, from + opening.length);
  if (to < 0) return undefined;
  return page.slice(from + opening.length, to);
}

function isLandmark(page: string, anchor: string): boolean {
  return anchor.length > 0 && page.indexOf(anchor) === page.lastIndexOf(anchor);
}

/** The last written line before `{{content}}` that no slot can change. */
function lastLiteralLine(before: string): string {
  const lastSlot = before.lastIndexOf("}}");
  const literal = lastSlot < 0 ? before : before.slice(lastSlot + 2);
  return literal.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) || "";
}

/** The first written line after `{{content}}` that no slot can change. */
function firstLiteralLine(after: string): string {
  const nextSlot = after.indexOf("{{");
  const literal = nextSlot < 0 ? after : after.slice(0, nextSlot);
  return literal.split("\n").map((line) => line.trim()).filter(Boolean)[0] || "";
}
