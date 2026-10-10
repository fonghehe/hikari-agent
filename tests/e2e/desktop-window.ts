import { expect, type ElectronApplication } from '@playwright/test';

export async function wideDesktopWindow(app: ElectronApplication) {
  const page = await app.firstWindow();
  // macOS CI can clamp the native window to a small physical display.
  // Set the CSS viewport and open the panel explicitly for wide-layout tests.
  await page.setViewportSize({ width: 1480, height: 960 });
  const toggle = page.getByRole('button', { name: 'Toggle right panel', exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return page;
}
