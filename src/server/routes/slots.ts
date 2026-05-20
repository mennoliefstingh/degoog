import { Hono } from "hono";
import { getSlotPlugins } from "../extensions/slots/registry";
import {
  ScoredResult,
  SlotPanelPosition,
  SlotPanelResult,
  SlotPluginContext,
} from "../types";
import { createCache } from "../utils/cache";
import { getLocale } from "../utils/hono";
import { logger } from "../utils/logger";
import { outgoingFetch } from "../utils/outgoing";
import { isDisabled } from "../utils/plugin-settings";
import { buildSignedProxyUrl } from "../utils/proxy-sign";
import { getClientIp } from "../utils/request";
import { _applyRateLimit, runSlotPlugins } from "../utils/search";
import { injectScope, translateHTML } from "../utils/translation";
import {
  chatCompleteStream,
  getAISummarySettings,
  AI_SUMMARY_ID,
} from "../extensions/commands/builtins/ai-summary/index";
import { parseAiSummary, stripInvalidCitations } from "../extensions/commands/builtins/ai-summary/parse-summary";
import {
  renderMarkdownSafe,
  decorateCitations,
  buildReferences,
  buildFollowups,
  type SourceResult,
} from "../extensions/commands/builtins/ai-summary/render-summary";

const router = new Hono();

router.post("/api/slots", async (c) => {
  const limitRes = await _applyRateLimit(c);
  if (limitRes) return limitRes;
  let body: { query?: string; results?: ScoredResult[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.query || !body.query.trim()) return c.json({ panels: [] });
  const clientIp = getClientIp(c);
  const panels = await runSlotPlugins(
    body.query.trim(),
    clientIp,
    body.results,
    {
      excludePosition: SlotPanelPosition.AtAGlance,
      locale: getLocale(c),
    },
  );
  return c.json({ panels });
});

router.post("/api/slots/glance", async (c) => {
  const limitRes = await _applyRateLimit(c);
  if (limitRes) return limitRes;
  let body: { query?: string; results?: ScoredResult[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.query || !Array.isArray(body.results)) {
    return c.json({ error: "Missing query or results" }, 400);
  }
  const clientIp = getClientIp(c);
  const locale = getLocale(c);
  const glancePlugins = getSlotPlugins().filter(
    (p) => p.position === SlotPanelPosition.AtAGlance,
  );
  const panels: SlotPanelResult[] = [];
  for (const plugin of glancePlugins) {
    if (!plugin.id) {
      logger.warn(
        "slots",
        `Skipping slot plugin: missing id (name="${plugin.name}")`,
      );
      continue;
    }
    try {
      const slotSettingsId = plugin.settingsId ?? `slot-${plugin.id}`;
      if (await isDisabled(slotSettingsId)) continue;
      const ok = await Promise.resolve(plugin.trigger(body.query!.trim()));
      if (!ok) continue;
      if (plugin.t && locale) plugin.t.setLocale(locale);
      const context: SlotPluginContext = {
        clientIp: clientIp ?? undefined,
        results: body.results,
        fetch: outgoingFetch as SlotPluginContext["fetch"],
        signProxyUrl: buildSignedProxyUrl,
        createCache,
      };
      const t0 = performance.now();
      const out = await plugin.execute(body.query!.trim(), context);
      logger.debug(
        "plugin",
        `${plugin.id} executed in ${Math.round(performance.now() - t0)}ms`,
      );
      if (!out.html || !out.html.trim()) continue;
      panels.push({
        id: plugin.id,
        title: out.title,
        html: injectScope(
          plugin.t ? translateHTML(out.html, plugin.t) : out.html,
          `slots/${plugin.id}`,
        ),
        position: plugin.position,
        gridSize: plugin.gridSize,
      });
    } catch (err) {
      logger.warn("plugin", `${plugin.id} slot failed`, err);
    }
  }
  return c.json({ panels });
});

router.post("/api/ai-summary/stream", async (c) => {
  const limitRes = await _applyRateLimit(c);
  if (limitRes) return limitRes;

  let body: { query?: string; results?: ScoredResult[]; mode?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.query || !Array.isArray(body.results) || body.results.length === 0) {
    return c.json({ error: "Missing query or results" }, 400);
  }

  const settings = await getAISummarySettings();
  if (!settings.baseUrl || !settings.model) {
    return c.json({ error: "AI summary not configured" }, 503);
  }

  const query = body.query.trim();
  const streamMode = (body.mode === "compact" ? "compact" : "full") as "full" | "compact";
  const sliced = body.results.slice(0, 6);

  // Extended context: scrape pages in full mode if enabled
  let enrichedResults = sliced.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet ?? "",
  }));

  if (streamMode === "full" && settings.extendedContext !== "off") {
    const { fetchExtract } = await import("../utils/page-extract");
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scrapeCount = settings.extendedContext === "all" ? sliced.length : Math.min(3, sliced.length);
    const budget = settings.extendedContextBudget;

    const scrapePromises = sliced.slice(0, scrapeCount).map((r) =>
      fetchExtract(r.url, queryTerms, budget, 3, "full", 3000, outgoingFetch as any)
    );
    const scraped = await Promise.all(scrapePromises);

    enrichedResults = sliced.map((r, i) => ({
      title: r.title,
      url: r.url,
      snippet: (i < scrapeCount && scraped[i]) ? scraped[i]! : (r.snippet ?? ""),
    }));
  }

  const sources: SourceResult[] = enrichedResults.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
  }));

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      let accumulated = "";
      let tokenCount = 0;

      try {
        for await (const chunk of chatCompleteStream(query, enrichedResults, streamMode)) {
          if (chunk.type === "token") {
            accumulated += chunk.text;
            tokenCount++;
            // Re-render every 3 tokens to avoid flickering while staying responsive
            if (tokenCount % 3 === 0) {
              const html = renderMarkdownSafe(stripInvalidCitations(accumulated, sliced.length));
              const decorated = decorateCitations(html, sources);
              send("tokens", { html: decorated });
            }
          } else if (chunk.type === "done") {
            const parsed = parseAiSummary(chunk.full, sliced.length);
            const cleanMd = stripInvalidCitations(parsed.markdown, sliced.length);
            const finalHtml = decorateCitations(renderMarkdownSafe(cleanMd), sources);

            if (streamMode === "compact") {
              send("done", { html: finalHtml, references: "", followups: "", followupQuestions: [] });
            } else {
              const referencesHtml = buildReferences(sources, parsed.citedIndices);
              const followupsHtml = buildFollowups(parsed.followups, query);
              send("done", {
                html: finalHtml,
                references: referencesHtml,
                followups: followupsHtml,
                followupQuestions: parsed.followups,
              });
            }
          }
        }
      } catch (err) {
        logger.warn(AI_SUMMARY_ID, "Stream error", err);
        send("error", { message: "Stream failed" });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

export default router;
