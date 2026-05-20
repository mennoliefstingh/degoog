import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  setSettings,
  removeSettings,
} from "../../src/server/utils/plugin-settings";
import { createCache } from "../../src/server/utils/cache";
import {
  AI_SUMMARY_ID,
  getAISummarySettings,
} from "../../src/server/extensions/commands/builtins/ai-summary/index";
import {
  getSlotPluginById,
  initSlotPlugins,
} from "../../src/server/extensions/slots/registry";

describe("ai-summary questionMarkOnly setting", () => {
  const origFetch = globalThis.fetch;

  beforeAll(async () => {
    globalThis.fetch = async () => new Response("", { status: 404 });

    const orig = process.env.DEGOOG_PLUGINS_DIR;
    process.env.DEGOOG_PLUGINS_DIR = "/nonexistent-ai-test-dir";
    await initSlotPlugins();
    if (orig !== undefined) process.env.DEGOOG_PLUGINS_DIR = orig;
    else delete process.env.DEGOOG_PLUGINS_DIR;
  });

  afterAll(async () => {
    globalThis.fetch = origFetch;
    await removeSettings(AI_SUMMARY_ID);
  });

  test("getAISummarySettings returns questionMarkOnly from settings", async () => {
    await setSettings(AI_SUMMARY_ID, {
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      questionMarkOnly: true,
    });
    const settings = await getAISummarySettings();
    expect(settings.questionMarkOnly).toBe(true);
  });

  test("getAISummarySettings defaults questionMarkOnly to false", async () => {
    await removeSettings(AI_SUMMARY_ID);
    await setSettings(AI_SUMMARY_ID, {
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
    });
    const settings = await getAISummarySettings();
    expect(settings.questionMarkOnly).toBe(false);
  });

  test("trigger returns true for any query when questionMarkOnly is false", async () => {
    await setSettings(AI_SUMMARY_ID, {
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      questionMarkOnly: false,
    });
    const slot = getSlotPluginById("builtin-ai-summary-slot");
    expect(slot).not.toBeNull();
    expect(await slot!.trigger("best restaurants")).toBe(true);
    expect(await slot!.trigger("best restaurants?")).toBe(true);
  });

  test("trigger returns false for non-question when questionMarkOnly is true", async () => {
    await setSettings(AI_SUMMARY_ID, {
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      questionMarkOnly: true,
    });
    const slot = getSlotPluginById("builtin-ai-summary-slot");
    expect(slot).not.toBeNull();
    expect(await slot!.trigger("best restaurants")).toBe(false);
    expect(await slot!.trigger("  best restaurants  ")).toBe(false);
  });

  test("trigger returns true for question query when questionMarkOnly is true", async () => {
    await setSettings(AI_SUMMARY_ID, {
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      questionMarkOnly: true,
    });
    const slot = getSlotPluginById("builtin-ai-summary-slot");
    expect(slot).not.toBeNull();
    expect(await slot!.trigger("what are the best restaurants?")).toBe(true);
    expect(await slot!.trigger("why?")).toBe(true);
  });

  test("trigger returns false when baseUrl or model is not configured", async () => {
    await setSettings(AI_SUMMARY_ID, {
      baseUrl: "",
      model: "",
      questionMarkOnly: false,
    });
    const slot = getSlotPluginById("builtin-ai-summary-slot");
    expect(slot).not.toBeNull();
    expect(await slot!.trigger("test?")).toBe(false);
  });

  test("execute safely escapes streamed results JSON attribute", async () => {
    await setSettings(AI_SUMMARY_ID, {
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      questionMarkOnly: false,
    });
    const slot = getSlotPluginById("builtin-ai-summary-slot");
    expect(slot).not.toBeNull();

    const out = await slot!.execute("test", {
      createCache,
      results: [
        {
          title: '\"><img src=x onerror=alert(1)>',
          url: "https://example.com/?a=1&b=2",
          snippet: "A < B & C's quote",
          score: 1,
          source: "test",
          sources: ["test"],
        },
      ],
    });

    expect(out.html).toContain("data-stream-results=");
    expect(out.html).not.toContain("<img src=x");
    expect(out.html).toContain("&quot;&gt;&lt;img");
    expect(out.html).toContain("&amp;b=2");
    expect(out.html).toContain("C&#39;s quote");
  });
});
