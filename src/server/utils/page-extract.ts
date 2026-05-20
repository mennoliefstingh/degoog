/**
 * Shared page extraction utility.
 * Extracts relevant prose paragraphs from HTML pages using Cheerio.
 * Used by both the at-a-glance slot and the AI summary extended context.
 */
import * as cheerio from "cheerio";
import { looksLikeProse } from "./text";
import { getRandomUserAgent } from "./user-agents";
import { createCache, type TtlCache } from "./cache";

export type ExcerptMode = "strict" | "full";

let _extractCache: TtlCache<string> = createCache<string>(60 * 60 * 1000);

/** Allow plugins to replace the cache instance (e.g. with a context-provided one) */
export function setExtractCache(cache: TtlCache<string>): void {
  _extractCache = cache;
}

function _pushParagraph(
  found: string[],
  text: string,
  perParaBudget: number,
): void {
  found.push(
    text.length > perParaBudget ? `${text.slice(0, perParaBudget)}…` : text,
  );
}

function _finalizeJoin(found: string[], maxLength: number): string {
  let joined = found.join("\n\n");
  if (joined.length > maxLength) {
    joined = `${joined.slice(0, maxLength)}…`;
  }
  return joined;
}

/**
 * Extract relevant prose paragraphs from raw HTML.
 */
export function extractFromHtml(
  html: string,
  queryTerms: string[],
  maxLength: number,
  maxParagraphs: number,
  excerptMode: ExcerptMode,
): string | null {
  const sepCost = Math.max(0, maxParagraphs - 1) * 2;
  const perParaBudget = Math.max(
    1,
    Math.floor((maxLength - sepCost) / maxParagraphs),
  );

  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, aside").remove();
  const root = $("article, main, [role='main']").first();
  const scope = root.length ? root : $("body");
  const found: string[] = [];

  if (excerptMode === "strict") {
    scope.find("p").each((_i, el) => {
      if (found.length >= maxParagraphs) return false;
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (text.length < 60) return;
      if (!looksLikeProse(text)) return;
      const lower = text.toLowerCase();
      if (queryTerms.some((t) => lower.includes(t))) {
        _pushParagraph(found, text, perParaBudget);
      }
    });
    return found.length > 0 ? _finalizeJoin(found, maxLength) : null;
  }

  // "full" mode: anchor on first matching paragraph, then take subsequent ones
  let anchored = false;
  scope.find("p").each((_i, el) => {
    if (found.length >= maxParagraphs) return false;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length < 60) return;
    if (!looksLikeProse(text)) return;
    const lower = text.toLowerCase();
    if (!anchored) {
      if (queryTerms.some((t) => lower.includes(t))) {
        _pushParagraph(found, text, perParaBudget);
        anchored = true;
      }
      return;
    }
    _pushParagraph(found, text, perParaBudget);
  });
  return found.length > 0 ? _finalizeJoin(found, maxLength) : null;
}

function _cacheKey(
  url: string,
  excerptMode: ExcerptMode,
  maxLength: number,
  maxParagraphs: number,
  queryTerms: string[],
): string {
  const termsKey = [...queryTerms].sort().join("\x1f");
  return `${url}\x1e${excerptMode}\x1e${maxLength}\x1e${maxParagraphs}\x1e${termsKey}`;
}

/**
 * Fetch a URL and extract relevant prose paragraphs.
 * Results are cached for 1 hour.
 */
export async function fetchExtract(
  url: string,
  queryTerms: string[],
  maxLength: number,
  maxParagraphs: number,
  excerptMode: ExcerptMode,
  timeoutMs: number,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string | null> {
  const key = _cacheKey(url, excerptMode, maxLength, maxParagraphs, queryTerms);
  const cached = _extractCache.get(key);
  if (cached !== null) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      headers: { "User-Agent": getRandomUserAgent(), Accept: "text/html" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) return null;
    const html = await res.text();
    const extracted = extractFromHtml(
      html,
      queryTerms,
      maxLength,
      maxParagraphs,
      excerptMode,
    );
    if (extracted) _extractCache.set(key, extracted);
    return extracted;
  } catch {
    clearTimeout(timer);
    return null;
  }
}
