import { generateTOTP } from '../lib/totp.js';
import { matchAccountDomain, normalizeDomain } from '../lib/domain.js';

// Setup Context Menu on Install/Update
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'autoauth-autofill',
      title: '⚡ AutoAuth: Autofill OTP',
      contexts: ['page', 'editable']
    });
  });
});

/**
 * Extracts normalized hostname from URL (e.g., "github.com" from "https://sub.github.com/login")
 */
function extractDomain(url) {
  try {
    const parsed = new URL(url);
    return normalizeDomain(parsed.hostname);
  } catch (e) {
    return '';
  }
}

/**
 * Ensure content script is injected into tab before sending messages
 */
async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'PING' });
  } catch (err) {
    // If ping fails, inject content script and css dynamically
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/content.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
  }
}

// Handle Context Menu Clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'autoauth-autofill') return;
  if (!tab || !tab.id || !tab.url || tab.url.startsWith('chrome://')) return;

  const pageDomain = extractDomain(tab.url);

  // Retrieve session state
  const session = await chrome.storage.session.get(['unlocked', 'accounts', 'lastActive', 'autoLockMinutes']);
  
  if (!session.unlocked || !session.accounts) {
    await ensureContentScriptInjected(tab.id);
    chrome.tabs.sendMessage(tab.id, {
      action: 'SHOW_NOTIF',
      status: 'warn',
      message: 'AutoAuth is locked. Click the extension icon to unlock.'
    });
    return;
  }

  // Check timeout
  const lockMinutes = session.autoLockMinutes || 15;
  if (session.lastActive && (Date.now() - session.lastActive > lockMinutes * 60 * 1000)) {
    await chrome.storage.session.clear();
    await ensureContentScriptInjected(tab.id);
    chrome.tabs.sendMessage(tab.id, {
      action: 'SHOW_NOTIF',
      status: 'warn',
      message: 'Session expired. Open extension to unlock.'
    });
    return;
  }

  // Update last active
  await chrome.storage.session.set({ lastActive: Date.now() });

  // Find matching account
  const accounts = session.accounts;
  let matchedAccount = accounts.find(acc => matchAccountDomain(acc, pageDomain));

  // If no exact match and there is only 1 account, or fallback to first match
  if (!matchedAccount && accounts.length === 1) {
    matchedAccount = accounts[0];
  }

  if (!matchedAccount) {
    await ensureContentScriptInjected(tab.id);
    chrome.tabs.sendMessage(tab.id, {
      action: 'SHOW_NOTIF',
      status: 'warn',
      message: `No 2FA account found matching ${pageDomain || 'this page'}.`
    });
    return;
  }

  try {
    const otp = await generateTOTP(matchedAccount.secret, {
      period: matchedAccount.period || 30,
      digits: matchedAccount.digits || 6,
      algorithm: matchedAccount.algorithm || 'SHA1'
    });

    await ensureContentScriptInjected(tab.id);
    chrome.tabs.sendMessage(tab.id, {
      action: 'AUTOFILL_OTP',
      code: otp,
      issuer: matchedAccount.issuer || '2FA'
    });
  } catch (err) {
    console.error('Error generating TOTP:', err);
    await ensureContentScriptInjected(tab.id);
    chrome.tabs.sendMessage(tab.id, {
      action: 'SHOW_NOTIF',
      status: 'error',
      message: 'Failed to generate OTP code.'
    });
  }
});

// Message Listener for Popup communication
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'AUTOFILL_ACTIVE_TAB') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id || tab.url?.startsWith('chrome://')) {
          sendResponse({ success: false, error: 'Cannot inject into system pages' });
          return;
        }

        await ensureContentScriptInjected(tab.id);
        const res = await chrome.tabs.sendMessage(tab.id, {
          action: 'AUTOFILL_OTP',
          code: message.code,
          issuer: message.issuer
        });

        sendResponse({ success: true, result: res });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep message channel open for async response
  }

  // Automatic hands-free autofill check from content script
  if (message.action === 'CHECK_AUTOFILL_MATCH') {
    (async () => {
      try {
        const localSettings = await chrome.storage.local.get(['autoFillOnPageLoad']);
        if (!localSettings.autoFillOnPageLoad) {
          sendResponse({ shouldFill: false, reason: 'disabled' });
          return;
        }

        const session = await chrome.storage.session.get(['unlocked', 'accounts', 'lastActive', 'autoLockMinutes']);
        if (!session.unlocked || !session.accounts) {
          sendResponse({ shouldFill: false, reason: 'locked' });
          return;
        }

        const lockMinutes = session.autoLockMinutes || 15;
        if (session.lastActive && lockMinutes > 0 && (Date.now() - session.lastActive > lockMinutes * 60 * 1000)) {
          await chrome.storage.session.clear();
          sendResponse({ shouldFill: false, reason: 'session_expired' });
          return;
        }

        // Update lastActive
        await chrome.storage.session.set({ lastActive: Date.now() });

        const pageDomain = (message.domain || '').toLowerCase();
        const matched = session.accounts.find(acc => matchAccountDomain(acc, pageDomain));

        if (!matched) {
          sendResponse({ shouldFill: false, reason: 'no_match' });
          return;
        }

        const otp = await generateTOTP(matched.secret, {
          period: matched.period || 30,
          digits: matched.digits || 6,
          algorithm: matched.algorithm || 'SHA1'
        });

        sendResponse({
          shouldFill: true,
          code: otp,
          issuer: matched.issuer || '2FA'
        });
      } catch (err) {
        sendResponse({ shouldFill: false, error: err.message });
      }
    })();
    return true;
  }
});
