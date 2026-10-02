// Drive the deck through a short demo and take high-resolution screenshots of it (for docs, thumbnails, posts).
//   node produce/snap-deck.mjs <trackA> <trackB> [trackC] [trackD] [--scale 2] [--out .dj/produce/out/shots]
// Opens the page in its own Playwright Chromium (which becomes the sound system, so this PLAYS AUDIO), then loads the
// tracks, plays, mutes stems, rolls a loop, blends A→B, brings up four decks, and snaps a PNG at each step.
// Track arguments are library ids or search text (anything `dj load` accepts).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2); const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const tracks = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (tracks.length < 2) { console.log('usage: snap-deck.mjs <trackA> <trackB> [trackC] [trackD] [--scale 2]'); process.exit(1); }
const OUT = flag('--out', '.dj/produce/out/shots'); fs.mkdirSync(OUT, { recursive: true });
const SCALE = Number(flag('--scale', 2));
async function loadPlaywright() { try { return await import('playwright'); } catch { /* */ } const root = execSync('npm root -g', { encoding: 'utf8' }).trim(); for (const n of ['playwright', 'playwright-core']) { const p = path.join(root, n, 'index.mjs'); if (fs.existsSync(p)) return import(pathToFileURL(p).href); } throw new Error('Playwright not found'); }
const { chromium } = await loadPlaywright();
const dj = (...a) => { try { return execFileSync(process.execPath, ['dj.mjs', ...a], { encoding: 'utf8', windowsHide: true, timeout: 60000 }); } catch (e) { console.log('dj', a.join(' '), '→', (e.stderr || e.message).toString().split('\n')[0]); return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launch = { headless: false, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1940,1140', '--window-position=0,0'] };
if (process.env.PLAYWRIGHT_CHROMIUM) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(launch);
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE })).newPage();
await page.goto(process.env.DJ_URL || 'http://localhost:4747/', { waitUntil: 'domcontentloaded' });
await page.click('#startBtn', { timeout: 15000 }); await sleep(1500);
let n = 0; const snap = async (name) => { await sleep(400); const f = path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`); await page.screenshot({ path: f }); console.log('📸', f); };
for (const D of ['A', 'B', 'C', 'D']) { dj('pause', D); dj('loop', D, '0'); dj('xfassign', D, 'thru'); }
dj('xfade', '0.5'); dj('master', '0.9');
dj('load', 'A', tracks[0]); dj('load', 'B', tracks[1]); await sleep(4000);
dj('seek', 'A', 'bar:17'); dj('play', 'A', '--why', 'Opening on the groove, letting the room settle in.'); await sleep(7000);
await snap('deck-a-playing');
dj('stem', 'A', 'vocals', '0'); dj('stem', 'A', 'other', '0.4'); dj('say', 'Vocals out, just the groove.'); await sleep(2500);
await snap('stems');
dj('loop', 'A', '2'); await sleep(1800); dj('loop', 'A', '1'); await sleep(900); dj('loop', 'A', '0.5'); await sleep(600);
await snap('loop-roll');
dj('loop', 'A', '0'); dj('loop', 'A', '0'); dj('stem', 'A', 'other', '1');
dj('mix', 'A', 'B', '--style', 'bassswap', '--bars', '16', '--at', 'bar', '--in', 'intro', '--why', 'Same key, +1 BPM: bass swap on the phrase so the kick never drops out.'); await sleep(12000);
await snap('blend-a-to-b');
await sleep(14000); await snap('b-live');
if (tracks[2]) { dj('load', 'C', tracks[2]); } if (tracks[3]) { dj('load', 'D', tracks[3]); } await sleep(4000);
if (tracks[2]) { dj('stem', 'C', 'drums', '0'); dj('stem', 'C', 'bass', '0'); dj('vol', 'C', '0.8'); dj('play', 'C', '--at', 'bar', '--why', 'Melody layer from deck C over the live beat.'); await sleep(6000); await snap('four-decks'); }
dj('filter', 'B', '-0.6', '--ramp', '8'); dj('say', 'Filter down… and back on the drop.'); await sleep(4500); await snap('filter-sweep'); dj('filter', 'B', '0', '--ramp', '4');
await sleep(3000); await snap('wide');
for (const D of ['A', 'B', 'C', 'D']) { dj('pause', D); dj('loop', D, '0'); dj('filter', D, '0'); dj('stem', D, 'all', '1'); }
await browser.close();
console.log(`done: ${n} screenshots in ${OUT} (${1920 * SCALE}×${1080 * SCALE}). The engine window closed: click Start engine in a browser tab to keep playing.`);
