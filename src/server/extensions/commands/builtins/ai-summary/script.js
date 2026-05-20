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
      return;
    }

    try {
      const res = await fetch("/api/ai-summary/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, results, mode }),
      });

      if (!res.ok || !res.body) {
        answerEl.innerHTML = "<p>" + t("ai-summary.request-failed") + "</p>";
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const eventBlock of events) {
          const lines = eventBlock.split("\n");
          let eventType = "";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (!eventType || !data) continue;

          try {
            const parsed = JSON.parse(data);
            if (eventType === "tokens") {
              answerEl.innerHTML = parsed.html;
            } else if (eventType === "done") {
              answerEl.innerHTML = parsed.html;
              setupCopyButtons(answerEl);

              // In full mode, inject references/followups/chat as expandable section
              if (mode === "full" && (parsed.references || parsed.followups)) {
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
                  (parsed.followups || "") +
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

                // Set up chat in the extra section
                setupChat(box, extraDiv);
              }

              delete box.dataset.streamQuery;
              delete box.dataset.streamResults;
              delete box.dataset.streamMode;
            } else if (eventType === "error") {
              answerEl.innerHTML =
                "<p>" + t("ai-summary.request-failed") + "</p>";
            }
          } catch {
            // skip malformed event data
          }
        }
      }
    } catch {
      answerEl.innerHTML = "<p>" + t("ai-summary.request-failed") + "</p>";
    }
  }

  /** Set up the follow-up chat functionality */
  function setupChat(box, container) {
    const input = container.querySelector(".glance-ai-input");
    const messagesEl = box.querySelector(".glance-ai-messages") || container;
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
})();
