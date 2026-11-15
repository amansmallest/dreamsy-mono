// Screenshot pass: serves a built app with `vite preview`, mocks the API via route interception,
// and captures each screen. Usage:
//   VITE_SUPABASE_URL= VITE_API_URL=http://mock.api vite build --outDir <dist>
//   node scripts/screenshots.mjs <dist> <outDir> [supabaseDist]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { handle } from './mock-api.mjs';

const [dist, out, supaDist] = process.argv.slice(2);
if (!dist || !out) throw new Error('usage: screenshots.mjs <dist> <outDir> [supabaseDist]');
mkdirSync(out, { recursive: true });

async function serve(dir, port) {
  const p = spawn('npx', ['vite', 'preview', '--outDir', dir, '--port', String(port), '--strictPort'], { stdio: 'pipe' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://localhost:${port}/`)).ok) return p; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  p.kill();
  throw new Error('preview did not start');
}

const browser = await chromium.launch();
const procs = [];
try {
  procs.push(await serve(dist, 4317));
  const base = 'http://localhost:4317';

  const ctxFor = async ({ signedIn = true, theme = 'light', width = 1480, height = 940 } = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme });
    await ctx.addInitScript(([s, t]) => {
      if (s) localStorage.setItem('dreamsy.web.guestToken', 'tok_demo');
      localStorage.setItem('dreamsy.theme', t);
    }, [signedIn, theme]);
    await ctx.route('http://mock.api/**', async (route) => {
      const r = route.request();
      const res = handle(r.method(), r.url(), r.headers());
      await route.fulfill({ ...res, headers: { 'access-control-allow-origin': '*' } });
    });
    return ctx;
  };
  const settle = (page, ms = 900) => page.waitForTimeout(ms);
  const shot = async (page, name) => { await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name); };

  {
    const ctx = await ctxFor({ signedIn: false });
    const page = await ctx.newPage();
    await page.goto(base); await settle(page);
    await shot(page, '01-signin-guest');
    await ctx.close();
  }
  {
    const ctx = await ctxFor();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    await page.goto(base); await settle(page, 1200);
    await shot(page, '02-home');
    await page.getByRole('button', { name: /New game/ }).first().click(); await settle(page, 400);
    await page.locator('.new-game input.input').fill('Broken Swords');
    await page.locator('.new-game textarea').fill('A monochrome ink-and-paper RPG: a knight with a broken sword explores a cursed forest, talks to wisps, forges a new blade.');
    await shot(page, '03-new-game');
    await page.keyboard.press('Escape');

    await page.goto(`${base}/games/g_swords`); await settle(page, 1800);
    await shot(page, '04-workspace-running');
    await page.locator('.ws-right .segmented button', { hasText: 'Versions' }).click(); await settle(page, 500);
    await shot(page, '05-workspace-versions');
    await page.locator('.ws-right .segmented button', { hasText: 'Sprites' }).click(); await settle(page, 600);
    await page.locator('.sprite-card', { hasText: 'hero knight' }).locator('.sprite-hit').click(); await settle(page, 900);
    await page.locator('.editor textarea').fill('make the shield red and give the visor a warmer glow');
    await shot(page, '06-sprite-editor');
    await page.keyboard.press('Escape'); await settle(page, 400);
    await page.locator('.sprite-card', { hasText: 'slime green' }).locator('.sprite-check').click({ force: true });
    await page.locator('.sprite-card', { hasText: 'slime blue' }).locator('.sprite-check').click({ force: true });
    await page.locator('.sprite-card', { hasText: 'bat cave' }).locator('.sprite-check').click({ force: true });
    await page.getByRole('button', { name: 'Expand gallery' }).click(); await settle(page, 700);
    await shot(page, '07-gallery-expanded-multiselect');
    await page.getByRole('button', { name: 'Edit together' }).click(); await settle(page, 800);
    await shot(page, '08-multi-editor');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Play on phone' }).click(); await settle(page, 500);
    await shot(page, '09-play-on-phone');
    await page.keyboard.press('Escape');

    await page.goto(`${base}/games/g_slime`); await settle(page, 1800);
    await shot(page, '10-workspace-sprite-edit-live');

    await page.goto(`${base}/activity`); await settle(page, 1200);
    await page.locator('.feed-item', { hasText: 'quest log' }).locator('.feed-row').click(); await settle(page, 900);
    await shot(page, '11-activity');
    await page.goto(`${base}/insights`); await settle(page, 1200);
    await page.mouse.move(700, 470); await settle(page, 300);
    await page.screenshot({ path: `${out}/12-insights.png`, fullPage: true }); console.log('shot 12-insights');
    await page.goto(`${base}/account`); await settle(page, 1000);
    await shot(page, '13-account');
    await page.setViewportSize({ width: 1024, height: 1300 });
    await page.goto(`${base}/games/g_swords`); await settle(page, 1800);
    await shot(page, '14-workspace-tablet');
    await ctx.close();
  }
  {
    const ctx = await ctxFor({ theme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(`${base}/games/g_swords`); await settle(page, 1800);
    await shot(page, '15-workspace-dark');
    await page.goto(base); await settle(page, 1200);
    await shot(page, '16-home-dark');
    await ctx.close();
  }
  if (supaDist) {
    procs.push(await serve(supaDist, 4318));
    const ctx = await ctxFor({ signedIn: false });
    await ctx.route('**/auth/v1/settings', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ external: { google: true, apple: false, email: true } }) }));
    const page = await ctx.newPage();
    await page.goto('http://localhost:4318'); await settle(page, 1200);
    await shot(page, '00-signin-supabase');
    await ctx.close();
  }
} finally {
  await browser.close();
  for (const p of procs) p.kill();
}
