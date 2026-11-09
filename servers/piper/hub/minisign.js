/**
 * minisign signatures (https://jedisct1.github.io/minisign/), verified with
 * Node's own Ed25519, so the hub needs no extra package and anyone can check a
 * catalog with the minisign tool:
 *
 *   minisign -Vm engines.json -p voicedock-catalog.pub
 *
 * Public key: "untrusted comment: ..." then base64("Ed" || key id (8) || key (32)).
 * Signature:  "untrusted comment: ..." then base64("ED" || key id || sig (64)),
 *             where sig signs BLAKE2b-512 of the file (prehashed), then
 *             "trusted comment: ..." and base64(global sig), which signs
 *             sig || the trusted comment, so the comment can't be swapped.
 *
 * sign() and generateKeyPair() exist for tools/catalog-sign.mjs; the hub
 * only verifies.
 */

const crypto = require("crypto");

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function publicKeyObject(raw) {
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(raw) }, format: "jwk" });
}

function privateKeyObject(rawSeed, rawPublic) {
  return crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64url(rawSeed), x: b64url(rawPublic) }, format: "jwk" });
}

function commentLine(line, prefix) {
  if (!line || !line.startsWith(prefix)) throw new Error(`expected a line starting with "${prefix}"`);
  return line.slice(prefix.length);
}

// The key line of a public key file (or the bare base64 line).
function parsePublicKey(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const raw = Buffer.from(lines[lines.length - 1].trim(), "base64");
  if (raw.length !== 42 || raw.toString("latin1", 0, 2) !== "Ed") throw new Error("not a minisign public key");
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

function parseSignature(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  commentLine(lines[0], "untrusted comment: ");
  const sig = Buffer.from((lines[1] || "").trim(), "base64");
  const trusted = commentLine(lines[2], "trusted comment: ");
  const global = Buffer.from((lines[3] || "").trim(), "base64");
  if (sig.length !== 74) throw new Error("bad signature length");
  if (global.length !== 64) throw new Error("bad global signature length");
  const algorithm = sig.toString("latin1", 0, 2);
  if (algorithm !== "ED" && algorithm !== "Ed") throw new Error(`unknown signature algorithm ${algorithm}`);
  return { algorithm, keyId: sig.subarray(2, 10), signature: sig.subarray(10, 74), trustedComment: trusted, globalSignature: global };
}

/**
 * Verifies `data` (Buffer) against a minisign signature file's text and a
 * public key file's text. Returns { trustedComment } or throws.
 */
function verify(data, signatureText, publicKeyText) {
  const pub = parsePublicKey(publicKeyText);
  const sig = parseSignature(signatureText);
  if (!pub.keyId.equals(sig.keyId)) throw new Error("signed with a different key");
  const key = publicKeyObject(pub.key);
  const message = sig.algorithm === "ED" ? crypto.createHash("blake2b512").update(data).digest() : data;
  if (!crypto.verify(null, message, key, sig.signature)) throw new Error("signature does not match the file");
  const globalMessage = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!crypto.verify(null, globalMessage, key, sig.globalSignature)) throw new Error("trusted comment signature does not match");
  return { trustedComment: sig.trustedComment };
}

// ─── Signing (tools/catalog-sign.mjs) ──────────────────────────────────────
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const keyId = crypto.randomBytes(8);
  return { keyId, publicKey: x, seed: d };
}

function publicKeyFile({ keyId, publicKey }) {
  const id = Buffer.from(keyId).reverse().toString("hex").toUpperCase();
  return `untrusted comment: minisign public key ${id}\n${Buffer.concat([Buffer.from("Ed", "latin1"), keyId, publicKey]).toString("base64")}\n`;
}

// Our own secret key file (not minisign's encrypted format): the key id,
// public key and seed, base64, readable by the owner only.
function secretKeyFile({ keyId, publicKey, seed }) {
  return `voicedock catalog secret key, keep private\n${Buffer.concat([keyId, publicKey, seed]).toString("base64")}\n`;
}

function parseSecretKey(text) {
  const raw = Buffer.from(String(text).trim().split(/\r?\n/).pop(), "base64");
  if (raw.length !== 72) throw new Error("not a VoiceDock catalog secret key");
  return { keyId: raw.subarray(0, 8), publicKey: raw.subarray(8, 40), seed: raw.subarray(40, 72) };
}

function sign(data, secret, { trustedComment, untrustedComment = "signature from the VoiceDock catalog key" } = {}) {
  if (/[\r\n]/.test(trustedComment || "")) throw new Error("the trusted comment must be one line");
  const key = privateKeyObject(secret.seed, secret.publicKey);
  const signature = crypto.sign(null, crypto.createHash("blake2b512").update(data).digest(), key);
  const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]), key);
  const sigLine = Buffer.concat([Buffer.from("ED", "latin1"), secret.keyId, signature]).toString("base64");
  return `untrusted comment: ${untrustedComment}\n${sigLine}\ntrusted comment: ${trustedComment}\n${global.toString("base64")}\n`;
}

module.exports = { verify, parsePublicKey, parseSignature, generateKeyPair, publicKeyFile, secretKeyFile, parseSecretKey, sign };
