/**
 * RFC 4648 Base32 Decoder / Encoder
 */
const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32ToUint8Array(base32String) {
  if (!base32String) return new Uint8Array(0);

  // Clean string: remove spaces, hyphens, and padding '='
  const clean = base32String.toUpperCase().replace(/[\s\-=]/g, '');
  const length = clean.length;
  
  let bits = 0;
  let value = 0;
  let index = 0;
  const output = new Uint8Array(Math.floor((length * 5) / 8));

  for (let i = 0; i < length; i++) {
    const val = RFC4648_ALPHABET.indexOf(clean[i]);
    if (val === -1) {
      throw new Error(`Invalid Base32 character: "${clean[i]}"`);
    }

    value = (value << 5) | val;
    bits += 5;

    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }

  return output.subarray(0, index);
}

export function uint8ArrayToBase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      output += RFC4648_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += RFC4648_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}
