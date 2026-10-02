// Record the Claude DJ page with Playwright while it plays: opens http://localhost:4747 in its own maximised Chromium,
// clicks "Start engine" (so this window becomes the sound system) and records the page to a .webm.
//
//   node produce/record-browser.mjs            start (runs until stopped)
//   node produce/record-browser.mjs --stop     stop a running recorder (finalises the .webm)
//
// Writes .dj/produce/out/screen/browser.json {start, file, ready, done} — `start` is the epoch ms the video began, which
// produce/make-video.mjs uses to line the footage up with an exported set.
// Needs Playwright (`npm i -g playwright && npx playwright install chromium`, or a local install). Set PLAYWRIGHT_CHROMIUM
// to a chrome.exe/chromium path to use a specific build. Start this BEFORE loading decks: taking over the engine resets them.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DIR = '.dj/produce/out/screen', STOP = path.join(DIR, 'stop'), INFO = path.join(DIR, 'browser.json');
fs.mkdirSync(DIR, { recursive: true });
if (process.argv.includes('--stop')) { fs.writeFileSync(STOP, ''); console.log('stop requested'); process.exit(0); }
fs.rmSync(STOP, { force: true });

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not local */ }
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  for (const name of ['playwright', 'playwright-core']) { const p = path.join(root, name, 'index.mjs'); if (fs.existsSync(p)) return import(pathToFileURL(p).href); }
  throw new Error('Playwright not found: npm i -g playwright && npx playwright install chromium');
}
const { chromium } = await loadPlaywright();
const URL = process.env.DJ_URL || 'http://localhost:4747/';
const W = 1280, H = 852; // recorded size (3:2, close to a maximised 1664×1040 page)
const launch = { headless: false, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--start-maximized'] };
if (process.env.PLAYWRIGHT_CHROMIUM) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: null, recordVideo: { dir: DIR, size: { width: W, height: H } } });
const start = Date.now();
const page = await context.newPage();
const file = path.resolve(await page.video().path());
fs.writeFileSync(INFO, JSON.stringify({ start, file, ready: false }));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.click('#startBtn', { timeout: 15000 });
for (let i = 0; i < 60; i++) { const hidden = await page.evaluate(() => { const o = document.querySelector('#startOverlay'); return !o || o.hidden || getComputedStyle(o).display === 'none' || getComputedStyle(o).opacity === '0'; }); if (hidden) break; await new Promise((r) => setTimeout(r, 500)); }
fs.writeFileSync(INFO, JSON.stringify({ start, file, ready: true, pid: process.pid }));
console.log(`recording ${file}\nthis Chromium window is now the sound system; stop with: node produce/record-browser.mjs --stop`);
let closing = false;
async function finish() { if (closing) return; closing = true; try { await context.close(); await browser.close(); } catch { /* */ } fs.writeFileSync(INFO, JSON.stringify({ start, file, ready: true, done: true })); process.exit(0); }
process.on('SIGINT', finish); process.on('SIGTERM', finish);
browser.on('disconnected', () => { if (!closing) { fs.writeFileSync(INFO, JSON.stringify({ start, file, ready: true, done: true, closed: 'browser' })); process.exit(0); } });
while (!fs.existsSync(STOP)) await new Promise((r) => setTimeout(r, 500));
await finish();
