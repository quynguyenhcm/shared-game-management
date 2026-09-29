import { expect, test } from '@playwright/test';

test('home page renders live API health and is styled by Tailwind', async ({ page, request }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  // Fetched from the running API at request time (AC-INTEGRATION-4).
  await expect(page.getByTestId('api-status')).toHaveText('API: ok');

  // AC-VERIFY-2: the served CSS contains a Tailwind utility class that the page uses.
  const className = await page.getByTestId('api-status').getAttribute('class');
  expect(className).toContain('font-mono');
  const stylesheets = await page
    .locator('link[rel="stylesheet"]')
    .evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
  expect(stylesheets.length).toBeGreaterThan(0);
  const css = (
    await Promise.all(stylesheets.map((href) => request.get(href).then((r) => r.text())))
  ).join('\n');
  expect(css).toContain('.font-mono');
});
