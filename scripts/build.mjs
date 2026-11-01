// Build: compile src/ to dist/ with tsc, then assemble artifact/ (a copy of the page that can be
// published as a single claude.ai artifact or served from any static host).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

rmSync('dist', { recursive: true, force: true });
execFileSync('tsc', ['-p', '.'], { stdio: 'inherit' });

rmSync('artifact', { recursive: true, force: true });
mkdirSync('artifact', { recursive: true });
cpSync('dist', 'artifact/dist', { recursive: true });
cpSync('styles.css', 'artifact/styles.css');
const html = readFileSync('index.html', 'utf8');
const head = html.match(/<title>[\s\S]*?<link rel="stylesheet" href="styles.css">/)[0];
const body = html.match(/<!--GAME-->([\s\S]*?)<!--\/GAME-->/)[1];
const script = html.match(/<script type="module"[^>]*><\/script>/)[0];
// The artifact host supplies doctype, html, head and body, so the page is just its content.
writeFileSync('artifact/index.html', `${head}\n${body}\n${script}\n`);

// site/: the full standalone page for a static host (Vercel serves this at temasek.natwong.dev).
rmSync('site', { recursive: true, force: true });
mkdirSync('site', { recursive: true });
cpSync('dist', 'site/dist', { recursive: true });
cpSync('styles.css', 'site/styles.css');
cpSync('index.html', 'site/index.html');

const files = [];
const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
walk('artifact');
const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`built dist/, site/ and artifact/ (${files.length} files, ${(bytes / 1024).toFixed(0)} KB)`);
