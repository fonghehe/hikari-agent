import { expect, type Page, type ElectronApplication } from '@playwright/test';

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

export async function openWorkspaceTool(
  page: Page,
  name: 'files' | 'diff' | 'terminal' | 'browser',
) {
  await page.getByRole('button', { name: 'Workspace tools', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Right panel' })).toBeVisible();
}

/** Exercise the staged project picker before the selected folder becomes active. */
export async function addWorkspaceProject(page: Page, cancelled = false) {
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create project', exact: true });
  await dialog.getByRole('button', { name: 'Add folder', exact: true }).click();
  const create = dialog.getByRole('button', { name: 'Create project', exact: true });
  if (cancelled) {
    await expect(create).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  } else {
    await expect(create).toBeEnabled();
    await create.click();
  }
  await expect(dialog).not.toBeVisible();
}
