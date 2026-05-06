// E2EE primitives using Web Crypto.
//
// Design:
// - Each user has an ECDH P-256 keypair. The public key (SPKI) is published.
// - The private key (PKCS8) is encrypted with a PBKDF2(password)-derived AES-GCM key
//   and stored on the server. On login, the client downloads the bundle and
//   decrypts in-browser; the server never sees the plaintext private key.
// - For a DM, both clients independently derive the same AES-GCM key via ECDH
//   from their own private key and the peer's public key. Each message uses a
//   fresh 12-byte random IV.
//
// Limitations (acceptable for MVP, fix later):
// - One static shared key per DM — no forward secrecy / ratcheting.
// - Trust-on-first-use for peer public keys; no out-of-band fingerprint check.

const subtle = crypto.subtle;
const PBKDF2_ITERATIONS = 200_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = {
  encode(buf) {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  },
  decode(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  },
};

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function deriveKeyFromPassword(password, salt) {
  const baseKey = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Generate an identity keypair and return a serializable bundle.
// keySalt + encryptedPrivateKey + encryptedPrivateKeyNonce go to the server.
// publicKey is what other users see. privateKey is kept in-memory.
export async function createIdentity(password) {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const pubSpki = new Uint8Array(await subtle.exportKey('spki', kp.publicKey));
  const privPkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));

  const keySalt = randomBytes(16);
  const wrapKey = await deriveKeyFromPassword(password, keySalt);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, wrapKey, privPkcs8));

  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    serverBundle: {
      publicKey: b64.encode(pubSpki),
      encryptedPrivateKey: b64.encode(ct),
      encryptedPrivateKeyNonce: b64.encode(nonce),
      keySalt: b64.encode(keySalt),
    },
  };
}

// Restore the keypair given the password and the bundle the server returned.
export async function unlockIdentity(password, bundle) {
  const salt = b64.decode(bundle.keySalt);
  const wrapKey = await deriveKeyFromPassword(password, salt);
  const nonce = b64.decode(bundle.encryptedPrivateKeyNonce);
  const ct = b64.decode(bundle.encryptedPrivateKey);
  let privPkcs8;
  try {
    privPkcs8 = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, wrapKey, ct));
  } catch {
    throw new Error('failed to decrypt private key (wrong password or tampered bundle)');
  }
  const privateKey = await subtle.importKey('pkcs8', privPkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
  const publicKey = await importPublicKey(bundle.publicKey);
  return { privateKey, publicKey };
}

export async function importPublicKey(b64Spki) {
  const spki = b64.decode(b64Spki);
  return subtle.importKey('spki', spki, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

// Derive the shared AES-GCM key for a DM, given peer's public key.
async function deriveDmKey(myPrivateKey, peerPublicKey) {
  return subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    myPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Cache derived keys per peer so we don't redo ECDH on every message.
const dmKeyCache = new WeakMap(); // peerPublicKey CryptoKey -> Promise<aesKey>
function getDmKey(myPrivateKey, peerPublicKey) {
  let p = dmKeyCache.get(peerPublicKey);
  if (!p) {
    p = deriveDmKey(myPrivateKey, peerPublicKey);
    dmKeyCache.set(peerPublicKey, p);
  }
  return p;
}

export async function encryptForPeer(myPrivateKey, peerPublicKey, plaintext) {
  const key = await getDmKey(myPrivateKey, peerPublicKey);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, enc.encode(plaintext)));
  return { ciphertext: b64.encode(ct), nonce: b64.encode(nonce) };
}

export async function decryptFromPeer(myPrivateKey, peerPublicKey, ciphertextB64, nonceB64) {
  const key = await getDmKey(myPrivateKey, peerPublicKey);
  const nonce = b64.decode(nonceB64);
  const ct = b64.decode(ciphertextB64);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct);
  return dec.decode(pt);
}
