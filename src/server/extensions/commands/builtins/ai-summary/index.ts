import { createHash } from "node:crypto";
import {
  SlotPanelPosition,
  TranslateFunction,
  type ScoredResult,
  type SettingField,
  type SlotPlugin,
} from "../../../../types";
import {
  createCache,
  SHORT_TTL_MS,
  type TtlCache,
} from "../../../../utils/cache";
import { logger } from "../../../../utils/logger";
import { asBoolean, asString, getSettings } from "../../../../utils/plugin-settings";
import { parseAiSummary, stripInvalidCitations } from "./parse-summary";
import {
  buildFollowups,
  buildReferences,
  decorateCitations,
  renderMarkdownSafe,
  type SourceResult,
} from "./render-summary";

export const AI_SUMMARY_ID = "ai-summary";

export const aiSummarySettingsSchema: SettingField[] = [
  {
    key: "questionMarkOnly",
    label: "Only trigger on questions (?)",
    type: "toggle",
    description:
      "When enabled, AI summaries only appear when the query ends with a question mark.",
  },
  {
    key: "baseUrl",
    label: "API Base URL",
    type: "url",
    required: true,
    placeholder: "https://api.openai.com/v1",
    description:
      "OpenAI-compatible base URL. Use http://localhost:11434/v1 for Ollama",
  },
  {
    key: "model",
    label: "Model",
    type: "text",
    required: true,
    placeholder: "gpt-4o-mini",
    description:
      "Model name (e.g. gpt-4o-mini, llama3, mistral). Note: reasoning/thinking models (e.g. qwen3, deepseek-r1) may not work well here as their chain-of-thought consumes the token budget before producing a summary. Increase Max Tokens if you must use one.",
  },
  {
    key: "apiKey",
    label: "API Key",
    type: "password",
    secret: true,
    placeholder: "Leave blank for local models (Ollama)",
    description: "API key for the provider. Not required for local Ollama.",
  },
  {
    key: "timeoutSeconds",
    label: "Timeout (seconds)",
    type: "text",
    placeholder: "30",
    description:
      "Max seconds to wait for an AI response before falling back to the standard result.",
  },
  {
    key: "maxTokens",
    label: "Max Tokens",
    type: "text",
    placeholder: "1024",
    description:
      "Maximum tokens for the AI response. Bump this up (e.g. 1024+) if you use reasoning/thinking models.",
  },
  {
    key: "extendedContext",
    label: "Extended context (full mode)",
    type: "select",
    options: ["off", "top3", "all"],
    default: "off",
    description:
      "In full mode (? queries), scrape page content for richer AI answers. 'top3' scrapes top 3 results; 'all' scrapes all 6. Adds 1-3s latency.",
  },
  {
    key: "extendedContextBudget",
    label: "Scrape budget per page (chars)",
    type: "number",
    default: "800",
    placeholder: "800",
    description:
      "Maximum characters to extract from each scraped page. Higher = better context but more tokens.",
  },
  {
    key: "systemPrompt",
    label: "Custom System Prompt",
    type: "textarea",
    placeholder:
      "You are a helpful assistant that summarises web search results. Write a concise 2–3 sentence summary answering the query based on the provided snippets. Do not invent facts. Do not include citations.",
    description:
      "Override the default system prompt sent to the AI. Leave blank to use the default.",
  },
];

export interface AISummarySettings {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  systemPrompt: string;
  maxTokens: number;
  questionMarkOnly: boolean;
  extendedContext: "off" | "top3" | "all";
  extendedContextBudget: number;
}

export async function getAISummarySettings(): Promise<AISummarySettings> {
  const stored = await getSettings(AI_SUMMARY_ID);
  const timeoutSeconds =
    parseFloat(asString(stored["timeoutSeconds"]) || "") || 30;
  const maxTokens = parseInt(asString(stored["maxTokens"]) || "", 10) || DEFAULT_MAX_TOKENS;
  const rawExtCtx = asString(stored["extendedContext"]).toLowerCase();
  const extendedContext: AISummarySettings["extendedContext"] =
    rawExtCtx === "top3" || rawExtCtx === "all" ? rawExtCtx : "off";
  const rawBudget = parseInt(asString(stored["extendedContextBudget"]) || "", 10);
  return {
    baseUrl: asString(stored["baseUrl"]),
    model: asString(stored["model"]),
    apiKey: asString(stored["apiKey"]),
    timeoutMs: Math.max(5, timeoutSeconds) * 1000,
    systemPrompt: asString(stored["systemPrompt"]),
    maxTokens: Math.max(16, maxTokens),
    questionMarkOnly: asBoolean(stored["questionMarkOnly"]),
    extendedContext,
    extendedContextBudget: Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : 800,
  };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChatResponse {
  choices?: {
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DEFAULT_SYSTEM_PROMPT = `You are an expert search assistant. Answer the user's query using the provided search results.

FORMAT:
- Use Markdown: **bold**, *italic*, \`inline code\`, fenced code blocks (with language tag), lists.
- **Bold key phrases** that directly answer the query to improve skimmability.
- For programming questions, include working code examples.
- Be concise but thorough. Paraphrase in your own words.

CITATIONS:
- Cite sources using [N] where N is the 1-indexed result number. Place citations inline after the claim they support.
- Cite ALL factual claims. Every statement based on a search result must have a citation.
- To cite multiple sources for one claim: "This is true [1][3]."
- Do not list sources at the end — only use inline citations.

LANGUAGE:
- Always respond in the same language as the user's query.

FOLLOW-UP QUESTIONS:
After your answer, add exactly this block with 3 relevant follow-up questions in the query's language:

\\\`\\\`\\\`followups
["Question 1?", "Question 2?", "Question 3?"]
\\\`\\\`\\\``;

const COMPACT_SYSTEM_PROMPT = `You are a concise search assistant. Answer the user's query in 3-5 sentences using the provided search results.

RULES:
- Be extremely concise. Maximum 4-5 sentences.
- **Bold key phrases** for quick scanning.
- Cite sources with [N] inline after claims.
- Respond in the same language as the query.
- No follow-up questions, no code blocks unless essential.
- Do NOT add a followups block.`;

const DEFAULT_MAX_TOKENS = 1024;

const _richCache: TtlCache<AISummaryResult> = createCache<AISummaryResult>(SHORT_TTL_MS);

function _buildFullHtml(result: AISummaryResult, t: (key: string) => string, mode: "full" | "compact"): string {
  if (mode === "compact") {
    return (
      '<div class="glance-ai glance-ai--compact degoog-panel degoog-panel--slot degoog-panel--slot-body-padded degoog-vstack">' +
      '<div class="glance-ai-answer degoog-text degoog-text--md">' +
      result.html +
      "</div>" +
      '<div class="glance-ai-footer">' +
      `<span class="glance-ai-badge degoog-badge">${t("ai-summary.badge")}</span>` +
      "</div>" +
      "</div>"
    );
  }
  // Full mode — answer + "Show more" toggle for references/followups/chat
  return (
    '<div class="glance-ai glance-ai--full degoog-panel degoog-panel--slot degoog-panel--slot-body-padded degoog-vstack">' +
    '<div class="glance-ai-answer degoog-text degoog-text--md">' +
    result.html +
    "</div>" +
    '<button class="ai-show-more" type="button">Show More ∨</button>' +
    '<div class="glance-ai-extra" hidden>' +
    result.referencesHtml +
    result.followupsHtml +
    '<div class="glance-ai-chat">' +
    `<textarea class="glance-ai-input degoog-input degoog-input--chat" placeholder="${t("ai-summary.follow-up-placeholder")}" rows="1"></textarea>` +
    "</div>" +
    "</div>" +
    '<div class="glance-ai-footer">' +
    `<span class="glance-ai-badge degoog-badge">${t("ai-summary.badge")}</span>` +
    "</div>" +
    "</div>"
  );
}

function _summaryCacheKey(query: string, results: ScoredResult[]): string {
  const fp = results
    .slice(0, 6)
    .map((r) => `${r.url}\n${r.snippet}`)
    .join("\n\n");
  const hash = createHash("sha256").update(fp).digest("hex").slice(0, 24);
  return `${query.trim().toLowerCase()}|${hash}`;
}

async function chatComplete(
  settings: AISummarySettings,
  messages: OpenAIMessage[],
  maxTokens?: number,
): Promise<string | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.apiKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;

  try {
    const res = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.model,
        messages,
        max_tokens: maxTokens ?? settings.maxTokens,
      }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as OpenAIChatResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim();
    const reasoning = choice?.message?.reasoning_content?.trim();
    if (content) return content;
    if (reasoning) {
      logger.debug(
        AI_SUMMARY_ID,
        `empty content, falling back to reasoning_content (finish_reason=${choice?.finish_reason}). Consider increasing Max Tokens.`,
      );
      return reasoning;
    }
    logger.debug(
      AI_SUMMARY_ID,
      `model returned empty content and reasoning_content (finish_reason=${choice?.finish_reason}).`,
    );
    return null;
  } catch {
    return null;
  }
}

/**
 * Stream chat completions from the LLM. Yields token strings as they arrive.
 * Returns null if the request fails or settings are misconfigured.
 */
export async function* chatCompleteStream(
  query: string,
  results: { title: string; url: string; snippet: string }[],
  mode: "full" | "compact" = "full",
): AsyncGenerator<{ type: "token"; text: string } | { type: "done"; full: string }> {
  const settings = await getAISummarySettings();
  if (!settings.baseUrl || !settings.model) return;

  const sliced = results.slice(0, 6);
  const context = sliced
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
    .join("\n\n");

  const systemPrompt = mode === "compact"
    ? COMPACT_SYSTEM_PROMPT
    : (settings.systemPrompt || DEFAULT_SYSTEM_PROMPT);
  const maxTokens = mode === "compact" ? Math.min(256, settings.maxTokens) : settings.maxTokens;

  const messages: OpenAIMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Query: ${query}\n\nSearch results:\n${context}` },
  ];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.apiKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;

  let res: Response;
  try {
    res = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.model,
        messages,
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: AbortSignal.timeout(settings.timeoutMs * 2),
    });
  } catch {
    return;
  }
  if (!res.ok || !res.body) return;

  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  const reader = res.body!.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          yield { type: "done" as const, full };
          return;
        }
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            yield { type: "token" as const, text: delta };
          }
        } catch {
          // skip malformed SSE chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  // If stream ended without [DONE]
  if (full) yield { type: "done" as const, full };
}

export interface AISummaryResult {
  raw: string;
  html: string;
  referencesHtml: string;
  followupsHtml: string;
  followups: string[];
  citedIndices: number[];
}

export async function generateAISummary(
  query: string,
  results: { title: string; url: string; snippet: string }[],
): Promise<AISummaryResult | null> {
  const settings = await getAISummarySettings();
  if (!settings.baseUrl || !settings.model) return null;

  const sliced = results.slice(0, 6);
  const context = sliced
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
    .join("\n\n");

  const messages: OpenAIMessage[] = [
    {
      role: "system",
      content: settings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: `Query: ${query}\n\nSearch results:\n${context}`,
    },
  ];

  const raw = await chatComplete(settings, messages);
  if (!raw) return null;

  const sources: SourceResult[] = sliced.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
  }));

  const parsed = parseAiSummary(raw, sliced.length);
  const cleanMd = stripInvalidCitations(parsed.markdown, sliced.length);
  const baseHtml = renderMarkdownSafe(cleanMd);
  const html = decorateCitations(baseHtml, sources);
  const referencesHtml = buildReferences(sources, parsed.citedIndices);
  const followupsHtml = buildFollowups(parsed.followups, query);

  return {
    raw,
    html,
    referencesHtml,
    followupsHtml,
    followups: parsed.followups,
    citedIndices: parsed.citedIndices,
  };
}

export async function chatFollowUp(
  history: OpenAIMessage[],
): Promise<string | null> {
  const settings = await getAISummarySettings();
  if (!settings.baseUrl || !settings.model) return null;
  return chatComplete(settings, history, Math.max(settings.maxTokens, 512));
}

const aiSummarySlot: SlotPlugin = {
  id: AI_SUMMARY_ID,
  settingsId: AI_SUMMARY_ID,
  name: "AI Summary",
  waitForResults: true,
  get description(): string {
    return this.t!("ai-summary.description");
  },
  position: SlotPanelPosition.AtAGlance,
  isClientExposed: false,

  t: TranslateFunction,

  async trigger(query: string): Promise<boolean> {
    const settings = await getAISummarySettings();
    if (!settings.baseUrl || !settings.model) return false;
    // Always trigger when plugin is enabled — mode (compact/full) determined in execute()
    return true;
  },
  async execute(query, context): Promise<{ title?: string; html: string }> {
    const results = context?.results ?? [];
    if (results.length === 0) return { html: "" };

    const isFullMode = query.trim().endsWith("?");
    const mode = isFullMode ? "full" : "compact";

    // Check if we have a cached result — if so, serve it immediately (no streaming needed)
    const key = _summaryCacheKey(query, results);
    const cached = _richCache.get(key);
    if (cached !== null) {
      return {
        html: _buildFullHtml(cached, this.t!, mode),
      };
    }

    // No cache — return streaming placeholder. Client JS will call /api/ai-summary/stream.
    const resultsPayload = JSON.stringify(
      results.slice(0, 6).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
    );

    if (mode === "compact") {
      return {
        html:
          `<div class="glance-ai glance-ai--compact degoog-panel degoog-panel--slot degoog-panel--slot-body-padded degoog-vstack" data-stream-query="${escapeHtml(query)}" data-stream-results='${resultsPayload.replace(/'/g, "&#39;")}' data-stream-mode="compact">` +
          '<div class="glance-ai-answer degoog-text degoog-text--md">' +
          '<div class="glance-ai-skeleton"><div class="skel-line skel-line--long"></div><div class="skel-line skel-line--med"></div></div>' +
          "</div>" +
          '<div class="glance-ai-footer">' +
          `<span class="glance-ai-badge degoog-badge">${this.t!("ai-summary.badge")}</span>` +
          "</div>" +
          "</div>",
      };
    }

    // Full mode placeholder
    return {
      html:
        `<div class="glance-ai glance-ai--full degoog-panel degoog-panel--slot degoog-panel--slot-body-padded degoog-vstack" data-stream-query="${escapeHtml(query)}" data-stream-results='${resultsPayload.replace(/'/g, "&#39;")}' data-stream-mode="full">` +
        '<div class="glance-ai-answer degoog-text degoog-text--md">' +
        '<div class="glance-ai-skeleton"><div class="skel-line skel-line--long"></div><div class="skel-line skel-line--med"></div><div class="skel-line skel-line--short"></div></div>' +
        "</div>" +
        '<div class="glance-ai-footer">' +
        `<span class="glance-ai-badge degoog-badge">${this.t!("ai-summary.badge")}</span>` +
        "</div>" +
        "</div>",
    };
  },
  settingsSchema: aiSummarySettingsSchema,
};

export const slot = aiSummarySlot;
