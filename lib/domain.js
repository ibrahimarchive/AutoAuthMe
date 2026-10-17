/**
 * Secure Domain Matching Engine for AutoAuthMe
 * Protects against phishing attacks by strictly enforcing hostname and subdomain validation.
 */

/**
 * Normalizes host/domain string.
 * Strips protocol, port, path, query, and leading/trailing whitespace or dots.
 */
export function normalizeDomain(raw) {
  if (!raw) return '';
  let str = String(raw).trim().toLowerCase();
  // Strip protocol
  str = str.replace(/^https?:\/\//i, '');
  // Strip path and query
  str = str.split('/')[0].split('?')[0].split('#')[0];
  // Strip port
  str = str.split(':')[0];
  // Strip leading/trailing dots
  str = str.replace(/^\.+|\.+$/g, '');
  return str;
}

/**
 * Checks if currentHostname matches targetDomain safely (exact match or genuine subdomain).
 * Example: "auth.github.com" matches "github.com", but "notgithub.com" or "evil-github.com" DOES NOT.
 */
export function isDomainMatch(targetDomain, currentHostname) {
  const target = normalizeDomain(targetDomain);
  const current = normalizeDomain(currentHostname);
  if (!target || !current) return false;

  if (current === target) return true;
  if (current.endsWith('.' + target)) return true;
  return false;
}

/**
 * Safely evaluates whether a 2FA account matches a given page hostname.
 */
export function matchAccountDomain(account, rawDomain) {
  if (!account || !rawDomain) return false;
  const pageHostname = normalizeDomain(rawDomain);
  if (!pageHostname) return false;

  // 1. Explicit domain list configured on the account
  if (Array.isArray(account.domains)) {
    for (const d of account.domains) {
      if (isDomainMatch(d, pageHostname)) {
        return true;
      }
    }
  }

  // 2. Issuer domain (if issuer looks like a domain, e.g. "github.com" or "aws.amazon.com")
  const issuer = (account.issuer || '').trim();
  if (issuer) {
    const normIssuer = normalizeDomain(issuer);
    if (normIssuer && normIssuer.includes('.') && isDomainMatch(normIssuer, pageHostname)) {
      return true;
    }
  }

  // 3. Email domain on account (e.g., user@company.com matches company.com or auth.company.com)
  const acc = (account.account || '').toLowerCase();
  if (acc.includes('@')) {
    const parts = acc.split('@');
    const emailDomain = normalizeDomain(parts[parts.length - 1]);
    // Prevent generic webmail providers from matching
    const publicMailProviders = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'proton.me', 'protonmail.com'];
    if (emailDomain && !publicMailProviders.includes(emailDomain)) {
      if (isDomainMatch(emailDomain, pageHostname)) {
        return true;
      }
    }
  }

  return false;
}
