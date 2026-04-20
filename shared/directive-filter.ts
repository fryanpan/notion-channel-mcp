/**
 * Directive filter for Notion page content-update events.
 *
 * Intent: only route page-edit events when the user has explicitly left
 * a directive for an agent to act on. A directive is a line that STARTS
 * with `TODO:` or `Claude:` (optionally with bullet / blockquote / bold
 * markup). Mentions mid-paragraph ("Claude Design", "pass a Claude:
 * prefix", etc.) are not directives and must not fire events.
 *
 * Previous version matched bare `\bTODO:` and `\bClaude\b` anywhere in
 * the page, which caused false positives every time Bryan wrote a plan
 * that mentioned the Claude Code product or the word TODO in context.
 */

export const CONTENT_UPDATE_PATTERNS: RegExp[] = [
  // TODO: at the start of a line, after optional leading whitespace,
  // list markers (- * + or N.), blockquote markers (>), and optional
  // bold wrapping (**).
  /^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+|\d+\.[ \t]+)?(?:\*\*)?TODO:(?:\*\*)?[ \t]/im,
  /^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+|\d+\.[ \t]+)?(?:\*\*)?Claude:(?:\*\*)?[ \t]/im,
];

export const SNIPPET_CONTEXT_CHARS = 80;

/**
 * Scan page text for directive patterns and return context snippets.
 * Dedupes overlapping matches. Empty result means "no directive" and
 * the event should be dropped.
 */
export function findDirectiveSnippets(text: string): string[] {
  const matches: Array<{ start: number; end: number }> = [];
  for (const pattern of CONTENT_UPDATE_PATTERNS) {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : pattern.flags + "g";
    const re = new RegExp(pattern.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = Math.max(0, m.index - SNIPPET_CONTEXT_CHARS / 4);
      const end = Math.min(
        text.length,
        m.index + m[0].length + SNIPPET_CONTEXT_CHARS,
      );
      matches.push({ start, end });
      // Guard against zero-width matches causing infinite loops on some engines.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  if (matches.length === 0) return [];
  matches.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [matches[0]];
  for (let i = 1; i < matches.length; i++) {
    const prev = merged[merged.length - 1];
    if (matches[i].start <= prev.end) {
      prev.end = Math.max(prev.end, matches[i].end);
    } else {
      merged.push(matches[i]);
    }
  }
  return merged.map((r) => text.slice(r.start, r.end).trim().replace(/\s+/g, " "));
}
