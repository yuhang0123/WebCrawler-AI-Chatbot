const API_URL = "http://127.0.0.1:8000/inquiry";

const pageTitleEl = document.getElementById("pageTitle");
const pageUrlEl = document.getElementById("pageUrl");
const statusEl = document.getElementById("status");
const fullPageBox = document.getElementById("isFullPage");
const logEl = document.getElementById("log");
const form = document.getElementById("chatForm");
const questionEl = document.getElementById("question");
const sendButton = document.getElementById("sendButton");

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
}

function addMsg(role, text, isError) {
  const el = document.createElement("div");
  el.className = "msg " + role + (isError ? " error" : "");
  el.textContent = text;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

async function refreshPageInfo() {
  const tab = await getActiveTab();
  pageTitleEl.textContent = (tab && tab.title) || "(no page)";
  pageUrlEl.textContent = (tab && tab.url) || "";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = questionEl.value.trim();
  if (!question) return;
  questionEl.value = "";
  addMsg("user", question);
  sendButton.disabled = true;

  // Re-read the page on every question so answers follow the current tab.
  setStatus("Reading page…");
  const page = await readActivePage({ preferMain: !fullPageBox.checked });
  if (!page.ok) {
    setStatus("");
    addMsg("bot", page.error, true);
    sendButton.disabled = false;
    return;
  }

  setStatus("Thinking…");
  const bubble = addMsg("bot", "…");
  try {
    const resp = await fetch(API_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, page_content: page.text, url: page.url }),
    });
    if (!resp.ok) throw new Error("Server returned " + resp.status);
    const data = await resp.json();
    bubble.textContent =
      typeof data === "string" ? data : data.answer ?? data.response ?? JSON.stringify(data);
  } catch (err) {
    bubble.textContent = "Error: " + err.message;
    bubble.classList.add("error");
  } finally {
    setStatus(page.truncated ? "Page was truncated to fit." : "");
    sendButton.disabled = false;
    questionEl.focus();
  }
});

chrome.tabs.onActivated.addListener(refreshPageInfo);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.status === "complete" || changeInfo.url)) refreshPageInfo();
});

refreshPageInfo();
addMsg("bot", "Hi! Ask me anything about the page you're viewing.");
