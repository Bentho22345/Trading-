import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('sign-in screen: create account, own library and settings, remembered sign-in, switch person', async ({ page }) => {
  await page.goto('/');
  // first visit: nobody has an account yet → create one
  await expect(page.getByTestId('auth-name')).toBeVisible();
  await page.getByTestId('auth-name').fill('Casey Ortiz');
  await page.getByTestId('auth-email').fill('casey@example.com');
  await page.getByTestId('auth-password').fill('slider-grip-42');
  await page.getByTestId('auth-confirm').fill('slider-grip-42');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('user-chip')).toContainText('Casey Ortiz', { timeout: 20000 });

  // a per-person setting
  await page.goto('/#/settings');
  await expect(page.getByTestId('account-card')).toContainText('casey@example.com');
  await page.getByTestId('engine-select').selectOption('movenet');

  // remembered: a reload keeps Casey signed in with the same settings
  await page.reload();
  await expect(page.getByTestId('user-chip')).toContainText('Casey Ortiz');
  await expect(page.getByTestId('engine-select')).toHaveValue('movenet');

  // switch person → the account is listed; wrong password is refused
  await page.getByTestId('user-chip').click();
  await page.getByTestId('switch-user').click();
  await expect(page.getByTestId('account-list')).toContainText('Casey Ortiz');
  await page.getByTestId('to-create').click();
  await page.getByTestId('auth-name').fill('Jordan Lee');
  await page.getByTestId('auth-email').fill('jordan@example.com');
  await page.getByTestId('auth-password').fill('changeup-77');
  await page.getByTestId('auth-confirm').fill('changeup-77');
  await page.getByTestId('auth-remember').uncheck();
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('user-chip')).toContainText('Jordan Lee', { timeout: 20000 });
  // Jordan has their own (default) settings
  await page.goto('/#/settings');
  await expect(page.getByTestId('engine-select')).toHaveValue('auto');

  await page.getByTestId('user-chip').click();
  await page.getByTestId('sign-out').click();
  await page.getByRole('button', { name: /Casey Ortiz/ }).click();
  await page.getByTestId('auth-password').fill('wrong-password');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('auth-error')).toContainText('not right');
  await page.getByTestId('auth-password').fill('slider-grip-42');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('user-chip')).toContainText('Casey Ortiz', { timeout: 20000 });
  await page.goto('/#/settings');
  await expect(page.getByTestId('engine-select')).toHaveValue('movenet');
});

test('guest mode works without an account', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('auth-guest').click();
  await expect(page.getByTestId('user-chip')).toContainText('Guest');
  await expect(page.getByText('Demo · Good day', { exact: false }).first()).toBeVisible();
});
