/**
 * Web Crypto API utilities for Master Password vault encryption (AES-256-GCM + PBKDF2)
 */

const PBKDF2_RECOMMENDED_ITERATIONS = 310000;
const PBKDF2_LEGACY_ITERATIONS = 100000;
const HASH_ALGO = 'SHA-256';
const CIPHER_ALGO = 'AES-GCM';
const KEY_LENGTH = 256;

// Convert Uint8Array to Hex string
export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Convert Hex string to Uint8Array
export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Derives an AES-GCM CryptoKey from a password string and a salt.
 */
export async function deriveKeyFromPassword(password, salt, iterations = PBKDF2_RECOMMENDED_ITERATIONS) {
  const enc = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: iterations,
      hash: HASH_ALGO
    },
    passwordKey,
    { name: CIPHER_ALGO, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts an arbitrary Javascript object using a master password.
 * Returns an object with { saltHex, ivHex, ciphertextHex, iterations, updatedAt }.
 */
export async function encryptVault(data, password, iterations = PBKDF2_RECOMMENDED_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPassword(password, salt, iterations);

  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(data));

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: CIPHER_ALGO, iv: iv },
    key,
    plaintext
  );

  return {
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(ciphertextBuffer)),
    iterations: iterations,
    updatedAt: Date.now()
  };
}

/**
 * Decrypts a vault using the master password.
 * Throws an error if decryption fails (wrong password or altered ciphertext).
 */
export async function decryptVault(encryptedVault, password) {
  if (!encryptedVault || !encryptedVault.salt || !encryptedVault.iv || !encryptedVault.ciphertext) {
    throw new Error('Invalid vault package');
  }

  const salt = hexToBytes(encryptedVault.salt);
  const iv = hexToBytes(encryptedVault.iv);
  const ciphertext = hexToBytes(encryptedVault.ciphertext);
  const iterations = encryptedVault.iterations || PBKDF2_LEGACY_ITERATIONS;

  const key = await deriveKeyFromPassword(password, salt, iterations);

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: CIPHER_ALGO, iv: iv },
      key,
      ciphertext
    );

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decryptedBuffer));
  } catch (err) {
    throw new Error('Incorrect master password or corrupted data');
  }
}
