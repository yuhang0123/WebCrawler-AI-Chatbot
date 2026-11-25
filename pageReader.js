// extractPageContent() is injected INTO the webpage by chrome.scripting.executeScript,
// so it must be fully self-contained (it cannot use anything defined outside it).

function extractPageContent(options) {
  const maxChars = options.maxChars;
  const preferMain = options.preferMain;

  // tag names to be excluded from extraction
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME",
    "OBJECT", "EMBED", "AUDIO", "VIDEO", "HEAD", "LINK", "META",
  ]);
  // tag names to be extracted (will add newline around block elements)
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL",
    "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2",
    "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P",
    "PRE", "SECTION", "SUMMARY", "TABLE", "TR", "UL", "TEXTAREA",
  ]);

  function isHidden(el) {
    try {
      if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
      if (typeof el.checkVisibility === "function") {
        return !el.checkVisibility({ checkVisibilityCSS: true });
      }
      const style = getComputedStyle(el);
      return style.display === "none" || style.visibility === "hidden";
    } catch (e) {
      return false;
    }
  }

  // recursively traverse webpage's DOM tree and collect text
  function walk(node, out) {

    // base case: found a text node
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue);
      return;
    }

    // identify if current node is HTML element or document fragment
    const isElement = node.nodeType === Node.ELEMENT_NODE;
    const isFragment = node.nodeType === Node.DOCUMENT_FRAGMENT_NODE; // shadow root
    if (!isElement && !isFragment) return;

    
    if (isElement) {
      // check if is skip tag
      const tag = node.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag) || isHidden(node)) return;

      // processor for each acceptable tags
      if (tag === "BR") {
        out.push("\n");
        return;
      }
      if (tag === "IMG") {
        const alt = node.getAttribute("alt");
        if (alt) out.push(" " + alt + " ");
        return;
      }
      if (tag === "INPUT") {
        const type = (node.getAttribute("type") || "text").toLowerCase();
        if (type !== "password" && node.value) out.push(" " + node.value + " ");
        return;
      }
      if (tag === "TEXTAREA") {
        if (node.value) out.push("\n" + node.value + "\n");
        return;
      }
      if (tag === "SLOT") {
        const assigned = node.assignedNodes({ flatten: true });
        const nodes = assigned.length ? assigned : Array.from(node.childNodes);
        nodes.forEach((child) => walk(child, out));
        return;
      }

      const block = BLOCK_TAGS.has(tag);
      if (block) out.push("\n");

      // Shadow DOM: render the shadow tree (its <slot>s pull in the light DOM children).
      if (node.shadowRoot) {
        walk(node.shadowRoot, out);
      } else {
        node.childNodes.forEach((child) => walk(child, out));
      }

      if (tag === "TD" || tag === "TH") out.push(" | ");
      if (block) out.push("\n");
      return;
    }

    node.childNodes.forEach((child) => walk(child, out));
  }

  function cleanText(raw) {
    return raw
      .replace(/\u00a0/g, " ") // non-breaking spaces
      .replace(/[ \t\f\v]+/g, " ") // excessive whitespaces
      .replace(/ \| \n/g, "\n")
      .replace(/ *\n */g, "\n") // spaces around new lines
      .replace(/\n{3,}/g, "\n\n") // excessive newlines
      .trim();
  }

  function collect(root) {
    const out = [];
    walk(root, out);
    return cleanText(out.join(""));
  }

  // Prefer the page's main content (skips menus/footers); fall back to the whole body.
  let text = "";
  let usedMain = false;
  if (preferMain) {
    let mainEl = document.querySelector('main, [role="main"]'); // search for <main> or <div role="main">
    if (!mainEl) {
      const articles = document.querySelectorAll("article"); // fallback to <article> when there is no main element and have exactly one article tag
      if (articles.length === 1) mainEl = articles[0];
    }
    if (mainEl) {
      const mainText = collect(mainEl);
      if (mainText.length >= 500) {
        text = mainText;
        usedMain = true;
      }
    }
  }
  if (!usedMain) {
    text = collect(document.body || document.documentElement);
  }

  const totalChars = text.length;
  const truncated = totalChars > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  return {
    title: document.title || "",
    url: location.href,
    lang: document.documentElement.lang || "",
    isTopFrame: window === window.top,
    selection: String(window.getSelection ? window.getSelection() : "").trim(),
    usedMain: usedMain,
    totalChars: totalChars,
    truncated: truncated,
    text: text,
  };
}

// ---- Helpers that run inside the extension (side panel), not in the webpage ----

const RESTRICTED_URL =
  /^(chrome|chrome-extension|chrome-search|chrome-untrusted|edge|about|devtools|view-source):/i;
const RESTRICTED_STORES = [
  "https://chromewebstore.google.com",
  "https://chrome.google.com/webstore",
  "https://microsoftedge.microsoft.com/addons",
];

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function explainUnreadable(url) {
  if (!url) return "This page can't be read (no URL available).";
  if (RESTRICTED_URL.test(url) || RESTRICTED_STORES.some((s) => url.startsWith(s))) {
    return "Browsers don't allow extensions to read this kind of page (browser settings or extension store pages).";
  }
  if (/\.pdf($|[?#])/i.test(url)) {
    return "PDF files open in the browser's built-in viewer, which extensions can't read directly. PDF support needs a separate step.";
  }
  return null;
}

/**
 * Reads the active tab. Returns:
 *   { ok: true, title, url, lang, text, selection, truncated, totalChars, usedMain, frameCount }
 *   { ok: false, error: "human-readable reason" }
 */
async function readActivePage(opts) {
  const options = Object.assign({ maxChars: 30000, preferMain: true }, opts || {});

  const tab = await getActiveTab();
  if (!tab || tab.id === undefined) {
    return { ok: false, error: "No active tab found." };
  }
  const blocked = explainUnreadable(tab.url);
  if (blocked) return { ok: false, error: blocked };

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractPageContent,
      args: [options],
    });
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/file/i.test(msg) && tab.url.startsWith("file:")) {
      return {
        ok: false,
        error: "To read local files, turn on 'Allow access to file URLs' for this extension in chrome://extensions.",
      };
    }
    return { ok: false, error: "Could not read this page: " + msg };
  }

  const frames = (results || []).filter((r) => r && r.result);
  const top = frames.find((r) => r.frameId === 0) || frames[0];
  if (!top) return { ok: false, error: "The page returned no readable content." };

  // Combine the main frame with any embedded frames that have meaningful text.
  let text = top.result.text;
  let selection = top.result.selection;
  let frameCount = 1;
  for (const frame of frames) {
    if (frame === top) continue;
    if (!selection && frame.result.selection) selection = frame.result.selection;
    if (frame.result.text.length >= 200) {
      text += "\n\n[Embedded frame: " + frame.result.url + "]\n" + frame.result.text;
      frameCount++;
    }
  }
  let truncated = top.result.truncated;
  if (text.length > options.maxChars) {
    text = text.slice(0, options.maxChars);
    truncated = true;
  }

  if (text.trim().length === 0) {
    return {
      ok: false,
      error: "No readable text was found on this page. It may still be loading, or it may be mostly images/canvas.",
    };
  }

  return {
    ok: true,
    title: top.result.title || tab.title || "",
    url: top.result.url || tab.url,
    lang: top.result.lang,
    text: text,
    selection: selection,
    truncated: truncated,
    totalChars: top.result.totalChars,
    usedMain: top.result.usedMain,
    frameCount: frameCount,
  };
}
