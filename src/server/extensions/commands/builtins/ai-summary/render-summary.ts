/**
 * Rendering utilities for the AI Summary:
 * - Markdown → sanitized HTML (with syntax highlighting)
 * - Citation decoration (context-aware, skips code blocks)
 * - References section HTML
 * - Follow-up suggestions HTML
 */

import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import hljs from "highlight.js/lib/core";

// Register a useful subset of languages
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml"; // covers HTML
import json from "highlight.js/lib/languages/json";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("json", json);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

// Configure marked with highlight.js via marked-highlight extension
marked.use(
  markedHighlight({
    highlight(code: string, lang: string) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

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
  "button",
];
const ALLOWED_ATTR = [
  "href",
  "class",
  "data-cite",
  "data-code",
  "title",
  "target",
  "rel",
  "aria-label",
];

export interface SourceResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Convert markdown to sanitized HTML with syntax highlighting and copy buttons.
 */
export function renderMarkdownSafe(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  const sanitized = purify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: true,
  });
  // Wrap <pre><code> blocks with a container that includes a copy button
  return sanitized.replace(
    /<pre><code(?:\s+class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_match, langClass, code) => {
      const langLabel = langClass
        ? langClass.replace(/^language-/, "").replace(/^hljs\s*/, "")
        : "";
      return (
        `<div class="ai-code-block">` +
        `<div class="ai-code-header">` +
        (langLabel
          ? `<span class="ai-code-lang">${_escapeHtml(langLabel)}</span>`
          : "") +
        `<button class="ai-code-copy" aria-label="Copy code">Copy</button>` +
        `</div>` +
        `<pre><code${langClass ? ` class="${langClass}"` : ""}>${code}</code></pre>` +
        `</div>`
      );
    },
  );
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
 * Vertical numbered list matching Kagi's design.
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
      const pctDisplay = pct < 1 ? "< 1%" : `${pct}%`;

      return (
        `<li class="ai-ref-item">` +
        `<a class="ai-ref-title" href="${_escapeAttr(source.url)}" target="_blank" rel="noopener">${_escapeHtml(source.title)}</a>` +
        `<span class="ai-ref-meta">` +
        `<span class="ai-ref-domain">${_escapeHtml(domain)}</span>` +
        `<span class="ai-ref-pct">${pctDisplay}</span>` +
        `</span>` +
        `</li>`
      );
    })
    .filter(Boolean)
    .join("");

  return (
    `<div class="ai-references">` +
    `<h4 class="ai-section-header">References</h4>` +
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
    `<h4 class="ai-section-header">Related</h4>` +
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
