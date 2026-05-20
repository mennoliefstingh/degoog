import { describe, test, expect } from "bun:test";
import {
  parseAiSummary,
  stripInvalidCitations,
} from "../parse-summary";
import {
  buildFollowups,
  buildReferences,
  decorateCitations,
  renderMarkdownSafe,
  type SourceResult,
} from "../render-summary";

const results: SourceResult[] = [
  {
    title: "First source",
    url: "https://example.com/first",
    snippet: "First snippet",
  },
  {
    title: "Second source",
    url: "https://docs.example.com/second",
    snippet: "Second snippet",
  },
  {
    title: "Third source",
    url: "https://third.example.com/article",
    snippet: "Third snippet",
  },
];

describe("parse-summary", () => {
  test("extracts a valid followups JSON block", () => {
    const raw = `Answer body.\n\n\`\`\`followups\n["One?", "Two?"]\n\`\`\``;
    const parsed = parseAiSummary(raw, 3);

    expect(parsed.markdown).toBe("Answer body.");
    expect(parsed.followups).toEqual(["One?", "Two?"]);
  });

  test("returns empty followups when block is missing", () => {
    const parsed = parseAiSummary("Answer body only.", 3);

    expect(parsed.followups).toEqual([]);
  });

  test("returns empty followups for malformed JSON", () => {
    const raw = `Answer body.\n\n\`\`\`followups\n{"bad": true\n\`\`\``;
    const parsed = parseAiSummary(raw, 3);

    expect(parsed.markdown).toBe("Answer body.");
    expect(parsed.followups).toEqual([]);
  });

  test("identifies valid citations and deduplicates duplicates", () => {
    const parsed = parseAiSummary("Uses [1], [2], [3], and [2] again.", 3);

    expect(parsed.citedIndices).toEqual([1, 2, 3]);
  });

  test("does not count citations inside fenced code blocks", () => {
    const raw = [
      "Outside [1]",
      "",
      "```ts",
      "const example = '[2]';",
      "```",
      "",
      "Still outside [3]",
    ].join("\n");

    const parsed = parseAiSummary(raw, 3);

    expect(parsed.citedIndices).toEqual([1, 3]);
  });

  test("ignores out-of-range citations", () => {
    const parsed = parseAiSummary("Valid [1], invalid [99], valid [3].", 3);

    expect(parsed.citedIndices).toEqual([1, 3]);
  });

  test("stripInvalidCitations removes out-of-range citations", () => {
    const cleaned = stripInvalidCitations("Keep [1], drop [99], keep [3].", 3);

    expect(cleaned).toBe("Keep [1], drop , keep [3].");
  });

  test("stripInvalidCitations preserves citations inside fenced code blocks", () => {
    const markdown = [
      "Keep [1]",
      "",
      "```",
      "const example = '[99]';",
      "```",
      "",
      "Drop [42]",
    ].join("\n");

    const cleaned = stripInvalidCitations(markdown, 3);

    expect(cleaned).toContain("const example = '[99]';");
    expect(cleaned).toContain("Keep [1]");
    expect(cleaned).not.toContain("Drop [42]");
  });
});

describe("render-summary", () => {
  test("strips script tags", () => {
    const html = renderMarkdownSafe("<script>alert(1)</script><p>safe</p>");

    expect(html).not.toContain("<script");
    expect(html).toContain("<p>safe</p>");
  });

  test("strips event handler attributes", () => {
    const html = renderMarkdownSafe(
      '<a href="https://example.com" onclick="alert(1)">safe</a>',
    );

    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("onclick");
  });

  test("strips data URIs from links", () => {
    const html = renderMarkdownSafe("[click](data:text/html;base64,PHNjcmlwdD4=)");

    expect(html).toContain("click");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain('href="data:');
  });

  test("renders markdown formatting safely", () => {
    const html = renderMarkdownSafe([
      "**bold** and *italic* and `code`",
      "",
      "- one",
      "- two",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n"));

    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<pre><code");
    expect(html).toContain("const x = 1;");
  });

  test("decorateCitations replaces citations with tooltip markup", () => {
    const html = decorateCitations("<p>Answer [1]</p>", results);

    expect(html).toContain('<sup class="ai-cite" data-cite="1">');
    expect(html).toContain('href="https://example.com/first"');
    expect(html).toContain("example.com");
    expect(html).toContain("First source");
    expect(html).toContain("First snippet");
  });

  test("decorateCitations leaves citations inside pre and code blocks untouched", () => {
    const html = decorateCitations(
      "<p>Outside [1]</p><pre><code>Inside pre [1]</code></pre><code>Inline code [1]</code>",
      results,
    );

    expect(html.match(/class="ai-cite"/g)?.length ?? 0).toBe(1);
    expect(html).toContain("<pre><code>Inside pre [1]</code></pre>");
    expect(html).toContain("<code>Inline code [1]</code>");
  });

  test("buildReferences only includes cited sources", () => {
    const html = buildReferences(results, [2]);

    expect(html).toContain("Second source");
    expect(html).not.toContain("First source");
    expect(html).not.toContain("Third source");
  });

  test("buildReferences shows citation percentages", () => {
    const html = buildReferences(results, [1, 2, 1]);

    expect(html).toContain("First source");
    expect(html).toContain("Second source");
    expect(html).toContain(">67%</span>");
    expect(html).toContain(">33%</span>");
  });

  test("buildFollowups creates encoded search links", () => {
    const html = buildFollowups(["What next?", "A & B"], "ignored query");

    expect(html).toContain('href="/search?q=What%20next%3F"');
    expect(html).toContain('href="/search?q=A%20%26%20B"');
    expect(html).toContain("What next?");
    expect(html).toContain("A &amp; B");
  });

  test("buildFollowups returns empty HTML for no followups", () => {
    expect(buildFollowups([], "query")).toBe("");
  });
});
