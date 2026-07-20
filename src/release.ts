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
  const cleanVersion = params.toVersion.replace(/^v/, "");
  const project = params.projectName ? `${params.projectName} – ` : "";
  const header = `${project}Release Notes ${params.environment} (${params.fromVersion} → ${params.toVersion})

Version ${cleanVersion} – ${params.date}

`;

  return header + llmOutput.trim();
}

/**
 * Convert markdown to basic HTML.
 */
export function markdownToHtml(markdown: string): string {
  let html = markdown
    .replace(/^### (.*$)/gim, "<h3>$1</h3>")
    .replace(/^## (.*$)/gim, "<h2>$1</h2>")
    .replace(/^# (.*$)/gim, "<h1>$1</h1>")
    .replace(/^\> (.*$)/gim, "<blockquote>$1</blockquote>")
    .replace(/\*\*\*(.*?)\*\*\*/gim, "<b><i>$1</i></b>")
    .replace(/\*\*(.*?)\*\*/gim, "<b>$1</b>")
    .replace(/\*(.*?)\*/gim, "<i>$1</i>")
    .replace(/`{3}[\s\S]*?`{3}/gim, (match) =>
      `<pre><code>${match.replace(/`{3}/g, "").trim()}</code></pre>`
    )
    .replace(/`(.*?)`/gim, "<code>$1</code>")
    .replace(/^\- (.*$)/gim, "<li>$1</li>")
    .replace(/^\d+\. (.*$)/gim, "<li>$1</li>")
    .replace(/\n/gim, "<br>");

  // Wrap lists
  html = html.replace(/(<li>.*?<\/li>)/gims, "<ul>$1</ul>");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Release Notes</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
h1, h2, h3 { color: #1a1a1a; }
ul { padding-left: 20px; }
li { margin: 4px 0; }
blockquote { border-left: 4px solid #ddd; padding-left: 16px; margin-left: 0; color: #666; }
code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
pre { background: #f4f4f4; padding: 16px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
</style>
</head>
<body>
${html}
</body>
</html>`;
}
