/**
 * Shared page extraction utility.
 * Extracts relevant prose paragraphs from HTML pages using Cheerio.
 * Used by both the at-a-glance slot and the AI summary extended context.
 */
import * as cheerio from "cheerio";
import { looksLikeProse } from "./text";
import { getRandomUserAgent } from "./user-agents";
import { createCache, type TtlCache } from "./cache";
import { isSafePublicUrlForOutgoing } from "./outgoing";

export type ExcerptMode = "strict" | "full";

let _extractCache: TtlCache<string> = createCache<string>(60 * 60 * 1000);
const MAX_EXTRACT_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

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

async function readTextWithLimit(
  res: Response,
  maxBytes: number,
): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("response body too large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function redirectTarget(location: string, currentUrl: string): string | null {
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return null;
  }
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
  if (!(await isSafePublicUrlForOutgoing(url))) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = url;
    let res: Response | null = null;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      res = await fetchFn(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": getRandomUserAgent(), Accept: "text/html" },
      });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) return null;
      const nextUrl = redirectTarget(location, currentUrl);
      if (!nextUrl || !(await isSafePublicUrlForOutgoing(nextUrl))) return null;
      currentUrl = nextUrl;
    }
    if (!res) return null;
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) return null;
    const html = await readTextWithLimit(res, MAX_EXTRACT_BYTES);
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
    return null;
  } finally {
    clearTimeout(timer);
  }
}
