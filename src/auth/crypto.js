/**
 * AES-GCM encryption for KV-stored Webflow access tokens (S9).
 *
 * Requires TOKEN_ENC_KEY secret — a 64-char hex string (32 bytes).
 * Set it with: npx wrangler secret put TOKEN_ENC_KEY
 */

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function importKey(keyHex) {
  return crypto.subtle.importKey(
    'raw',
    hexToBytes(keyHex),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptPayload(plaintext, env) {
  if (!env.TOKEN_ENC_KEY) return plaintext; // graceful no-op if secret not set
  const key = await importKey(env.TOKEN_ENC_KEY);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  // Prefix with iv (12 bytes) so we can decrypt later
  const combined = new Uint8Array(12 + enc.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(enc), 12);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptPayload(ciphertext, env) {
  if (!env.TOKEN_ENC_KEY) return ciphertext; // graceful no-op
  try {
    const bytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    const iv    = bytes.slice(0, 12);
    const data  = bytes.slice(12);
    const key   = await importKey(env.TOKEN_ENC_KEY);
    const dec   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(dec);
  } catch {
    // Key rotation: if decryption fails, try treating as plaintext (old record)
    return ciphertext;
  }
}
