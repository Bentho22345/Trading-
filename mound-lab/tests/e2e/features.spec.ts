import { test, expect } from '@playwright/test';

test('demo clip: velocity is measured from the video frames', async ({ page }) => {
  await page.goto('/#/clip/demo-good');
  const mph = page.getByTestId('velo-mph');
  await expect(mph).toBeVisible({ timeout: 20000 });
  const v = parseFloat((await mph.textContent()) ?? '');
  expect(v).toBeGreaterThan(82); // true speed drawn in the demo video: 85 mph
  expect(v).toBeLessThan(88);
  await expect(page.getByTestId('quality-card')).toBeVisible();
});

test('compare: scorecard says which delivery is better and shows velocity', async ({ page }) => {
  await page.goto('/#/compare');
  const sc = page.getByTestId('scorecard');
  await expect(sc).toContainText('Overall, A is the better delivery', { timeout: 20000 });
  await expect(sc).toContainText('B is worse');
  await expect(sc).toContainText('mph', { timeout: 20000 });
});

test('drawing tools: an angle drawn on the player is measured', async ({ page }) => {
  await page.goto('/#/clip/demo-good');
  await page.getByRole('toolbar', { name: 'Drawing and measuring tools' }).getByRole('button', { name: 'Angle' }).click();
  const canvas = page.locator('.player canvas').first();
  const box = (await canvas.boundingBox())!;
  for (const [x, y] of [[0.3, 0.3], [0.4, 0.5], [0.6, 0.5]]) await canvas.click({ position: { x: box.width * x, y: box.height * y } });
  await expect(page.getByRole('button', { name: /Clear drawings \(1\)/ })).toBeVisible();
});

test('athlete profile: session consistency and best pitch', async ({ page }) => {
  await page.goto('/#/athletes/demo-athlete');
  await page.getByText(/· 3 pitches/).first().click();
  await expect(page.getByText(/Consistency/).first()).toBeVisible();
  await expect(page.getByText(/Best pitch:/).first()).toBeVisible({ timeout: 15000 });
});
