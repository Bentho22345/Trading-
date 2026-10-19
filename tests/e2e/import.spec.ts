import { test, expect, type Page } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';

async function dropFiles(page: Page, files: { name: string; path: string }[], target?: string) {
  const payload = files.map((f) => ({ name: f.name, b64: readFileSync(f.path).toString('base64') }));
  // the app loads after the sign-in check: wait until it's listening for drops
  await expect(page.getByTestId('slot-A-name')).toBeVisible({ timeout: 20000 });
  await page.evaluate(async ({ payload, target }) => {
    const dt = new DataTransfer();
    for (const f of payload) {
      const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bin], f.name, { type: 'video/mp4' }));
    }
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const el = target ? document.querySelector(`[data-drop="${target}"]`)! : document.body;
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { payload, target });
}

test('dropping two MP4s fills A and B with the right frame rates', async ({ page }) => {
  await page.goto('/');
  await dropFiles(page, [{ name: 'clip120.mp4', path: 'tests/fixtures/clip120.mp4' }, { name: 'clip60.mp4', path: 'tests/fixtures/clip60.mp4' }]);
  await expect(page.getByTestId('slot-A-name')).toHaveText('clip120', { timeout: 20000 });
  await expect(page.getByTestId('slot-B-name')).toHaveText('clip60');
  await expect(page.getByTestId('slot-A-fps')).toContainText('120 fps', { timeout: 20000 });
  await expect(page.getByTestId('slot-B-fps')).toContainText('60 fps');
});

test('dropping onto slot B replaces only B', async ({ page }) => {
  await page.goto('/');
  await dropFiles(page, [{ name: 'clip60.mp4', path: 'tests/fixtures/clip60.mp4' }], 'B');
  await expect(page.getByTestId('slot-B-name')).toHaveText('clip60', { timeout: 20000 });
  await expect(page.getByTestId('slot-A-name')).toContainText('Good day');
});

test('frame stepping in the clip view moves exactly one frame', async ({ page }) => {
  await page.goto('/#/clip/demo-good');
  const label = page.locator('.controls .mono').first();
  await expect(label).toContainText('frame');
  const frame = async () => Number((await label.textContent())!.match(/frame (\d+)/)![1]);
  const start = await frame();
  await page.getByLabel('Next frame').first().click();
  await expect.poll(frame).toBe(start + 1);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(frame).toBe(start - 1);
});

test('editing foot strike updates the metrics', async ({ page }) => {
  await page.goto('/#/clip/demo-good');
  const stride = page.getByTestId('metric-value-stride');
  const before = await stride.textContent();
  await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft');
  await page.getByTestId('set-FS').click();
  await expect(stride).not.toHaveText(before ?? '');
});

const PERSON = process.env.PERSON_CLIP;
test('real pose model tracks a person in a 120 fps clip', async ({ page }) => {
  test.skip(!PERSON || !existsSync(PERSON), 'set PERSON_CLIP to a local video of a person');
  test.setTimeout(300_000);
  await page.goto('/');
  await dropFiles(page, [{ name: 'person.mp4', path: PERSON! }], 'A');
  await expect(page.getByTestId('slot-A-name')).toHaveText('person', { timeout: 20000 });
  await page.getByTestId('slot-A').getByRole('button', { name: 'Open' }).click();
  const t0 = Date.now();
  await page.getByTestId('analyze-btn').click();
  await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible({ timeout: 230_000 });
  console.log(`analysis took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.screenshot({ path: 'test-results/person-analysed.png', fullPage: false });
});
