const pageTitleEl = document.getElementById("pageTitle");
const pageUrlEl = document.getElementById("pageUrl");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const readButton = document.getElementById("readButton");
const fullPageBox = document.getElementById("isFullPage");

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
}

async function refreshPageInfo() {
  const tab = await getActiveTab();
  pageTitleEl.textContent = (tab && tab.title) || "(no page)";
  pageUrlEl.textContent = (tab && tab.url) || "";
  previewEl.textContent = "";
  setStatus("");
}

async function handleRead() {
  readButton.disabled = true;
  setStatus("Reading page…");
  previewEl.textContent = "";

  const page = await readActivePage({ preferMain: !fullPageBox.checked });

  readButton.disabled = false;
  if (!page.ok) {
    setStatus(page.error, true);
    return;
  }

  const parts = [
    page.text.length.toLocaleString() + " characters read",
    page.usedMain ? "main content only" : "whole page",
  ];
  if (page.truncated) parts.push("truncated from " + page.totalChars.toLocaleString());
  if (page.frameCount > 1) parts.push(page.frameCount + " frames");
  if (page.selection) parts.push("text is selected on the page");
  setStatus(parts.join(" · "));
  previewEl.textContent = page.text;
}

readButton.addEventListener("click", handleRead);

// Keep the header in sync when the user switches tabs or navigates.
chrome.tabs.onActivated.addListener(refreshPageInfo);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.status === "complete" || changeInfo.url)) {
    refreshPageInfo();
  }
});

refreshPageInfo();
