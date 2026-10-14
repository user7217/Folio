# Chromium Manifest V3 Browser Extension

## 1. Overview & Security Model

The unpacked Chromium extension lives in `apps/extension/` and uses Manifest V3:
- **Permissions**: `activeTab`, `contextMenus`, `storage`, and host permission only for the configured instance origin (`http://localhost:3000/*`).
- **No Background Tracking**: Cannot read browsing history or enumerate open tabs.
- **No Embedded Secrets**: Uses short-lived pairing codes exchanged for a revocable, capture-scoped bearer token.

## 2. Setup & Pairing Guide

1. Open Chrome/Chromium and navigate to `chrome://extensions`.
2. Enable **Developer mode** and click **Load unpacked**, selecting `/Users/harsha1/Documents/pocket_clone/apps/extension`.
3. In the web application Settings, generate a short-lived pairing code (`POST /api/extension/pair/start`).
4. Paste the `pair_...` code into the extension popup and click **Pair Extension** (`POST /api/extension/pair/exchange`).
5. Use **Save Current Tab** or right-click any link or text selection to capture directly to your library.
