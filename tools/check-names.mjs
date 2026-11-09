// Fails when the product's old name ("Piper TTS", in any spelling) appears in
// a tracked file. VoiceDock is the name; the engine is just "Piper".
//
//   npm run check:names
//
// A line that must keep the old name for back-compat (a legacy file name the
// code still reads, a migration note) says so with the marker `legacy-name`
// on the same line. Generated history (CHANGELOG.md, lock files) is skipped.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OLD_NAME = /piper[ _-]?tts|pipertts/i;
const MARKER = 'legacy-name';
const SKIP = [/(^|\/)CHANGELOG\.md$/, /(^|\/)package-lock\.json$/, /\.(png|ico|jpg|jpeg|gif|webp|woff2?|onnx|bin|zip)$/i];

export function findOldNames(path, text) {
  if (path === 'tools/check-names.mjs') return [];
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (OLD_NAME.test(line) && !line.includes(MARKER)) hits.push({ path, line: i + 1, text: line.trim() });
  });
  return hits;
}

export function checkRepo(root = repoRoot) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  return files
    .filter((path) => !SKIP.some((re) => re.test(path)))
    .flatMap((path) => {
      let text;
      try { text = readFileSync(join(root, path), 'utf8'); } catch { return []; }
      return findOldNames(path, text);
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = checkRepo();
  if (hits.length) {
    console.error('The old product name is back. Say "VoiceDock" (or "Piper" for the engine):');
    for (const hit of hits) console.error(`  ${hit.path}:${hit.line}: ${hit.text.slice(0, 160)}`);
    console.error(`If a line must keep it for back-compat, add the marker "${MARKER}" on that line.`);
    process.exit(1);
  }
  console.log('No old product names.');
}
