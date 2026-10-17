import { test, expect } from '@playwright/test';

test('home shows demo comparison and screenshots', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await expect(page.getByTestId('slot-A-name')).toContainText('Good day');
  await page.screenshot({ path: `test-results/home-${info.project.name}.png`, fullPage: true });
  await page.getByTestId('compare-btn').click();
  await expect(page.getByTestId('verdict')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `test-results/compare-${info.project.name}.png`, fullPage: true });
  await page.goto('/#/clip/demo-off');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `test-results/clip-${info.project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});
