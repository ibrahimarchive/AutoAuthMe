/**
 * AutoAuthMe Content Script
 * Responsible for detecting 2FA inputs, auto-pasting/filling OTP codes, and showing on-screen feedback.
 */

(() => {
if (window.__AUTOAUTHME_INJECTED__) return;
window.__AUTOAUTHME_INJECTED__ = true;

// Helper to show floating in-page toast notification
function showInPageToast({ status = 'success', title = 'AutoAuthMe', message = '', code = '' }) {
  let container = document.getElementById('autoauth-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'autoauth-toast-container';
    document.documentElement.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `autoauth-toast ${status}`;

  const iconEmoji = status === 'success' ? '✓' : status === 'warn' ? '⚠' : '✕';

  toast.innerHTML = `
    <div class="autoauth-toast-icon">${iconEmoji}</div>
    <div class="autoauth-toast-body">
      <div class="autoauth-toast-title">${title}</div>
      <div class="autoauth-toast-msg">${message} ${code ? `<span class="autoauth-toast-code">${code}</span>` : ''}</div>
    </div>
  `;

  container.appendChild(toast);

  // Trigger smooth entrance animation
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  // Auto remove after 3.2 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    toast.classList.add('hide');
    setTimeout(() => {
      toast.remove();
      if (container.children.length === 0) {
        container.remove();
      }
    }, 300);
  }, 3200);
}

/**
 * Dispatches realistic input events to convince modern UI frameworks (React, Vue, Svelte, Angular).
 */
function triggerInputEvents(element, value) {
  element.focus();

  // Call native setter to bypass React 16+ / modern frameworks value tracking
  const proto = window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(element, value);
  } else {
    element.value = value;
  }
  element.value = value;

  // Dispatch full range of synthetic input and keyboard events
  element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  element.dispatchEvent(new KeyboardEvent('keypress', { key: value, bubbles: true }));
  element.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true }));

  try {
    const inputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: value,
      inputType: 'insertText'
    });
    element.dispatchEvent(inputEvent);
  } catch (e) {}
}

/**
 * Searches the page for 6-digit split input boxes (e.g. 6 boxes with maxlength="1").
 */
function findSplitOtpInputs() {
  const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([disabled])'));
  
  // Find candidates with maxlength=1 or size=1
  const singleCharInputs = inputs.filter(inp => {
    const ml = inp.getAttribute('maxlength');
    const sz = inp.getAttribute('size');
    const type = (inp.type || 'text').toLowerCase();
    return (ml === '1' || sz === '1') && (type === 'text' || type === 'number' || type === 'tel' || type === 'password');
  });

  // Check if we have a group of 4 to 8 single-character inputs in the same parent/form
  if (singleCharInputs.length >= 4 && singleCharInputs.length <= 8) {
    // Check if they are visible
    const visible = singleCharInputs.filter(isElementVisible);
    if (visible.length >= 4 && visible.length <= 8) {
      return visible;
    }
  }

  return null;
}

/**
 * Checks if an input is explicitly a non-OTP field (e.g. username, email, standard password, search).
 */
function isNonOtpField(input) {
  if (!input) return true;
  const type = (input.type || 'text').toLowerCase();
  if (['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden', 'search', 'email'].includes(type)) {
    return true;
  }

  const id = (input.id || '').toLowerCase();
  const name = (input.name || '').toLowerCase();
  const autocomplete = (input.autocomplete || '').toLowerCase();
  const placeholder = (input.placeholder || '').toLowerCase();
  const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();

  // If explicitly designated as a 2FA field by autocomplete, id, or name, allow it unconditionally
  if (autocomplete === 'one-time-code') {
    return false;
  }

  const otpTokens = [
    'twofa', '2fa', 'totp', 'otp', 'mfa', 'two_fa', 'two-fa', 'twofactor',
    'two_factor', 'authcode', 'securitycode', 'verificationcode', 'verifycode',
    'passcode', 'security_code', 'verification_code'
  ];
  for (const token of otpTokens) {
    if (id.includes(token) || name.includes(token) || placeholder.includes(token) || ariaLabel.includes(token)) {
      return false;
    }
  }

  // Exact names/ids common in 2FA (e.g. WHMCS "code", "key", "token", "inputTwoFactorCode")
  if (['code', 'key', 'token', 'auth_key', 'twofa_value'].includes(name) || ['code', 'key', 'token', 'inputtwofactorcode'].includes(id)) {
    return false;
  }

  // Blacklist standard non-2FA fields
  const negativeKeywords = [
    'username', 'user_name', 'email', 'e-mail', 'login_id', 'phone', 'mobile',
    'search', 'query', 'filter', 'zip', 'postal', 'cvv', 'card', 'promo',
    'discount', 'coupon', 'address', 'city', 'state', 'country', 'first_name',
    'last_name', 'comment', 'message', 'subject', 'title', 'company'
  ];

  for (const neg of negativeKeywords) {
    if (id.includes(neg) || name.includes(neg) || autocomplete.includes(neg) || placeholder.includes(neg)) {
      return true;
    }
  }

  // Standard account password field (Step 1 password): DO NOT auto-paste OTP here!
  if (type === 'password') {
    const pwKeywords = ['password', 'passwd', 'pwd', 'loginpassword', 'current-password'];
    if (pwKeywords.some(pw => id.includes(pw) || name.includes(pw) || autocomplete.includes(pw))) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if an element is visibly rendered on screen.
 */
function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return true;
  if (el.offsetParent !== null) return true;
  return false;
}

/**
 * Searches for a genuine 2FA / OTP input field strictly.
 */
function findStandardOtpInput() {
  const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([disabled])'));
  const visibleInputs = allInputs.filter(isElementVisible);

  // 1. Look for explicit autocomplete="one-time-code"
  const oneTimeCode = visibleInputs.find(inp => (inp.autocomplete || '').toLowerCase() === 'one-time-code' && !isNonOtpField(inp));
  if (oneTimeCode) {
    return oneTimeCode;
  }

  // 2. High-confidence 2FA input keywords on input name, id, placeholder, class, or aria-label
  const otpRegex = /(^|[^a-z0-9])(otp|totp|2fa|twofa|twofacode|twofa_code|two_fa|two-fa|mfa|verification_?code|security_?code|auth_?code|twofa_value|twofactor|two_factor|passcode|auth_?key)([^a-z0-9]|$)/i;

  for (const input of visibleInputs) {
    if (isNonOtpField(input)) continue;

    const id = input.id || '';
    const name = input.name || '';
    const placeholder = input.placeholder || '';
    const ariaLabel = input.getAttribute('aria-label') || '';
    const className = typeof input.className === 'string' ? input.className : '';

    if (
      otpRegex.test(id) ||
      otpRegex.test(name) ||
      otpRegex.test(placeholder) ||
      otpRegex.test(ariaLabel) ||
      otpRegex.test(className)
    ) {
      return input;
    }

    // Exact matches for generic 2FA field names (like WHMCS "code" or "key")
    const cleanName = name.toLowerCase().trim();
    const cleanId = id.toLowerCase().trim();
    if (['code', 'key', 'token', 'inputtwofactorcode', 'twofa_value'].includes(cleanName) ||
        ['code', 'key', 'token', 'inputtwofactorcode', 'twofa_value'].includes(cleanId)) {
      return input;
    }
  }

  // 3. Fallback: Form explicitly dedicated to Second Factor / 2FA verification (e.g. WHMCS Step 2)
  const textKeywords = [
    'second factor', '2nd factor', 'two-factor', 'two factor', '2-factor',
    'authenticator code', 'verification code', 'backup code', 'security code',
    'authenticator app', 'one-time password', 'one-time code', 'two-step', '2-step'
  ];

  for (const input of visibleInputs) {
    if (isNonOtpField(input)) continue;

    const container = input.closest('form, div[class*="auth" i], div[class*="login" i], div[class*="modal" i], div[class*="card" i], div[class*="container" i], div[class*="box" i]');
    if (container) {
      // Must NOT be a Step-1 login form with VISIBLE username/email/standard password inputs
      const visibleUserInputs = Array.from(container.querySelectorAll('input:not([type="hidden"]):not([disabled])'))
        .filter(el => el !== input && isElementVisible(el))
        .filter(el => {
          const t = (el.type || 'text').toLowerCase();
          const n = (el.name || '').toLowerCase();
          const id = (el.id || '').toLowerCase();
          return t === 'email' || n.includes('user') || id.includes('user') || n.includes('email') || id.includes('email') || (t === 'password' && (n.includes('pass') || id.includes('pass')));
        });

      if (visibleUserInputs.length === 0) {
        const text = (container.innerText || '').toLowerCase();
        for (const tkw of textKeywords) {
          if (text.includes(tkw)) {
            return input;
          }
        }
      }
    }
  }

  // 4. Page-level single 2FA challenge detection (WHMCS & portals where only one 2FA input is visible)
  const bodyText = (document.body?.innerText || '').toLowerCase();
  const pageHas2FaPrompt = textKeywords.some(tkw => bodyText.includes(tkw));

  if (pageHas2FaPrompt) {
    // Only consider visible text/number/tel/password fields that aren't buttons/hidden/search/email
    const candidateInputs = visibleInputs.filter(inp => {
      const type = (inp.type || 'text').toLowerCase();
      if (!['text', 'tel', 'number', 'password'].includes(type)) return false;
      const n = (inp.name || '').toLowerCase();
      const id = (inp.id || '').toLowerCase();
      // Not a username/email field
      if (n.includes('user') || id.includes('user') || n.includes('email') || id.includes('email')) return false;
      return true;
    });

    if (candidateInputs.length === 1) {
      return candidateInputs[0];
    }
  }

  return null;
}

function flashElement(el) {
  el.classList.add('autoauth-highlight-field');
  setTimeout(() => {
    el.classList.remove('autoauth-highlight-field');
  }, 1600);
}

/**
 * Performs the autofill process.
 */
async function autofillOtp(code, issuer = '2FA') {
  if (!code) return { success: false, error: 'No OTP code provided' };

  let filled = false;

  // 1. Check for split boxes (e.g., 6 separate boxes)
  const splitBoxes = findSplitOtpInputs();
  if (splitBoxes && splitBoxes.length >= code.length) {
    for (let i = 0; i < code.length; i++) {
      triggerInputEvents(splitBoxes[i], code[i]);
      flashElement(splitBoxes[i]);
    }
    splitBoxes[Math.min(code.length - 1, splitBoxes.length - 1)].focus();
    filled = true;
  } else {
    // 2. Check for standard single input
    const singleInput = findStandardOtpInput();
    if (singleInput) {
      triggerInputEvents(singleInput, code);
      flashElement(singleInput);
      filled = true;
    }
  }

  // Also copy to clipboard as a seamless convenience backup
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(code);
    }
  } catch (e) {
    // Clipboard write may fail if document is not focused; safe to ignore
  }

  // Format code for user display: "123 456"
  const formattedCode = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

  if (filled) {
    showInPageToast({
      status: 'success',
      title: `⚡ AutoAuth: ${issuer}`,
      message: 'OTP auto-filled into page!',
      code: formattedCode
    });
    return { success: true, filled: true, code };
  } else {
    // Even if no field was detected, show notification and tell user it was copied
    showInPageToast({
      status: 'warn',
      title: `⚡ AutoAuth: ${issuer}`,
      message: 'No OTP input detected. Code copied to clipboard!',
      code: formattedCode
    });
    return { success: true, filled: false, code };
  }
}

// Runtime message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'PING') {
    sendResponse({ alive: true });
    return;
  }

  if (message.action === 'AUTOFILL_OTP') {
    autofillOtp(message.code, message.issuer).then(res => sendResponse(res));
    return true; // Keep channel open
  }

  if (message.action === 'SHOW_NOTIF') {
    showInPageToast({
      status: message.status || 'warn',
      title: 'AutoAuthMe',
      message: message.message || ''
    });
    sendResponse({ success: true });
    return;
  }
});

// --- Direct Hands-Free Autofill Engine ---
let hasDirectAutoFilled = false;
let directCheckInProgress = false;

async function attemptDirectAutofill() {
  if (hasDirectAutoFilled || directCheckInProgress) return;

  // Check if an OTP input exists on the page
  const splitBoxes = findSplitOtpInputs();
  const singleInput = findStandardOtpInput();

  if (!splitBoxes && !singleInput) return;

  // Query background worker to see if direct autofill is enabled and domain matches
  directCheckInProgress = true;
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'CHECK_AUTOFILL_MATCH',
      domain: window.location.hostname
    });

    if (response && response.shouldFill && response.code) {
      hasDirectAutoFilled = true;
      await autofillOtp(response.code, response.issuer);
    }
  } catch (e) {
    // Safe to ignore if extension was reloaded
  } finally {
    directCheckInProgress = false;
  }
}

// Run initial checks (immediate, 250ms, 600ms, 1200ms, 2000ms)
function scheduleAutofillChecks() {
  attemptDirectAutofill();
  setTimeout(attemptDirectAutofill, 250);
  setTimeout(attemptDirectAutofill, 600);
  setTimeout(attemptDirectAutofill, 1200);
  setTimeout(attemptDirectAutofill, 2000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scheduleAutofillChecks);
} else {
  scheduleAutofillChecks();
}
window.addEventListener('load', scheduleAutofillChecks);

// Observe dynamic DOM changes (for SPAs like React, Vue, Angular that show 2FA form dynamically)
let observerDebounce = null;
const observer = new MutationObserver((mutations) => {
  if (hasDirectAutoFilled) {
    observer.disconnect();
    return;
  }

  // Performance optimization: check if any added node is or contains an input or form
  let relevantChange = false;
  for (const m of mutations) {
    if (m.addedNodes && m.addedNodes.length > 0) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) { // ELEMENT_NODE
          if (node.tagName === 'INPUT' || (node.querySelector && node.querySelector('input'))) {
            relevantChange = true;
            break;
          }
        }
      }
    }
    if (relevantChange) break;
  }

  if (!relevantChange) return;

  clearTimeout(observerDebounce);
  observerDebounce = setTimeout(attemptDirectAutofill, 200);
});

if (document.body || document.documentElement) {
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });
}

// When tab gains focus or user clicks into the 2FA input
window.addEventListener('focus', () => {
  if (!hasDirectAutoFilled) attemptDirectAutofill();
});

document.addEventListener('focusin', (e) => {
  if (hasDirectAutoFilled) return;
  const target = e.target;
  if (!target || target.tagName !== 'INPUT') return;
  const otpInput = findStandardOtpInput();
  if (otpInput && otpInput === target) {
    attemptDirectAutofill();
  }
});

// Disconnect observer after 60 seconds to conserve browser resources
setTimeout(() => {
  observer.disconnect();
}, 60000);

})();


