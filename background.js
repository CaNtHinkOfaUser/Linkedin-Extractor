// LinkedIn Profile Extractor — background service worker
// Saves the last extraction (written to chrome.storage.local by content.js)
// as a .txt file when the popup's Download button sends { action: "download" }.

async function download() {
  const { lastExtract } = await chrome.storage.local.get("lastExtract");
  if (!lastExtract || !lastExtract.txt) throw new Error("Nothing extracted yet.");
  // Service workers have no URL.createObjectURL, so hand the file over as a data: URL.
  const url = `data:text/plain;charset=utf-8,${encodeURIComponent(lastExtract.txt)}`;
  return chrome.downloads.download({
    url,
    filename: `${lastExtract.fileBase || "linkedin-profile"}.txt`,
    conflictAction: "uniquify",
    saveAs: false,
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== "download") return;
  download().then(
    id => sendResponse({ success: true, id }),
    err => sendResponse({ success: false, error: err.message }),
  );
  return true;
});
