# 🛡️ AutoAuthMe - Browser 2FA Authenticator & Autofill

A secure, privacy-first **Manifest V3** browser extension that generates TOTP 2FA codes from an **AES-256-GCM** encrypted local vault, matches active website domains, and **auto-fills / auto-pastes** OTP codes with a single click or right-click context menu.

---

## ✨ Features

- 📱 **100% Google Authenticator Compatible**:
  - Uses the exact same industry-standard **RFC 6238 TOTP** algorithm (HMAC-SHA1, 30s period, 6 digits).
  - Every service that supports Google Authenticator (Google, GitHub, AWS, Discord, Binance, Twitter, etc.) works identically in AutoAuthMe.
  - **Batch Migration**: Supports Google Authenticator's official transfer export link (`otpauth-migration://offline?data=...`), allowing you to transfer all your existing Google Authenticator accounts in one step!
- 🔒 **Zero-Knowledge Encrypted Vault**: Secrets are encrypted on-device using **AES-256-GCM** with keys derived via **PBKDF2** (100,000 iterations, SHA-256). Nothing is ever transmitted to an external server.
- ⚡ **1-Click Smart Autofill**:
  - Detects active browser tab (e.g., `github.com`) and pins matching accounts to the top of the popup.
  - Injects and fills OTP codes directly into verification forms.
  - Supports standard inputs (`autocomplete="one-time-code"`, `name="otp"`, `id="code"`, etc.).
  - Supports **split 6-digit box layouts** (6 individual single-character input boxes) commonly found on modern login portals.
- 🖱️ **Right-Click Context Menu**: Right-click on any webpage or input field & select **"⚡ AutoAuth: Autofill OTP"**.
- ⏱️ **Live Countdown Timer**: SVG radial progress circle with real-time 30-second countdown indicator (green ➔ amber ➔ red).
- 📋 **Click to Copy & Fallback**: One-click code copying to clipboard with visual toast feedback.
- ⌨️ **Keyboard-First Navigation**: Press `/` (or `Ctrl/Cmd+K`) to search, just start typing to filter, use `↑`/`↓` to highlight an account and `Enter` to copy its code, and `Esc` to clear/back out. All confirm dialogs (delete, export, wipe, password re-entry) are styled in-popup modals.
- 🔗 **Easy Account Setup**:
  - Add manually (Issuer, Account, Base32 Secret, Domain pattern).
  - Paste `otpauth://totp/...` URIs.
  - Auto-suggests the domain of your active browser tab when adding!
- 💾 **Backup & Restore**: Export and import accounts as JSON.
- ⏳ **Configurable Auto-Lock**: Automatically locks the vault after 5, 15, 30, or 60 minutes of inactivity.

---

## 🚀 How to Install in Your Browser

This extension works in **Google Chrome**, **Microsoft Edge**, **Brave**, **Opera**, or any Chromium-based browser.

### Step 1: Open Extension Management
- **Chrome / Brave**: Open a new tab and go to `chrome://extensions`
- **Edge**: Open a new tab and go to `edge://extensions`

### Step 2: Enable Developer Mode
- Toggle the **Developer mode** switch in the top right corner of the Extensions page.

### Step 3: Load the Extension
1. Click the **"Load unpacked"** button in the top left.
2. Select the `autoauthme` project root folder.
3. AutoAuthMe will now appear in your extensions list.
4. (Recommended) Click the puzzle piece icon 🧩 in your browser toolbar and **pin 📌 AutoAuthMe** for quick access.

---

## 🧪 Quick Start & Testing

We have included a built-in verification test page (`demo/demo-login.html`) to test both single and split-box 2FA forms.

1. Open `demo/demo-login.html` in your browser.
2. Click the **AutoAuthMe** icon in your toolbar.
3. On first launch, create a **Master Password** (e.g. `MySecurePass123!`).
4. Click **`+` (Add)** and add the demo account:
   - **Issuer:** `TestPortal`
   - **Account:** `user@example.com`
   - **Secret Key:** `JBSWY3DPEHPK3PXP`
5. Click **Save Account**.
6. On the demo page:
   - Open AutoAuthMe and click **⚡ Autofill**.
   - Or right-click inside the verification input and select **"⚡ AutoAuth: Autofill OTP"**.
   - Watch the OTP code instantly fill and highlight!

---

## 📁 Project Architecture

```
autoauthme/
├── manifest.json              # Chrome Manifest V3 configuration
├── background/
│   └── service-worker.js      # Background worker (context menu, session lock, message relay)
├── content/
│   ├── content.js             # In-page OTP detector, simulated input events & toast HUD
│   └── content.css            # Toast notification styles & field highlight animations
├── popup/
│   ├── popup.html             # Extension popup interface
│   ├── popup.css              # Modern adaptive light/dark theme, glass cards & SVG timer
│   └── popup.js               # Popup controller, vault crypto integration, search & actions
├── lib/
│   ├── base32.js              # RFC 4648 Base32 encoder/decoder
│   ├── crypto.js              # AES-256-GCM encryption & PBKDF2 key derivation
│   └── totp.js                # RFC 6238 TOTP generator, timer math & URI parser
├── demo/
│   └── demo-login.html        # Test verification page (single + split 6-box forms)
├── icons/                     # Extension icons (16px, 32px, 48px, 128px)
└── scripts/
    └── generate-icons.js      # Icon generation script
```

---

## 🔒 Security Architecture

1. **Master Key Derivation**: When unlocking or setting up, PBKDF2 runs with `100,000` iterations of `SHA-256` and a cryptographically random 16-byte salt to produce a 256-bit AES key.
2. **Authenticated Encryption**: All account secrets are encrypted using `AES-GCM` with a fresh 12-byte initialization vector (IV) per save.
3. **In-Memory Session Caching**: The decrypted key remains in `chrome.storage.session` (memory only) while unlocked and is discarded automatically upon timeout or browser closure.
4. **No Remote Telemetry**: The extension contains zero tracking, zero external scripts, and requires no external network connections.
