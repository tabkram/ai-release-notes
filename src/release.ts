/**
 * Release note formatting
 */

/**
 * Format the final release note with header.
 */
export function formatReleaseNote(
  llmOutput: string,
  params: {
    fromVersion: string;
    toVersion: string;
    environment: string;
    date: string;
    projectName?: string;
  }
): string {
  const project = params.projectName ? `${params.projectName} · ` : "";
  const header = `# ${project}Release ${params.toVersion}

_${params.environment} · ${params.date} · Changes since ${params.fromVersion}_

---

`;

  return header + llmOutput.trim();
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
  const title = `${params.projectName ? params.projectName + " · " : ""}Release ${params.toVersion}`;
  return template
    .replaceAll("{{title}}", escapeHtml(title))
    .replaceAll("{{projectName}}", escapeHtml(params.projectName || ""))
    .replaceAll("{{fromVersion}}", escapeHtml(params.fromVersion))
    .replaceAll("{{toVersion}}", escapeHtml(params.toVersion))
    .replaceAll("{{environment}}", escapeHtml(params.environment))
    .replaceAll("{{date}}", escapeHtml(params.date))
    .replaceAll("{{content}}", renderMarkdown(content));
}

/** Convert Markdown to self-contained, browser-friendly HTML. */
export function markdownToHtml(markdown: string, title = "Release Notes"): string {
  const html = renderMarkdown(markdown);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --page: #ffffff; --surface: #f6f7f8; --text: #202124; --muted: #5f6368; --line: #d9dde3; --link: #1558d6; }
@media (prefers-color-scheme: dark) { :root { --page: #181a1b; --surface: #242729; --text: #e8eaed; --muted: #b8bec5; --line: #3c4043; --link: #8ab4f8; } }
* { box-sizing: border-box; }
html { background: var(--page); }
body { max-width: 54rem; margin: 0 auto; padding: 3rem 1.5rem; background: var(--page); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 1rem; line-height: 1.65; }
main { min-width: 0; }
h1, h2, h3 { color: var(--text); line-height: 1.25; letter-spacing: -0.015em; }
h1 { margin: 0 0 1.75rem; font-size: clamp(1.9rem, 4vw, 2.6rem); }
h2 { margin: 2.25rem 0 0.85rem; padding-bottom: 0.45rem; border-bottom: 1px solid var(--line); font-size: 1.4rem; }
h3 { margin: 1.75rem 0 0.65rem; font-size: 1.1rem; }
p { margin: 0.85rem 0; }
section { margin: 2rem 0; }
.release-entry { margin: 1.25rem 0; padding: 1.35rem 1.5rem; border: 1px solid var(--line); border-radius: 0.75rem; background: var(--surface); }
.release-entry h2 { margin: 0; padding: 0; border: 0; font-size: 1.2rem; }
.release-meta { margin: 0.45rem 0 1rem; color: var(--muted); font-size: 0.925rem; }
.release-link { margin: 0; font-weight: 600; }
ul, ol { margin: 0.85rem 0; padding-left: 1.35rem; }
li + li { margin-top: 0.35rem; }
a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 0.16em; }
a:hover { text-decoration-thickness: 2px; }
blockquote { margin: 1.25rem 0; padding: 0.15rem 0 0.15rem 1rem; border-left: 3px solid var(--line); color: var(--muted); }
code { padding: 0.12em 0.35em; border-radius: 0.3rem; background: var(--surface); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
pre { margin: 1.25rem 0; padding: 1rem; overflow-x: auto; border: 1px solid var(--line); border-radius: 0.6rem; background: var(--surface); }
pre code { padding: 0; background: none; font-size: 0.875rem; }
hr { height: 1px; margin: 2.5rem 0; border: 0; background: var(--line); }
footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.875rem; }
</style>
</head>
<body>
<main>
${html}
</main>
</body>
</html>`;
}

function renderMarkdown(markdown: string): string {
  const output: string[] = [];
  const paragraph: string[] = [];
  const codeLines: string[] = [];
  let listType: "ul" | "ol" | undefined;
  let inCodeBlock = false;

  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = undefined;
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

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("```")) {
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

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const listItem = /^\s*([-*])\s+(.+)$/.exec(line);
    const numberedItem = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (/^---+$/.test(line.trim())) {
      closeParagraph();
      closeList();
      output.push("<hr>");
    } else if (listItem || numberedItem) {
      closeParagraph();
      const nextListType = numberedItem ? "ol" : "ul";
      if (listType !== nextListType) {
        closeList();
        listType = nextListType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${inlineMarkdown((listItem?.[2] || numberedItem?.[1])!)}</li>`);
    } else if (line.startsWith("> ")) {
      closeParagraph();
      closeList();
      output.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`);
    } else if (/^<!--.*-->$/.test(line.trim()) || /^<\/?[a-z][\s\S]*>$/i.test(line.trim())) {
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
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
