(function () {
  /** @type {{ role: string; content: string }[]} */
  let history = [];

  function getQuery() {
    const params = new URLSearchParams(window.location.search);
    return params.get("q") || "";
  }

  function buildResultsContext() {
    const items = document.querySelectorAll("#results-list .result-item");
    const out = [];
    let i = 0;
    for (const el of items) {
      if (i >= 6) break;
      const title =
        el.querySelector(".result-title")?.textContent?.trim() || "";
      const snippet =
        el.querySelector(".result-snippet")?.textContent?.trim() || "";
      if (title || snippet) {
        i++;
        out.push("[" + i + "] " + title + "\n" + snippet);
      }
    }
    return out.join("\n\n");
  }

  const _renderMarkdown = (md) => {
    const esc = (s) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    let html = esc(md);
    html = html.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_, lang, code) => "<pre><code>" + code.trimEnd() + "</code></pre>",
    );
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/^(\s*)[*-] (.+)$/gm, "$1<li>$2</li>");
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");
    html = html.replace(/^(\d+)\. (.+)$/gm, "<li>$2</li>");
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, (m) =>
      m.startsWith("<ul>") ? m : "<ol>" + m + "</ol>",
    );
    html = html.replace(/\n{2,}/g, "</p><p>");
    html = "<p>" + html + "</p>";
    html = html.replace(/<p>\s*(<pre>|<ul>|<ol>)/g, "$1");
    html = html.replace(/(<\/pre>|<\/ul>|<\/ol>)\s*<\/p>/g, "$1");
    html = html.replace(/<p>\s*<\/p>/g, "");
    return html;
  };

  function autoResize(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  }

  let activeCitation = null;
  let activePopover = null;
  let touchOpenedCitation = null;

  function hideCitationPopover() {
    if (activePopover) activePopover.remove();
    activePopover = null;
    activeCitation = null;
    touchOpenedCitation = null;
  }

  function positionCitationPopover(cite, popover) {
    const rect = cite.getBoundingClientRect();
    popover.style.maxWidth = Math.min(320, window.innerWidth - 16) + "px";
    const popRect = popover.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - popRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8));
    let top = rect.top - popRect.height - 8;
    if (top < 8) top = rect.bottom + 8;
    popover.style.left = left + "px";
    popover.style.top = Math.max(8, top) + "px";
  }

  function showCitationPopover(cite) {
    const tooltip = cite.querySelector(".ai-cite-tooltip");
    if (!tooltip) return;
    hideCitationPopover();
    const popover = document.createElement("div");
    popover.className = "ai-cite-popover";
    popover.innerHTML = tooltip.innerHTML;
    document.body.appendChild(popover);
    activeCitation = cite;
    activePopover = popover;
    positionCitationPopover(cite, popover);
  }

  function setupCitationPopovers(container) {
    const isTouchUi = () =>
      window.matchMedia("(hover: none)").matches || navigator.maxTouchPoints > 0;
    container.querySelectorAll(".ai-cite").forEach((cite) => {
      if (cite.dataset.popoverBound) return;
      cite.dataset.popoverBound = "1";
      cite.addEventListener("pointerenter", () => showCitationPopover(cite));
      cite.addEventListener("pointerleave", hideCitationPopover);
      cite.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "touch" || activeCitation === cite) return;
        e.preventDefault();
        showCitationPopover(cite);
        touchOpenedCitation = cite;
      });
      cite.addEventListener(
        "touchstart",
        (e) => {
          if (activeCitation === cite) return;
          e.preventDefault();
          showCitationPopover(cite);
          touchOpenedCitation = cite;
        },
        { passive: false },
      );
      cite.addEventListener("focusin", () => showCitationPopover(cite));
      cite.addEventListener("focusout", hideCitationPopover);
      cite.addEventListener("click", (e) => {
        if (!isTouchUi()) return;
        if (touchOpenedCitation === cite) {
          touchOpenedCitation = null;
          e.preventDefault();
          return;
        }
        if (activeCitation === cite) {
          hideCitationPopover();
          return;
        }
        e.preventDefault();
        showCitationPopover(cite);
      });
    });
  }

  /** Wire up copy buttons */
  function setupCopyButtons(container) {
    container.querySelectorAll(".ai-code-copy").forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", function () {
        const codeEl = btn.closest(".ai-code-block")?.querySelector("code");
        if (!codeEl) return;
        navigator.clipboard.writeText(codeEl.textContent || "").then(() => {
          btn.textContent = "Copied!";
          btn.classList.add("copied");
          setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("copied");
          }, 2000);
        });
      });
    });
  }

  /** Start streaming from /api/ai-summary/stream and progressively render */
  async function startStream(box) {
    const query = box.dataset.streamQuery;
    const resultsJson = box.dataset.streamResults;
    const mode = box.dataset.streamMode || "full";
    if (!query || !resultsJson) return;

    const answerEl = box.querySelector(".glance-ai-answer");
    if (!answerEl) return;

    let results;
    try {
      results = JSON.parse(resultsJson);
    } catch {
      answerEl.innerHTML = "<p>" + t("ai-summary.request-failed") + "</p>";
      delete box.dataset.streamQuery;
      delete box.dataset.streamResults;
      delete box.dataset.streamMode;
      return;
    }

    // Hard timeout: if no content after 20s, show error
    const STREAM_TIMEOUT_MS = 20000;
    let gotContent = false;
    const timeoutId = setTimeout(function () {
      if (!gotContent) {
        answerEl.innerHTML = "<p>" + t("ai-summary.request-failed") + "</p>";
        delete box.dataset.streamQuery;
        delete box.dataset.streamResults;
        delete box.dataset.streamMode;
      }
    }, STREAM_TIMEOUT_MS);

    /** Handle a single parsed SSE event */
    function handleEvent(eventType, parsed) {
      if (eventType === "tokens") {
        gotContent = true;
        let streamHtml = parsed.html;
        // Strip partial followups code block during streaming
        const fIdx = streamHtml.indexOf('<code class="language-followups"');
        if (fIdx !== -1) {
          const blockStart = streamHtml.lastIndexOf('<div class="ai-code-block">', fIdx);
          if (blockStart !== -1) streamHtml = streamHtml.slice(0, blockStart);
        }
        answerEl.innerHTML = streamHtml;
        setupCitationPopovers(answerEl);
      } else if (eventType === "done") {
        gotContent = true;
        clearTimeout(timeoutId);
        answerEl.innerHTML = parsed.html;
        setupCopyButtons(answerEl);
        setupCitationPopovers(answerEl);

        if (mode === "full" && parsed.references) {
          const showBtn = document.createElement("button");
          showBtn.className = "ai-show-more";
          showBtn.type = "button";
          showBtn.textContent = "Show More \u2228";
          answerEl.after(showBtn);

          const extraDiv = document.createElement("div");
          extraDiv.className = "glance-ai-extra";
          extraDiv.hidden = true;
          extraDiv.innerHTML =
            (parsed.references || "") +
            '<div class="glance-ai-followups-slot"></div>' +
            '<div class="glance-ai-chat">' +
            '<textarea class="glance-ai-input degoog-input degoog-input--chat" placeholder="' + t("ai-summary.follow-up-placeholder") + '" rows="1"></textarea>' +
            "</div>";
          showBtn.after(extraDiv);

          showBtn.addEventListener("click", function () {
            if (extraDiv.hidden) {
              extraDiv.hidden = false;
              showBtn.textContent = "Show Less \u2227";
            } else {
              extraDiv.hidden = true;
              showBtn.textContent = "Show More \u2228";
            }
          });

          setupChat(box, extraDiv);
        }

        delete box.dataset.streamQuery;
        delete box.dataset.streamResults;
        delete box.dataset.streamMode;
      } else if (eventType === "followups") {
        const slot = box.querySelector(".glance-ai-followups-slot");
        if (slot && parsed.followups) {
          slot.innerHTML = parsed.followups;
        }
      } else if (eventType === "error") {
        clearTimeout(timeoutId);
        answerEl.innerHTML = "<p>" + t("ai-summary.request-failed") + "</p>";
      }
    }

    /** Parse SSE text into event objects */
    function parseSSE(text) {
      const eventBlocks = text.split("\n\n");
      for (const block of eventBlocks) {
        if (!block.trim()) continue;
        const lines = block.split("\n");
        let eventType = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) eventType = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (eventType && data) {
          try { handleEvent(eventType, JSON.parse(data)); } catch {}
        }
      }
    }

    try {
      const res = await fetch("/api/ai-summary/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, results, mode }),
      });

      if (!res.ok) {
        clearTimeout(timeoutId);
        answerEl.innerHTML = "<p>" + t("ai-summary.request-failed") + "</p>";
        return;
      }

      // Try streaming with ReadableStream (progressive rendering)
      if (res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";
          for (const block of events) {
            if (!block.trim()) continue;
            const lines = block.split("\n");
            let eventType = "";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7);
              else if (line.startsWith("data: ")) data = line.slice(6);
            }
            if (eventType && data) {
              try { handleEvent(eventType, JSON.parse(data)); } catch {}
            }
          }
        }
        // Process any remaining buffer
        if (buffer.trim()) parseSSE(buffer);
        return;
      }

      // Fallback: read entire response as text (iOS Safari compatibility)
      const text = await res.text();
      parseSSE(text);
    } catch {
      clearTimeout(timeoutId);
      answerEl.innerHTML = "<p>" + t("ai-summary.request-failed") + "</p>";
    }
  }

  /** Set up the follow-up chat functionality */
  function setupChat(box, container) {
    const input = container.querySelector(".glance-ai-input");
    if (!input) return;

    const answerEl = box.querySelector(".glance-ai-answer");
    const query = getQuery();
    const context = buildResultsContext();

    history = [
      {
        role: "system",
        content:
          "You are a helpful assistant. The user searched for: " +
          JSON.stringify(query) +
          ". Here are the search results for context:\n\n" +
          context +
          "\n\nYou already gave a summary. Now the user wants to dive deeper. Answer their follow-up questions conversationally and concisely.",
      },
      {
        role: "assistant",
        content: answerEl ? answerEl.textContent || "" : "",
      },
    ];

    input.addEventListener("input", function () {
      autoResize(input);
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(input, container);
      }
    });
  }

  async function sendMessage(input, container) {
    const text = input.value.trim();
    if (!text) return;

    // Create messages area if needed
    let messagesEl = container.querySelector(".glance-ai-messages");
    if (!messagesEl) {
      messagesEl = document.createElement("div");
      messagesEl.className = "glance-ai-messages";
      input.before(messagesEl);
    }

    const userDiv = document.createElement("div");
    userDiv.className = "glance-ai-reply glance-ai-user";
    userDiv.textContent = text;
    messagesEl.appendChild(userDiv);

    history.push({ role: "user", content: text });
    input.value = "";
    autoResize(input);

    const typingDiv = document.createElement("div");
    typingDiv.className = "glance-ai-typing";
    typingDiv.textContent = t("ai-summary.thinking");
    messagesEl.appendChild(typingDiv);

    try {
      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const data = await res.json();
      typingDiv.remove();

      if (data.reply) {
        history.push({ role: "assistant", content: data.reply });
        const replyDiv = document.createElement("div");
        replyDiv.className = "glance-ai-reply";
        replyDiv.innerHTML = _renderMarkdown(data.reply);
        messagesEl.appendChild(replyDiv);
      } else {
        const errDiv = document.createElement("div");
        errDiv.className = "glance-ai-typing";
        errDiv.textContent = t("ai-summary.no-response");
        messagesEl.appendChild(errDiv);
      }
    } catch {
      typingDiv.remove();
      const errDiv = document.createElement("div");
      errDiv.className = "glance-ai-typing";
      errDiv.textContent = t("ai-summary.request-failed");
      messagesEl.appendChild(errDiv);
    }

    input.focus();
  }

  function handleSetup(box) {
    // If this is a streaming placeholder, start the stream
    if (box.dataset.streamQuery) {
      startStream(box);
      return;
    }

    // Cached full response — wire up interactions
    setupCopyButtons(box);
    setupCitationPopovers(box);

    // Wire up "Show more" button if present
    const showBtn = box.querySelector(".ai-show-more");
    const extraDiv = box.querySelector(".glance-ai-extra");
    if (showBtn && extraDiv) {
      showBtn.addEventListener("click", function () {
        if (extraDiv.hidden) {
          extraDiv.hidden = false;
          showBtn.textContent = "Show Less \u2227";
        } else {
          extraDiv.hidden = true;
          showBtn.textContent = "Show More \u2228";
        }
      });
      setupChat(box, extraDiv);
    }
  }

  /** Watch for .glance-ai elements appearing in the DOM (works with SPA navigation) */
  function watchForGlanceAi() {
    const observer = new MutationObserver(function () {
      const glanceEl = document.getElementById("at-a-glance");
      if (!glanceEl) return;
      const box = glanceEl.querySelector(".glance-ai");
      if (box && !box.dataset.chatInit) {
        box.dataset.chatInit = "1";
        handleSetup(box);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Also check immediately in case element already exists
    const glanceEl = document.getElementById("at-a-glance");
    if (glanceEl) {
      const existing = glanceEl.querySelector(".glance-ai");
      if (existing && !existing.dataset.chatInit) {
        existing.dataset.chatInit = "1";
        handleSetup(existing);
      }
    }
  }

  watchForGlanceAi();
  window.addEventListener("scroll", hideCitationPopover, true);
  window.addEventListener("resize", hideCitationPopover);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideCitationPopover();
  });
})();
