import { generateTOTP, getRemainingSeconds, parseOtpAuthUri, parseGoogleAuthMigrationUri, formatCode } from '../lib/totp.js';
import { encryptVault, decryptVault } from '../lib/crypto.js';
import { base32ToUint8Array } from '../lib/base32.js';
import { matchAccountDomain, normalizeDomain } from '../lib/domain.js';

// Application State
let currentVaultData = null; // Decrypted { accounts: [], settings: {} }
let currentMasterPassword = '';
let activeTabDomain = '';
let activeTabId = null;
let timerInterval = null;
let searchQuery = '';
let editingAccountId = null;
let clipboardTimer = null;

// DOM Elements
const views = {
  setup: document.getElementById('view-setup'),
  unlock: document.getElementById('view-unlock'),
  main: document.getElementById('view-main'),
  add: document.getElementById('view-add'),
  settings: document.getElementById('view-settings')
};

// --- View Router ---
function showView(viewName) {
  Object.keys(views).forEach(key => {
    if (key === viewName) {
      views[key].classList.remove('hidden');
    } else {
      views[key].classList.add('hidden');
    }
  });

  if (viewName === 'main') {
    renderAccounts().then(() => {
      startTimerLoop();
    });
  } else {
    stopTimerLoop();
  }
}

// --- Toast Helper inside popup ---
function showPopupToast(message) {
  const toast = document.getElementById('popup-toast');
  const msgEl = document.getElementById('popup-toast-msg');
  msgEl.textContent = message;
  toast.classList.remove('hidden');

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 2200);
}

// --- In-Popup Modal System (replaces native prompt/confirm/alert) ---
const modalOverlay = document.getElementById('modal-overlay');
const modalBox = document.getElementById('modal-box');
const modalTitleEl = document.getElementById('modal-title');
const modalMessageEl = document.getElementById('modal-message');
const modalIconEl = document.getElementById('modal-icon');
const modalIconSvg = document.getElementById('modal-icon-svg');
const modalInputWrap = document.getElementById('modal-input-wrap');
const modalInput = document.getElementById('modal-input');
const modalInputError = document.getElementById('modal-input-error');
const modalConfirmBtn = document.getElementById('modal-confirm');
const modalCancelBtn = document.getElementById('modal-cancel');

let modalState = null;
let lastFocusedBeforeModal = null;

const MODAL_ICON_PATHS = {
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  warning: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  question: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
};

function showModal(config = {}) {
  return new Promise((resolve) => {
    const {
      title = 'Are you sure?',
      message = '',
      confirmText = 'Confirm',
      cancelText = 'Cancel',
      tone = 'default',
      icon = 'question',
      password = false,
      passwordPlaceholder = 'Master Password'
    } = config;

    lastFocusedBeforeModal = document.activeElement;
    modalState = { resolve, password };

    modalTitleEl.textContent = title;
    modalMessageEl.textContent = message;
    modalMessageEl.classList.toggle('hidden', !message);
    modalIconSvg.innerHTML = MODAL_ICON_PATHS[icon] || MODAL_ICON_PATHS.question;
    modalIconEl.className = `modal-icon tone-${tone}`;
    modalConfirmBtn.textContent = confirmText;
    modalConfirmBtn.className = tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
    modalConfirmBtn.disabled = false;
    modalCancelBtn.textContent = cancelText || 'Cancel';
    modalCancelBtn.classList.toggle('hidden', cancelText === null);

    modalInputError.classList.add('hidden');
    modalInputWrap.classList.toggle('hidden', !password);
    modalInput.value = '';
    modalInput.placeholder = passwordPlaceholder;
    modalInput.type = 'password';
    const pwdToggle = document.getElementById('btn-modal-toggle-pwd');
    pwdToggle.querySelector('.icon-eye').classList.remove('hidden');
    pwdToggle.querySelector('.icon-eye-off').classList.add('hidden');

    modalOverlay.classList.remove('hidden');

    setTimeout(() => {
      if (modalState && password) modalInput.focus();
      else if (modalState) modalConfirmBtn.focus();
    }, 30);
  });
}

function closeModal(result = { confirmed: false, value: null }) {
  const st = modalState;
  modalState = null;
  modalOverlay.classList.add('hidden');
  if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
    try { lastFocusedBeforeModal.focus(); } catch (e) { /* element may be gone */ }
  }
  if (st) st.resolve(result);
}

async function handleModalConfirm() {
  const st = modalState;
  if (!st) return;

  if (!st.password) {
    closeModal({ confirmed: true, value: null });
    return;
  }

  const pwd = modalInput.value;
  if (!pwd) {
    modalInputError.textContent = 'Please enter your master password.';
    modalInputError.classList.remove('hidden');
    return;
  }

  modalConfirmBtn.disabled = true;
  try {
    const { vault } = await chrome.storage.local.get(['vault']);
    if (vault) await decryptVault(vault, pwd);
    if (!modalState) return;
    currentMasterPassword = pwd;
    closeModal({ confirmed: true, value: pwd });
  } catch (err) {
    modalInputError.textContent = 'Incorrect master password. Try again.';
    modalInputError.classList.remove('hidden');
    modalBox.classList.add('shake');
    setTimeout(() => modalBox.classList.remove('shake'), 450);
    modalInput.select();
  } finally {
    modalConfirmBtn.disabled = false;
  }
}

function trapModalFocus(e) {
  const focusables = Array.from(modalBox.querySelectorAll('button:not(.hidden), input:not(.hidden)'))
    .filter(el => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

modalConfirmBtn.addEventListener('click', handleModalConfirm);
modalCancelBtn.addEventListener('click', () => closeModal({ confirmed: false, value: null }));
modalOverlay.addEventListener('mousedown', (e) => {
  if (e.target === modalOverlay) closeModal({ confirmed: false, value: null });
});
document.getElementById('btn-modal-toggle-pwd').addEventListener('click', () => {
  const btn = document.getElementById('btn-modal-toggle-pwd');
  const revealing = modalInput.type === 'password';
  modalInput.type = revealing ? 'text' : 'password';
  btn.querySelector('.icon-eye').classList.toggle('hidden', revealing);
  btn.querySelector('.icon-eye-off').classList.toggle('hidden', !revealing);
});

// --- Active Tab Domain Extraction ---
async function detectActiveTabDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith('chrome://')) {
      activeTabId = tab.id;
      const parsed = new URL(tab.url);
      activeTabDomain = normalizeDomain(parsed.hostname);
    }
  } catch (e) {
    activeTabDomain = '';
  }
}

function matchAccountWithDomain(account, rawDomain) {
  return matchAccountDomain(account, rawDomain);
}

// --- Master Password Prompt Helper (if popup reopened from unlocked session) ---
async function ensureMasterPassword() {
  if (currentMasterPassword) return currentMasterPassword;
  const res = await showModal({
    title: 'Confirm Master Password',
    message: 'Your vault session expired. Enter your master password to save these changes.',
    confirmText: 'Confirm',
    icon: 'lock',
    password: true
  });
  return res.confirmed ? res.value : null;
}

// --- Save Vault Helper ---
async function saveVaultData() {
  if (!currentVaultData) return false;
  const pwd = await ensureMasterPassword();
  if (!pwd) return false;

  const encrypted = await encryptVault(currentVaultData, pwd);
  const autoFillOnPageLoad = !!(currentVaultData.settings?.autoFillOnPageLoad);
  await chrome.storage.local.set({ vault: encrypted, autoFillOnPageLoad });

  // Update session WITHOUT storing plaintext master password
  await chrome.storage.session.set({
    unlocked: true,
    accounts: currentVaultData.accounts,
    lastActive: Date.now(),
    autoLockMinutes: currentVaultData.settings?.autoLockMinutes || 15,
    autoFillOnPageLoad
  });
  return true;
}

// --- Dynamic Avatar Color Generator ---
function getAvatarGradient(issuer) {
  const gradients = [
    'linear-gradient(135deg, #d6d0c2, #b3ac99)',
    'linear-gradient(135deg, #cbc4b3, #9a9482)',
    'linear-gradient(135deg, #beb7a4, #8a8271)',
    'linear-gradient(135deg, #d9d4c8, #b0a894)',
    'linear-gradient(135deg, #c7bfae, #857f6d)',
    'linear-gradient(135deg, #b3ac99, #6f6a5e)'
  ];
  let hash = 0;
  for (let i = 0; i < (issuer || '').length; i++) {
    hash = (hash << 5) - hash + issuer.charCodeAt(i);
  }
  const index = Math.abs(hash) % gradients.length;
  return gradients[index];
}

// --- Render Accounts ---
async function renderAccounts() {
  const container = document.getElementById('accounts-container');
  const emptyState = document.getElementById('empty-state');

  container.innerHTML = '';
  clearKbSelection();

  const accounts = currentVaultData?.accounts || [];
  const query = searchQuery.trim().toLowerCase();

  const filtered = accounts.filter(acc => {
    if (!query) return true;
    const issuer = (acc.issuer || '').toLowerCase();
    const account = (acc.account || '').toLowerCase();
    const domains = Array.isArray(acc.domains) ? acc.domains.join(' ').toLowerCase() : '';
    return issuer.includes(query) || account.includes(query) || domains.includes(query);
  });

  if (filtered.length === 0) {
    if (accounts.length === 0) {
      emptyState.classList.remove('hidden');
    } else {
      emptyState.classList.add('hidden');
      container.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 24px; font-size: 13px;">No accounts match "${escapeHtml(searchQuery)}"</div>`;
    }
    return;
  }

  emptyState.classList.add('hidden');

  // Sort: domain matches first, then alphabetical by issuer
  filtered.sort((a, b) => {
    const aMatch = matchAccountWithDomain(a, activeTabDomain);
    const bMatch = matchAccountWithDomain(b, activeTabDomain);
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;
    return (a.issuer || '').localeCompare(b.issuer || '');
  });

  const now = Date.now();
  const epochSec = Math.floor(now / 1000);
  const radius = 10;
  const circumference = 2 * Math.PI * radius; // ~62.83

  // Performance optimization: Generate all TOTPs concurrently using Promise.all
  const codes = await Promise.all(
    filtered.map(acc => generateTOTP(acc.secret, acc).catch(() => 'ERROR'))
  );

  filtered.forEach((acc, index) => {
    const code = codes[index];
    const card = document.createElement('div');
    card.className = 'account-card';
    card.dataset.id = acc.id;
    const period = parseInt(acc.period || '30', 10);
    card.dataset.period = String(period);
    const currentStep = Math.floor(epochSec / period);
    card.dataset.step = String(currentStep);

    const isSiteMatch = matchAccountWithDomain(acc, activeTabDomain);
    if (isSiteMatch) {
      card.classList.add('matched-tab');
    }

    const { remaining, progressFraction } = getRemainingSeconds(period, now);
    const formatted = formatCode(code);
    const avatarInitials = (acc.issuer || '2F').slice(0, 2).toUpperCase();
    const avatarBg = getAvatarGradient(acc.issuer);

    const strokeOffset = circumference * (1 - progressFraction);
    const alertClass = remaining <= 5 ? 'danger' : remaining <= 10 ? 'warning' : '';

    card.innerHTML = `
      <div class="account-card-header">
        <div class="account-meta">
          <div class="account-avatar" style="background: ${avatarBg}">${avatarInitials}</div>
          <div class="account-titles">
            <div class="account-title-row">
              <span class="account-issuer">${escapeHtml(acc.issuer || 'Unnamed')}</span>
              ${isSiteMatch ? `
                <span class="site-match-tick" title="Active on this site (${escapeHtml(activeTabDomain)})">
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 8.5 6.5 12 13 4.5" />
                  </svg>
                </span>` : ''}
            </div>
            <span class="account-name">${escapeHtml(acc.account || '')}</span>
          </div>
        </div>
        <div class="account-card-actions">
          <button class="card-btn edit-btn" data-id="${acc.id}" title="Edit Account">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="card-btn delete-btn" data-id="${acc.id}" title="Delete Account">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
      <div class="account-card-bottom">
        <div class="otp-display-wrap">
          <div class="otp-code" data-code="${code}" title="Click to copy">${formatted}</div>
        </div>
        <div class="action-buttons-group">
          <div class="timer-wrap">
            <svg class="timer-svg" viewBox="0 0 28 28">
              <circle class="timer-bg" cx="14" cy="14" r="${radius}"></circle>
              <circle class="timer-progress ${alertClass}" cx="14" cy="14" r="${radius}"
                stroke-dasharray="${circumference}"
                stroke-dashoffset="${strokeOffset.toFixed(2)}">
              </circle>
            </svg>
            <span class="timer-number">${remaining}</span>
          </div>

          <button class="btn-autofill-card" data-code="${code}" data-issuer="${escapeHtml(acc.issuer)}" title="Autofill to active site">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>
            <span>Autofill</span>
          </button>
          <button class="btn-copy-card" data-code="${code}" title="Copy code">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </div>
    `;

    // Code click to copy
    const codeEl = card.querySelector('.otp-code');
    codeEl.onclick = () => copyCodeToClipboard(codeEl.dataset.code || code);

    // Copy button
    const copyBtn = card.querySelector('.btn-copy-card');
    copyBtn.onclick = () => {
      copyCodeToClipboard(copyBtn.dataset.code || code);
      copyBtn.classList.add('copied');
      setTimeout(() => copyBtn.classList.remove('copied'), 1200);
    };

    // Autofill button
    const autofillBtn = card.querySelector('.btn-autofill-card');
    autofillBtn.onclick = () => autofillToActiveTab(autofillBtn.dataset.code || code, acc.issuer);

    // Edit button
    const editBtn = card.querySelector('.edit-btn');
    editBtn.onclick = () => openEditAccount(acc);

    // Delete button
    const deleteBtn = card.querySelector('.delete-btn');
    deleteBtn.onclick = () => deleteAccount(acc.id, acc.issuer);

    container.appendChild(card);
  });
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return (text || '').replace(/[&<>"']/g, m => map[m]);
}

// --- Copy & Autofill Helpers with 45s Auto-Clear ---
async function copyCodeToClipboard(code) {
  try {
    await navigator.clipboard.writeText(code);
    showPopupToast('Code copied! (Auto-clears in 45s)');

    if (clipboardTimer) clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text === code) {
          await navigator.clipboard.writeText('');
        }
      } catch (e) {}
    }, 45000);
  } catch (err) {
    showPopupToast('Failed to copy');
  }
}

async function autofillToActiveTab(code, issuer) {
  showPopupToast(`Autofilling ${issuer}...`);
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'AUTOFILL_ACTIVE_TAB',
      code: code,
      issuer: issuer
    });

    if (res && res.success) {
      showPopupToast('OTP filled successfully!');
    } else {
      showPopupToast(res?.error || 'Page responded with warning');
    }
  } catch (err) {
    showPopupToast('Could not autofill on this page');
  }
}

async function deleteAccount(id, issuer) {
  const res = await showModal({
    title: 'Delete account?',
    message: `"${issuer || 'This account'}" will be permanently removed from your vault.`,
    confirmText: 'Delete',
    tone: 'danger',
    icon: 'trash'
  });
  if (!res.confirmed) return;
  currentVaultData.accounts = currentVaultData.accounts.filter(a => a.id !== id);
  const saved = await saveVaultData();
  if (saved) {
    renderAccounts();
    showPopupToast('Account deleted');
  }
}

// --- Edit Account Handler ---
function openEditAccount(account) {
  if (!account) return;
  editingAccountId = account.id;

  const issuerInput = document.getElementById('add-issuer');
  const accountInput = document.getElementById('add-account');
  const secretInput = document.getElementById('add-secret');
  const domainInput = document.getElementById('add-domain');

  if (issuerInput) issuerInput.value = account.issuer || '';
  if (accountInput) accountInput.value = account.account || '';
  if (secretInput) secretInput.value = account.secret || '';
  if (domainInput) domainInput.value = (account.domains && account.domains.length > 0) ? account.domains.join(', ') : '';

  updateDomainChip();

  // Switch to manual tab
  const tabBtnManual = document.getElementById('tab-btn-manual');
  if (tabBtnManual) tabBtnManual.click();

  // Update header title and button text
  const titleEl = document.querySelector('#view-add .header-title');
  if (titleEl) titleEl.textContent = 'Edit 2FA Account';
  const submitSpan = document.querySelector('#form-add-manual button[type="submit"] span');
  if (submitSpan) submitSpan.textContent = 'Update account';

  showView('add');
}

// --- Live Real-Time Timer Loop ---
function updateLiveTimers() {
  const now = Date.now();
  const epochSec = Math.floor(now / 1000);
  const radius = 10;
  const circumference = 2 * Math.PI * radius; // ~62.83

  const cards = document.querySelectorAll('.account-card');
  if (!cards || cards.length === 0) return;

  cards.forEach(card => {
    const period = parseInt(card.dataset.period || '30', 10);
    const { remaining, progressFraction } = getRemainingSeconds(period, now);
    const currentStep = Math.floor(epochSec / period);

    // Update countdown number
    const timerNumber = card.querySelector('.timer-number');
    if (timerNumber) {
      timerNumber.textContent = remaining;
    }

    // Update SVG countdown ring
    const progressCircle = card.querySelector('.timer-progress');
    if (progressCircle) {
      const offset = circumference * (1 - progressFraction);
      progressCircle.setAttribute('stroke-dashoffset', offset.toFixed(2));

      // Classes
      progressCircle.classList.remove('warning', 'danger');
      if (remaining <= 5) {
        progressCircle.classList.add('danger');
      } else if (remaining <= 10) {
        progressCircle.classList.add('warning');
      }
    }

    // Check if the 30-second cycle rolled over for this account
    if (card.dataset.step && card.dataset.step !== String(currentStep)) {
      card.dataset.step = String(currentStep);
      const accId = card.dataset.id;
      const account = currentVaultData?.accounts?.find(a => a.id === accId);
      if (account) {
        generateTOTP(account.secret, account).then(newCode => {
          const codeEl = card.querySelector('.otp-code');
          if (codeEl) {
            codeEl.textContent = formatCode(newCode);
            codeEl.dataset.code = newCode;
          }
          const autofillBtn = card.querySelector('.btn-autofill-card');
          if (autofillBtn) autofillBtn.dataset.code = newCode;
          const copyBtn = card.querySelector('.btn-copy-card');
          if (copyBtn) copyBtn.dataset.code = newCode;
        }).catch(err => {
          console.error('Failed to regenerate TOTP:', err);
        });
      }
    }
  });
}

function startTimerLoop() {
  if (timerInterval) clearInterval(timerInterval);
  // Run immediately once
  updateLiveTimers();
  // Tick every 500ms so countdown is always super responsive and precise
  timerInterval = setInterval(updateLiveTimers, 500);
}

function stopTimerLoop() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// --- App Initialization ---
async function initApp() {
  await detectActiveTabDomain();

  const { vault } = await chrome.storage.local.get(['vault']);
  if (!vault) {
    // Brand new user: setup vault
    showView('setup');
    return;
  }

  // Check session storage (never stores masterPassword)
  const session = await chrome.storage.session.get(['unlocked', 'accounts', 'lastActive', 'autoLockMinutes']);
  const lockMinutes = session.autoLockMinutes || 15;
  const isExpired = session.lastActive && lockMinutes > 0 && (Date.now() - session.lastActive > lockMinutes * 60 * 1000);

  if (session.unlocked && session.accounts && !isExpired) {
    currentVaultData = {
      accounts: session.accounts,
      settings: { autoLockMinutes: lockMinutes }
    };
    await chrome.storage.session.set({ lastActive: Date.now() });
    showView('main');
  } else {
    // Locked
    await chrome.storage.session.clear();
    showView('unlock');
  }
}

// --- Event Handlers ---

// 1. Setup Form Submit
document.getElementById('form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwd = document.getElementById('setup-password').value;
  const pwdConfirm = document.getElementById('setup-password-confirm').value;
  const errEl = document.getElementById('setup-error');

  if (pwd.length < 6) {
    errEl.textContent = 'Password must be at least 6 characters.';
    errEl.classList.remove('hidden');
    return;
  }

  if (pwd !== pwdConfirm) {
    errEl.textContent = 'Passwords do not match.';
    errEl.classList.remove('hidden');
    return;
  }

  errEl.classList.add('hidden');
  currentMasterPassword = pwd;
  currentVaultData = {
    accounts: [],
    settings: { autoLockMinutes: 15 }
  };

  try {
    await saveVaultData();
    showView('main');
  } catch (err) {
    errEl.textContent = `Encryption error: ${err.message}`;
    errEl.classList.remove('hidden');
  }
});

// 2. Unlock Form Submit
document.getElementById('form-unlock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwd = document.getElementById('unlock-password').value;
  const errEl = document.getElementById('unlock-error');
  const btnUnlock = document.getElementById('btn-unlock');

  btnUnlock.disabled = true;
  errEl.classList.add('hidden');

  try {
    const { vault } = await chrome.storage.local.get(['vault']);
    const decrypted = await decryptVault(vault, pwd);

    currentVaultData = decrypted;
    currentMasterPassword = pwd;

    await chrome.storage.session.set({
      unlocked: true,
      accounts: decrypted.accounts || [],
      lastActive: Date.now(),
      autoLockMinutes: decrypted.settings?.autoLockMinutes || 15
    });

    document.getElementById('unlock-password').value = '';
    showView('main');
  } catch (err) {
    errEl.textContent = 'Incorrect master password. Please try again.';
    errEl.classList.remove('hidden');
    const authBox = document.querySelector('#view-unlock .auth-box');
    authBox.classList.add('shake');
    setTimeout(() => authBox.classList.remove('shake'), 500);
  } finally {
    btnUnlock.disabled = false;
  }
});

// Toggle password visibility
document.getElementById('btn-toggle-unlock-pwd').addEventListener('click', () => {
  const inp = document.getElementById('unlock-password');
  const btn = document.getElementById('btn-toggle-unlock-pwd');
  const revealing = inp.type === 'password';
  inp.type = revealing ? 'text' : 'password';
  btn.querySelector('.icon-eye').classList.toggle('hidden', revealing);
  btn.querySelector('.icon-eye-off').classList.toggle('hidden', !revealing);
});

// "Use current site" chip for the Autofill Domain field
const domainInput = document.getElementById('add-domain');
const useCurrentSiteBtn = document.getElementById('btn-use-current-site');

function updateDomainChip() {
  const show = !!activeTabDomain && domainInput.value.trim().toLowerCase() !== activeTabDomain;
  useCurrentSiteBtn.classList.toggle('hidden', !show);
  domainInput.classList.toggle('has-chip', show);
}

useCurrentSiteBtn.addEventListener('click', () => {
  domainInput.value = activeTabDomain;
  domainInput.focus();
  updateDomainChip();
});

domainInput.addEventListener('input', updateDomainChip);

// Secret keys: silently strip spaces/dashes as they're typed or pasted
const secretKeyInput = document.getElementById('add-secret');
secretKeyInput.addEventListener('input', () => {
  const raw = secretKeyInput.value;
  const cleaned = raw.replace(/[\s-]/g, '');
  if (cleaned === raw) return;
  const caret = secretKeyInput.selectionStart ?? cleaned.length;
  const removedBeforeCaret = (raw.slice(0, caret).match(/[\s-]/g) || []).length;
  secretKeyInput.value = cleaned;
  const next = caret - removedBeforeCaret;
  secretKeyInput.setSelectionRange(next, next);
});

// Reset Add/Edit Form Helper
function resetAddForm() {
  editingAccountId = null;
  formManual.reset();
  formUri.reset();
  if (activeTabDomain) {
    domainInput.value = activeTabDomain;
  }
  updateDomainChip();
  const titleEl = document.querySelector('#view-add .header-title');
  if (titleEl) titleEl.textContent = 'Add 2FA Account';
  const submitSpan = formManual.querySelector('button[type="submit"] span');
  if (submitSpan) submitSpan.textContent = 'Save account';
}

// 3. Navigation Buttons
document.getElementById('btn-lock').addEventListener('click', async () => {
  await chrome.storage.session.clear();
  currentVaultData = null;
  currentMasterPassword = '';
  showView('unlock');
});

document.getElementById('btn-nav-add').addEventListener('click', () => {
  resetAddForm();
  showView('add');
});

document.getElementById('btn-empty-add').addEventListener('click', () => {
  resetAddForm();
  showView('add');
});

document.getElementById('btn-add-back').addEventListener('click', () => {
  showView('main');
});

document.getElementById('btn-nav-settings').addEventListener('click', async () => {
  const select = document.getElementById('select-autolock');
  select.value = currentVaultData?.settings?.autoLockMinutes ?? 15;
  const toggle = document.getElementById('toggle-autofill-direct');
  const { autoFillOnPageLoad: localAutoFill } = await chrome.storage.local.get(['autoFillOnPageLoad']);
  const isEnabled = currentVaultData?.settings?.autoFillOnPageLoad ?? localAutoFill ?? false;
  toggle.checked = !!isEnabled;
  showView('settings');
});

document.getElementById('btn-settings-back').addEventListener('click', () => {
  showView('main');
});

// 4. Search Filter
const searchInput = document.getElementById('input-search');
const clearSearchBtn = document.getElementById('btn-clear-search');
const searchHint = document.getElementById('search-hint');

searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  if (searchQuery) clearSearchBtn.classList.remove('hidden');
  else clearSearchBtn.classList.add('hidden');
  searchHint.classList.toggle('hidden', !!searchQuery || document.activeElement === searchInput);
  renderAccounts();
});

searchInput.addEventListener('focus', () => searchHint.classList.add('hidden'));
searchInput.addEventListener('blur', () => {
  if (!searchInput.value) searchHint.classList.remove('hidden');
});

clearSearchBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchQuery = '';
  clearSearchBtn.classList.add('hidden');
  searchHint.classList.remove('hidden');
  renderAccounts();
});

// 5. Add Account Tabs
const tabBtnManual = document.getElementById('tab-btn-manual');
const tabBtnUri = document.getElementById('tab-btn-uri');
const formManual = document.getElementById('form-add-manual');
const formUri = document.getElementById('form-add-uri');

tabBtnManual.addEventListener('click', () => {
  tabBtnManual.classList.add('active');
  tabBtnUri.classList.remove('active');
  formManual.classList.remove('hidden');
  formUri.classList.add('hidden');
});

tabBtnUri.addEventListener('click', () => {
  tabBtnUri.classList.add('active');
  tabBtnManual.classList.remove('active');
  formUri.classList.remove('hidden');
  formManual.classList.add('hidden');
});

// 6. Add Manual Form Submit
formManual.addEventListener('submit', async (e) => {
  e.preventDefault();
  const issuer = document.getElementById('add-issuer').value.trim();
  const account = document.getElementById('add-account').value.trim();
  const secret = document.getElementById('add-secret').value.trim();
  const domain = document.getElementById('add-domain').value.trim();
  const errEl = document.getElementById('add-error');

  try {
    base32ToUint8Array(secret); // Validate base32
  } catch (err) {
    errEl.textContent = 'Invalid Base32 secret key. Check for invalid characters.';
    errEl.classList.remove('hidden');
    return;
  }

  errEl.classList.add('hidden');

  const domainArray = domain ? domain.split(',').map(d => d.trim().toLowerCase()).filter(Boolean) : [];

  if (editingAccountId) {
    const existingIndex = currentVaultData.accounts.findIndex(a => a.id === editingAccountId);
    if (existingIndex !== -1) {
      currentVaultData.accounts[existingIndex] = {
        ...currentVaultData.accounts[existingIndex],
        issuer,
        account,
        secret,
        domains: domainArray
      };
      const saved = await saveVaultData();
      if (!saved) return;
      formManual.reset();
      editingAccountId = null;
      showView('main');
      showPopupToast(`Updated ${issuer}!`);
      return;
    }
  }

  const newAccount = {
    id: 'acc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    issuer,
    account,
    secret,
    domains: domainArray,
    algorithm: 'SHA1',
    digits: 6,
    period: 30
  };

  currentVaultData.accounts.push(newAccount);
  const saved = await saveVaultData();
  if (!saved) return;

  formManual.reset();
  showView('main');
  showPopupToast(`Added ${issuer}!`);
});

// 7. Add URI Form Submit (Supports standard otpauth:// and Google Authenticator otpauth-migration://)
formUri.addEventListener('submit', async (e) => {
  e.preventDefault();
  const uri = document.getElementById('add-uri-input').value.trim();
  const errEl = document.getElementById('add-uri-error');

  try {
    if (uri.startsWith('otpauth-migration:')) {
      // Google Authenticator transfer / export payload
      const migratedAccounts = parseGoogleAuthMigrationUri(uri);
      let count = 0;
      migratedAccounts.forEach(acc => {
        currentVaultData.accounts.push({
          id: 'acc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          issuer: acc.issuer,
          account: acc.account,
          secret: acc.secret,
          domains: [],
          algorithm: acc.algorithm || 'SHA1',
          digits: acc.digits || 6,
          period: acc.period || 30
        });
        count++;
      });

      await saveVaultData();
      formUri.reset();
      showView('main');
      showPopupToast(`Imported ${count} account(s) from Google Authenticator!`);
    } else {
      // Standard otpauth:// URI
      const parsed = parseOtpAuthUri(uri);
      base32ToUint8Array(parsed.secret); // Validate secret

      const newAccount = {
        id: 'acc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        issuer: parsed.issuer,
        account: parsed.account,
        secret: parsed.secret,
        domains: activeTabDomain ? [activeTabDomain] : [],
        algorithm: parsed.algorithm || 'SHA1',
        digits: parsed.digits || 6,
        period: parsed.period || 30
      };

      currentVaultData.accounts.push(newAccount);
      await saveVaultData();

      formUri.reset();
      showView('main');
      showPopupToast(`Imported ${parsed.issuer}!`);
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// 8. Settings View Event Handlers
document.getElementById('select-autolock').addEventListener('change', async (e) => {
  const val = parseInt(e.target.value, 10);
  currentVaultData.settings = currentVaultData.settings || {};
  currentVaultData.settings.autoLockMinutes = val;
  await saveVaultData();
  showPopupToast('Auto-lock timeout updated');
});

document.getElementById('toggle-autofill-direct').addEventListener('change', async (e) => {
  const isChecked = e.target.checked;
  currentVaultData.settings = currentVaultData.settings || {};
  currentVaultData.settings.autoFillOnPageLoad = isChecked;
  await saveVaultData();
  await chrome.storage.local.set({ autoFillOnPageLoad: isChecked });
  await chrome.storage.session.set({ autoFillOnPageLoad: isChecked });
  showPopupToast(isChecked ? 'Auto-paste enabled!' : 'Auto-paste disabled');
});

// Export Decrypted JSON
document.getElementById('btn-export-json').addEventListener('click', async () => {
  if (!currentVaultData) return;
  const res = await showModal({
    title: 'Export plain-text backup?',
    message: 'This file contains your 2FA secrets unencrypted. Store it securely and never share it.',
    confirmText: 'Export Backup',
    tone: 'warning',
    icon: 'warning'
  });
  if (!res.confirmed) return;

  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(currentVaultData, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute('href', dataStr);
  downloadAnchor.setAttribute('download', `autoauth-backup-${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  showPopupToast('Backup exported!');
});

// Import JSON
const fileInput = document.getElementById('file-import-input');
document.getElementById('btn-import-json').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const imported = JSON.parse(evt.target.result);
      if (!imported.accounts || !Array.isArray(imported.accounts)) {
        throw new Error('Invalid backup file structure.');
      }

      // Merge accounts avoiding duplicate IDs
      const existingIds = new Set(currentVaultData.accounts.map(a => a.id));
      let addedCount = 0;

      imported.accounts.forEach(acc => {
        if (!existingIds.has(acc.id) && acc.secret) {
          currentVaultData.accounts.push(acc);
          existingIds.add(acc.id);
          addedCount++;
        }
      });

      await saveVaultData();
      showPopupToast(`Imported ${addedCount} account(s)!`);
      showView('main');
    } catch (err) {
      await showModal({
        title: 'Import failed',
        message: err.message || 'The selected file is not a valid AutoAuthMe backup.',
        confirmText: 'OK',
        cancelText: null,
        tone: 'danger',
        icon: 'warning'
      });
    }
  };
  reader.readAsText(file);
});

// Wipe Vault
document.getElementById('btn-wipe-vault').addEventListener('click', async () => {
  const res = await showModal({
    title: 'Wipe vault?',
    message: 'This permanently deletes your vault and every 2FA token in it. Make sure you have a backup first.',
    confirmText: 'Wipe Everything',
    tone: 'danger',
    icon: 'warning'
  });
  if (!res.confirmed) return;

  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  currentVaultData = null;
  currentMasterPassword = '';
  showView('setup');
  showPopupToast('Vault wiped');
});

// 9. Keyboard-First Navigation
let kbIndex = -1;

function getVisibleCards() {
  return Array.from(document.querySelectorAll('#accounts-container .account-card'));
}

function setKbSelection(index) {
  const cards = getVisibleCards();
  if (!cards.length) {
    clearKbSelection();
    return;
  }
  kbIndex = Math.max(0, Math.min(index, cards.length - 1));
  cards.forEach((card, i) => card.classList.toggle('kb-selected', i === kbIndex));
  cards[kbIndex].scrollIntoView({ block: 'nearest' });
}

function clearKbSelection() {
  kbIndex = -1;
  document.querySelectorAll('.account-card.kb-selected').forEach(card => card.classList.remove('kb-selected'));
}

function copyCardCode(card) {
  if (!card) return;
  const codeEl = card.querySelector('.otp-code');
  if (!codeEl) return;
  copyCodeToClipboard(codeEl.dataset.code || codeEl.textContent);
  const copyBtn = card.querySelector('.btn-copy-card');
  if (copyBtn) {
    copyBtn.classList.add('copied');
    setTimeout(() => copyBtn.classList.remove('copied'), 1200);
  }
}

function isMainView() {
  return !views.main.classList.contains('hidden');
}

function isTypingTarget(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

document.addEventListener('keydown', (e) => {
  // The modal owns the keyboard while open
  if (modalState) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal({ confirmed: false, value: null });
    } else if (e.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON') {
      e.preventDefault();
      handleModalConfirm();
    } else if (e.key === 'Tab') {
      trapModalFocus(e);
    }
    return;
  }

  // Ctrl/Cmd + K jumps to search
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (isMainView()) {
      searchInput.focus();
      searchInput.select();
    }
    return;
  }

  // Esc backs out of the Add / Settings views
  if (!isMainView()) {
    if (e.key === 'Escape' && !isTypingTarget(document.activeElement)) {
      if (!views.add.classList.contains('hidden') || !views.settings.classList.contains('hidden')) {
        showView('main');
      }
    }
    return;
  }

  const active = document.activeElement;
  const typing = isTypingTarget(active);

  // Esc clears the search first, then drops the selection
  if (e.key === 'Escape') {
    if (active === searchInput && searchInput.value) {
      e.preventDefault();
      searchInput.value = '';
      searchQuery = '';
      clearSearchBtn.classList.add('hidden');
      searchHint.classList.add('hidden'); // field stays focused, so keep the hint hidden
      renderAccounts();
      return;
    }
    clearKbSelection();
    if (active === searchInput) searchInput.blur();
    return;
  }

  // Arrow keys move the card selection
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const cards = getVisibleCards();
    if (!cards.length) return;
    e.preventDefault();
    if (e.key === 'ArrowDown') {
      setKbSelection(kbIndex === -1 ? 0 : kbIndex + 1);
    } else {
      setKbSelection(kbIndex === -1 ? cards.length - 1 : kbIndex - 1);
    }
    return;
  }

  // Enter copies the highlighted code (or the top result while searching)
  if (e.key === 'Enter') {
    if (active?.tagName === 'BUTTON') return; // let focused buttons act normally
    if (typing && active !== searchInput) return;
    const cards = getVisibleCards();
    if (!cards.length) return;
    const target = kbIndex >= 0 ? cards[kbIndex] : cards[0];
    copyCardCode(target);
    if (kbIndex === -1) setKbSelection(0);
    return;
  }

  // "/" focuses the search box
  if (e.key === '/' && !typing) {
    e.preventDefault();
    searchInput.focus();
    return;
  }

  // Type-to-search: any letter or number starts a search instantly
  if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
    e.preventDefault();
    searchInput.focus();
    searchInput.value += e.key;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

// Start initialization
document.addEventListener('DOMContentLoaded', initApp);
