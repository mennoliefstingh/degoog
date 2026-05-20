/**
 * Parses the raw LLM response into structured parts:
 * - The main markdown answer
 * - Follow-up questions (extracted from fenced JSON block)
 * - Cited source indices (validated against result count)
 */

const FOLLOWUPS_FENCE = /```followups\s*\n([\s\S]*?)```/;
const CITATION_PATTERN = /\[(\d+)\]/g;

export interface ParsedSummary {
  markdown: string;
  followups: string[];
  citedIndices: number[];
}

/**
 * Parse the raw LLM output, splitting answer from follow-ups and extracting citations.
 * @param raw - The full LLM response text
 * @param resultCount - Number of search results provided (for citation validation)
 */
export function parseAiSummary(raw: string, resultCount: number): ParsedSummary {
  let markdown = raw.trim();
  let followups: string[] = [];

  const fenceMatch = markdown.match(FOLLOWUPS_FENCE);
  if (fenceMatch) {
    markdown = markdown.replace(FOLLOWUPS_FENCE, "").trim();
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) {
        followups = parsed
          .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
          .slice(0, 5);
      }
    } catch {
      // Malformed JSON — silently skip follow-ups
    }
  }

  // Extract valid citation indices from the markdown
  const citedIndices: number[] = [];
  const seen = new Set<number>();
  let match: RegExpExecArray | null;
  const citRegex = new RegExp(CITATION_PATTERN.source, "g");

  while ((match = citRegex.exec(markdown)) !== null) {
    const idx = parseInt(match[1], 10);
    if (idx >= 1 && idx <= resultCount && !seen.has(idx)) {
      seen.add(idx);
      citedIndices.push(idx);
    }
  }

  return { markdown, followups, citedIndices };
}

/**
 * Remove invalid citations (out of range) from the markdown text.
 * Keeps valid ones intact for later decoration.
 */
export function stripInvalidCitations(
  markdown: string,
  resultCount: number,
): string {
  return markdown.replace(CITATION_PATTERN, (full, numStr) => {
    const idx = parseInt(numStr, 10);
    return idx >= 1 && idx <= resultCount ? full : "";
  });
}
