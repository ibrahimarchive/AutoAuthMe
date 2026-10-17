import { base32ToUint8Array, uint8ArrayToBase32 } from './base32.js';

/**
 * Standard RFC 6238 Time-Based One-Time Password (TOTP) generator using Web Crypto API.
 */

/**
 * Maps algorithm name to Web Crypto hash format.
 */
function getHashAlgo(algoName) {
  const norm = (algoName || 'SHA1').toUpperCase().replace('-', '');
  if (norm === 'SHA256') return 'SHA-256';
  if (norm === 'SHA512') return 'SHA-512';
  return 'SHA-1'; // Default RFC 6238 standard
}

/**
 * Generates an HMAC hash for given key and 8-byte counter buffer.
 */
async function generateHmac(keyBytes, counterBytes, hashAlgo) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: { name: hashAlgo } },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, counterBytes);
  return new Uint8Array(signature);
}

/**
 * Calculates current TOTP code.
 * @param {string} secretBase32 - Secret key in Base32 format
 * @param {object} options - { period = 30, digits = 6, algorithm = 'SHA1', timestamp = Date.now() }
 * @returns {Promise<string>} e.g. "492014"
 */
export async function generateTOTP(secretBase32, options = {}) {
  const period = options.period || 30;
  const digits = options.digits || 6;
  const algorithm = getHashAlgo(options.algorithm);
  const timestamp = options.timestamp !== undefined ? options.timestamp : Date.now();

  const epochSeconds = Math.floor(timestamp / 1000);
  const timeStep = Math.floor(epochSeconds / period);

  // Convert time step into 8-byte big-endian Uint8Array
  const counterBuffer = new Uint8Array(8);
  let temp = timeStep;
  for (let i = 7; i >= 0; i--) {
    counterBuffer[i] = temp & 0xff;
    temp = Math.floor(temp / 256);
  }

  const keyBytes = base32ToUint8Array(secretBase32);
  const hmac = await generateHmac(keyBytes, counterBuffer, algorithm);

  // RFC 4226 Dynamic Truncation
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binaryCode =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) >>> 0;

  const otp = binaryCode % Math.pow(10, digits);
  return otp.toString().padStart(digits, '0');
}

/**
 * Returns remaining seconds in the current cycle and fraction of elapsed time.
 */
export function getRemainingSeconds(period = 30, timestamp = Date.now()) {
  const epochSeconds = Math.floor(timestamp / 1000);
  const remaining = period - (epochSeconds % period);
  const progressFraction = remaining / period; // 1 -> 0
  return { remaining, progressFraction, period };
}

/**
 * Parses an otpauth://totp/ URI.
 * Example: otpauth://totp/GitHub:user?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA1&digits=6&period=30
 */
export function parseOtpAuthUri(uriString) {
  try {
    const url = new URL(uriString.trim());
    if (url.protocol !== 'otpauth:') {
      throw new Error('Protocol must be otpauth:');
    }

    const type = url.host.toLowerCase();
    if (type !== 'totp') {
      throw new Error('Only TOTP (time-based) accounts are supported currently');
    }

    // Path format is usually /Issuer:Account or /Account
    let label = decodeURIComponent(url.pathname.replace(/^\//, ''));
    let issuer = url.searchParams.get('issuer') || '';
    let account = label;

    if (label.includes(':')) {
      const parts = label.split(':');
      if (!issuer) {
        issuer = parts[0].trim();
      }
      account = parts.slice(1).join(':').trim();
    }

    const secret = url.searchParams.get('secret');
    if (!secret) {
      throw new Error('Missing secret parameter');
    }

    const algorithm = (url.searchParams.get('algorithm') || 'SHA1').toUpperCase();
    const digits = parseInt(url.searchParams.get('digits') || '6', 10);
    const period = parseInt(url.searchParams.get('period') || '30', 10);

    return {
      issuer: issuer || 'Unknown Issuer',
      account: account || 'Account',
      secret: secret.trim(),
      algorithm,
      digits,
      period
    };
  } catch (err) {
    throw new Error(`Invalid otpauth URI: ${err.message}`);
  }
}

/**
 * Parses Google Authenticator export QR code format:
 * otpauth-migration://offline?data=...
 * Extracts and decodes all accounts from the Protobuf payload.
 */
export function parseGoogleAuthMigrationUri(uriString) {
  try {
    const url = new URL(uriString.trim());
    if (url.protocol !== 'otpauth-migration:') {
      throw new Error('Protocol must be otpauth-migration:');
    }

    const rawData = url.searchParams.get('data');
    if (!rawData) {
      throw new Error('Missing data parameter in migration URI');
    }

    // Decode Base64
    const binaryString = atob(rawData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    let pos = 0;
    function readVarint() {
      let result = 0;
      let shift = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        result |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      return result;
    }

    const accounts = [];
    const textDecoder = new TextDecoder();

    while (pos < bytes.length) {
      const key = readVarint();
      const fieldNumber = key >>> 3;
      const wireType = key & 0x07;

      if (fieldNumber === 1 && wireType === 2) {
        // OtpParameters message
        const len = readVarint();
        const end = pos + len;
        let secretBytes = null;
        let name = '';
        let issuer = '';
        let algorithm = 'SHA1';
        let digits = 6;

        while (pos < end) {
          const pKey = readVarint();
          const pField = pKey >>> 3;
          const pWire = pKey & 0x07;

          if (pField === 1 && pWire === 2) {
            // secret (raw bytes)
            const sLen = readVarint();
            secretBytes = bytes.subarray(pos, pos + sLen);
            pos += sLen;
          } else if (pField === 2 && pWire === 2) {
            // name (e.g. "GitHub:username" or "user@gmail.com")
            const nLen = readVarint();
            name = textDecoder.decode(bytes.subarray(pos, pos + nLen));
            pos += nLen;
          } else if (pField === 3 && pWire === 2) {
            // issuer (e.g. "GitHub")
            const iLen = readVarint();
            issuer = textDecoder.decode(bytes.subarray(pos, pos + iLen));
            pos += iLen;
          } else if (pField === 4 && pWire === 0) {
            // algorithm (1: SHA1, 2: SHA256, 3: SHA512)
            const algoCode = readVarint();
            if (algoCode === 2) algorithm = 'SHA256';
            else if (algoCode === 3) algorithm = 'SHA512';
            else algorithm = 'SHA1';
          } else if (pField === 5 && pWire === 0) {
            // digits (1: 6 digits, 2: 8 digits)
            const dCode = readVarint();
            digits = dCode === 2 ? 8 : 6;
          } else if (pWire === 0) {
            readVarint();
          } else if (pWire === 2) {
            const skip = readVarint();
            pos += skip;
          }
        }

        if (secretBytes && secretBytes.length > 0) {
          const secretBase32 = uint8ArrayToBase32(secretBytes);
          let accountName = name;
          if (name.includes(':')) {
            const parts = name.split(':');
            if (!issuer) issuer = parts[0].trim();
            accountName = parts.slice(1).join(':').trim();
          }
          accounts.push({
            issuer: issuer || 'Google Authenticator',
            account: accountName || 'Account',
            secret: secretBase32,
            algorithm,
            digits,
            period: 30
          });
        }
      } else if (wireType === 0) {
        readVarint();
      } else if (wireType === 2) {
        const skip = readVarint();
        pos += skip;
      }
    }

    if (accounts.length === 0) {
      throw new Error('No valid TOTP accounts found in migration data');
    }

    return accounts;
  } catch (err) {
    throw new Error(`Invalid Google Authenticator migration URI: ${err.message}`);
  }
}

/**
 * Format 6-digit OTP code with a space in the middle for easier visual scanning (e.g., "123 456")
 */
export function formatCode(code) {
  if (!code) return '------';
  if (code.length === 6) {
    return `${code.slice(0, 3)} ${code.slice(3)}`;
  }
  if (code.length === 8) {
    return `${code.slice(0, 4)} ${code.slice(4)}`;
  }
  return code;
}

