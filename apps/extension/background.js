chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'readerkb-save-link',
    title: 'Save Link to ReaderKB',
    contexts: ['link'],
  });
  chrome.contextMenus.create({
    id: 'readerkb-save-selection',
    title: 'Save Selection to ReaderKB',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const stored = await chrome.storage.local.get(['instanceUrl', 'accessToken']);
  const instanceUrl = (stored.instanceUrl || 'http://localhost:3000').replace(/\/$/, '');
  const accessToken = stored.accessToken;
  if (!accessToken) return;

  const targetUrl = info.linkUrl || (tab && tab.url) || '';
  if (!targetUrl) return;

  await fetch(`${instanceUrl}/api/items/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      url: targetUrl,
      title: tab && tab.title ? tab.title : undefined,
      selection: info.selectionText || undefined,
    }),
  });
});
