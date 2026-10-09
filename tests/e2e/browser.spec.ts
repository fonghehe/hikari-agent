import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { BrowserService } from '../../packages/tools/src/browser';
test('browser tools inspect, interact and capture a real local page', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<h1>Browser fixture</h1><label>Name<input id="name"></label><button onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value">Apply</button>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const browser = new BrowserService({ emit() {} });
  try {
    await expect(browser.open('file:///etc/passwd')).rejects.toThrow('HTTP');
    expect(await browser.open(`http://127.0.0.1:${address.port}`)).toContain('Browser fixture');
    await browser.type('#name', 'Verified browser');
    await browser.click('button');
    expect(await browser.getDOM()).toContain('Verified browser');
    expect(await browser.evaluate('document.title')).toBe('""');
    await browser.screenshot();
    expect(browser.preview().image).toMatch(/^data:image\/jpeg;base64,/);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
