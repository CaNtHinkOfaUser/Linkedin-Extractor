// LinkedIn Profile Extractor — background service worker
// Saves the last extraction (written to chrome.storage.local by content.js)
// to disk. Both the content script (auto-download when an extract finishes)
// and the popup's download buttons send { action: "download", format }.

const FORMATS = {
  txt:  { mime: "text/plain", ext: "txt" },
  json: { mime: "application/json", ext: "json" },
};

async function download(format) {
  const f = FORMATS[format] ? format : "txt";
  const { lastExtract } = await chrome.storage.local.get("lastExtract");
  if (!lastExtract || !lastExtract[f]) throw new Error("Nothing extracted yet.");
  // Service workers have no URL.createObjectURL, so hand the file over as a data: URL.
  const url = `data:${FORMATS[f].mime};charset=utf-8,${encodeURIComponent(lastExtract[f])}`;
  return chrome.downloads.download({
    url,
    filename: `${lastExtract.fileBase || "linkedin-profile"}.${FORMATS[f].ext}`,
    conflictAction: "uniquify",
    saveAs: false,
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== "download") return;
  download(msg.format).then(
    id => sendResponse({ success: true, id }),
    err => sendResponse({ success: false, error: err.message }),
  );
  return true;
});
