#!/usr/bin/env node
// Signs the engine catalog (servers/catalog/engines.json) with the VoiceDock
// catalog key, in minisign's format, so the hub (and N8 Tray) install only
// downloads the owner listed.
//
//   node tools/catalog-sign.mjs sign      sign engines.json (bumps nothing: edit "serial" first)
//   node tools/catalog-sign.mjs verify    check the committed signature (CI runs this)
//   node tools/catalog-sign.mjs keygen    make a new key pair (only to replace the key)
//
// The secret key lives outside the repo, in ~/.config/voicedock/catalog-signing.key
// (VOICEDOCK_CATALOG_KEY overrides). The public key is
// servers/catalog/voicedock-catalog.pub and is built into the hub.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const minisign = require('../servers/piper/hub/minisign.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalogFile = join(root, 'servers', 'catalog', 'engines.json');
const signatureFile = `${catalogFile}.minisig`;
const publicFile = join(root, 'servers', 'catalog', 'voicedock-catalog.pub');
const secretFile = process.env.VOICEDOCK_CATALOG_KEY || join(homedir(), '.config', 'voicedock', 'catalog-signing.key');

const command = process.argv[2];
if (command === 'keygen') {
  if (existsSync(secretFile)) {
    console.error(`A key already exists at ${secretFile}. Move it away first to replace it.`);
    process.exit(1);
  }
  const pair = minisign.generateKeyPair();
  mkdirSync(dirname(secretFile), { recursive: true, mode: 0o700 });
  writeFileSync(secretFile, minisign.secretKeyFile(pair), { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  writeFileSync(publicFile, minisign.publicKeyFile(pair));
  console.log(`Secret key: ${secretFile} (back it up; never commit it)\nPublic key: ${publicFile}`);
} else if (command === 'sign') {
  const data = readFileSync(catalogFile);
  const catalog = JSON.parse(data);
  const secret = minisign.parseSecretKey(readFileSync(secretFile, 'utf8'));
  const trustedComment = `voicedock-catalog serial:${catalog.serial} issued:${catalog.issuedAt}`;
  writeFileSync(signatureFile, minisign.sign(data, secret, { trustedComment }));
  minisign.verify(data, readFileSync(signatureFile, 'utf8'), readFileSync(publicFile, 'utf8'));
  console.log(`Signed ${catalogFile} (${trustedComment})`);
} else if (command === 'verify') {
  const data = readFileSync(catalogFile);
  const { trustedComment } = minisign.verify(data, readFileSync(signatureFile, 'utf8'), readFileSync(publicFile, 'utf8'));
  const catalog = JSON.parse(data);
  if (!trustedComment.includes(`serial:${catalog.serial} `)) {
    console.error(`The signature is for another serial (${trustedComment}); sign again.`);
    process.exit(1);
  }
  console.log(`Catalog signature OK (${trustedComment})`);
} else {
  console.error('Usage: node tools/catalog-sign.mjs sign | verify | keygen');
  process.exit(2);
}
