/**
 * Rendering utilities for the AI Summary:
 * - Markdown → sanitized HTML
 * - Citation decoration (context-aware, skips code blocks)
 * - References section HTML
 * - Follow-up suggestions HTML
 */

import { marked } from "marked";
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

// Server-side DOMPurify needs a window from jsdom
const window = new JSDOM("").window;
const purify = DOMPurify(window as any);

const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "h4",
  "a",
  "sup",
  "span",
  "div",
  "blockquote",
];
const ALLOWED_ATTR = ["href", "class", "data-cite", "title", "target", "rel"];

export interface SourceResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Convert markdown to sanitized HTML.
 */
export function renderMarkdownSafe(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return purify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: true,
  });
}

/**
 * Replace [N] citation markers with decorated <sup> elements.
 * Skips citations inside <code> and <pre> blocks.
 */
export function decorateCitations(
  html: string,
  results: SourceResult[],
): string {
  // Split HTML into code/non-code segments to avoid decorating inside code
  const parts = html.split(/(<(?:pre|code)[^>]*>[\s\S]*?<\/(?:pre|code)>)/gi);

  return parts
    .map((part, i) => {
      // Odd indices are code blocks — leave untouched
      if (i % 2 === 1) return part;
      // Even indices are regular content — decorate citations
      return part.replace(/\[(\d+)\]/g, (full, numStr) => {
        const idx = parseInt(numStr, 10);
        if (idx < 1 || idx > results.length) return full;
        const source = results[idx - 1];
        const escapedTitle = _escapeAttr(source.title);
        const escapedSnippet = _escapeAttr(
          source.snippet.length > 150
            ? source.snippet.slice(0, 150) + "…"
            : source.snippet,
        );
        const escapedUrl = _escapeAttr(source.url);
        const domain = _extractDomain(source.url);

        return (
          `<sup class="ai-cite" data-cite="${idx}">` +
          `<a href="${escapedUrl}" target="_blank" rel="noopener">${idx}</a>` +
          `<span class="ai-cite-tooltip">` +
          `<span class="ai-cite-source">${_escapeHtml(domain)}</span>` +
          `<b>${_escapeHtml(source.title)}</b>` +
          `<span class="ai-cite-passage">${_escapeHtml(escapedSnippet)}</span>` +
          `</span>` +
          `</sup>`
        );
      });
    })
    .join("");
}

/**
 * Build the references section HTML from cited sources.
 */
export function buildReferences(
  results: SourceResult[],
  citedIndices: number[],
): string {
  if (citedIndices.length === 0) return "";

  // Count citations per source
  const citeCounts = new Map<number, number>();
  citedIndices.forEach((idx) => {
    citeCounts.set(idx, (citeCounts.get(idx) ?? 0) + 1);
  });

  // Deduplicate and preserve order
  const uniqueIndices = [...new Set(citedIndices)];
  const totalCitations = citedIndices.length;

  const items = uniqueIndices
    .map((idx) => {
      const source = results[idx - 1];
      if (!source) return "";
      const count = citeCounts.get(idx) ?? 1;
      const pct = Math.round((count / totalCitations) * 100);
      const domain = _extractDomain(source.url);

      return (
        `<li class="ai-ref-item">` +
        `<a href="${_escapeAttr(source.url)}" target="_blank" rel="noopener">${_escapeHtml(source.title)}</a>` +
        `<span class="ai-ref-domain">${_escapeHtml(domain)}</span>` +
        `<span class="ai-ref-pct" style="--pct: ${pct}%">${pct}%</span>` +
        `</li>`
      );
    })
    .filter(Boolean)
    .join("");

  return (
    `<div class="ai-references">` +
    `<h4 class="ai-references-header">References</h4>` +
    `<ol class="ai-ref-list">${items}</ol>` +
    `</div>`
  );
}

/**
 * Build follow-up suggestions HTML.
 */
export function buildFollowups(followups: string[], query: string): string {
  if (followups.length === 0) return "";

  const items = followups
    .map((q) => {
      const href = `/search?q=${encodeURIComponent(q)}`;
      return (
        `<a class="ai-followup-link" href="${_escapeAttr(href)}">` +
        `<span class="ai-followup-icon">↩</span>` +
        `<span class="ai-followup-text">${_escapeHtml(q)}</span>` +
        `</a>`
      );
    })
    .join("");

  return (
    `<div class="ai-followups">` +
    `<h4 class="ai-followups-header">Related</h4>` +
    `${items}` +
    `</div>`
  );
}

// --- internal helpers ---

function _escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function _extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
