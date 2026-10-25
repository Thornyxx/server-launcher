#!/usr/bin/env node
/**
 * Génère manifest.json à partir du dossier files/ (+ fichiers externes).
 * Usage : node tools/build-manifest.mjs   (lancé automatiquement par l'Action GitHub)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.config.json'), 'utf8'));
const filesDir = cfg.filesDir || 'files';
const outFile = path.join(ROOT, 'manifest.json');

function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`);
}
const once = (cfg.once || []).map(globToRegex);
const policyFor = (p) => (once.some((re) => re.test(p)) ? 'once' : 'always');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue; // .gitkeep, .DS_Store…
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

const entries = [];

// 1. Fichiers hébergés dans le dépôt
const base = path.join(ROOT, filesDir);
for (const full of walk(base)) {
  const rel = path.relative(base, full).split(path.sep).join('/');
  const buf = fs.readFileSync(full);
  if (buf.length > 95 * 1024 * 1024) {
    console.warn(`⚠ ${rel} fait plus de 95 Mo : GitHub refusera le push, mets-le dans "external".`);
  }
  entries.push({ path: rel, url: `${filesDir}/${encodePath(rel)}`, sha1: sha1(buf), size: buf.length, policy: policyFor(rel) });
}

// 2. Fichiers externes (Modrinth, CurseForge CDN, ton VPS…)
for (const ext of cfg.external || []) {
  if (ext.disabled) continue;
  if (!ext.path || !ext.url) throw new Error(`external : "path" et "url" obligatoires (${JSON.stringify(ext)})`);
  let { sha1: hash, size } = ext;
  if (!hash || !size) {
    process.stdout.write(`↓ ${ext.url} … `);
    const res = await fetch(ext.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${ext.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    hash = sha1(buf);
    size = buf.length;
    console.log('ok');
  }
  if (entries.some((e) => e.path === ext.path)) throw new Error(`Doublon : ${ext.path} est à la fois dans ${filesDir}/ et dans external`);
  entries.push({ path: ext.path, url: ext.url, sha1: hash.toLowerCase(), size, policy: ext.policy || policyFor(ext.path) });
}

entries.sort((a, b) => a.path.localeCompare(b.path));

const manifest = {
  version: 1,
  managedDirs: cfg.managedDirs || ['mods'],
  keep: cfg.keep || [],
  files: entries
};

// On ne réécrit le fichier que si le contenu change (évite des commits vides).
const strip = (m) => JSON.stringify({ ...m, generatedAt: undefined });
let previous = null;
try { previous = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* premier passage */ }
if (previous && strip(previous) === strip(manifest)) {
  console.log(`manifest.json déjà à jour (${entries.length} fichiers).`);
} else {
  fs.writeFileSync(outFile, JSON.stringify({ ...manifest, generatedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`manifest.json généré : ${entries.length} fichiers.`);
}
