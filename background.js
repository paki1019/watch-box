chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "app.html" });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // 정보 팝업에 보여 줄 설치·업데이트 시각 (크롬 자체 업데이트는 제외)
  if (reason === "install" || reason === "update") await chrome.storage.local.set({ installedAt: Date.now() });
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "import",
    title: "Watch Box에 추가",
    contexts: ["selection"],
    documentUrlPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  });
});

// 선택 텍스트를 임시 보관하고 관리 페이지를 열면, 페이지가 읽어 가져오기 창을 띄운다
chrome.contextMenus.onClicked.addListener(async (info) => {
  await chrome.storage.session.set({ pendingImport: info.selectionText });
  chrome.tabs.create({ url: "app.html" });
});
