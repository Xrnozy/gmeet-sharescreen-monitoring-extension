document.getElementById("start").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    chrome.tabs.sendMessage(tab.id, "GSM_START", (resp) => {
      document.getElementById("status").textContent = "Status: started";
    });
  });
});
document.getElementById("stop").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    chrome.tabs.sendMessage(tab.id, "GSM_STOP", (resp) => {
      document.getElementById("status").textContent = "Status: stopped";
    });
  });
});
// listen for incoming runtime messages (requires manifest permissions if from content)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "GSM_CHANGE") {
    const s = JSON.stringify(msg.payload, null, 2);
    document.getElementById("last").textContent = s;
    document.getElementById("status").textContent = "Status: change detected";
  }
});
