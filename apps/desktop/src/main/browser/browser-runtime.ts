import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import type { BrowserFactory } from '@hikari/tools';

/** Reuse Electron's Chromium in a disposable process, avoiding a second browser in the installer. */
export const createDesktopBrowser: BrowserFactory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hikari-browser-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HIKARI_BROWSER_WORKER: '1',
    HIKARI_BROWSER_DATA: directory,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, process.defaultApp ? [process.argv[1]!] : [], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  let launchError: Error | undefined;
  child.once('error', (error) => {
    launchError = error;
  });
  const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  const close = async () => {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([exit, delay(2000)]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exit, delay(2000)]);
      }
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Isolated browser exited ${child.exitCode}`);
      try {
        const [port, websocket] = (
          await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')
        )
          .trim()
          .split('\n');
        browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${websocket}`, {
          timeout: 3000,
        });
        let page = browser.contexts()[0]?.pages()[0];
        while (!page && Date.now() < deadline) {
          await delay(50);
          page = browser.contexts()[0]?.pages()[0];
        }
        if (!page) throw new Error('Isolated browser page unavailable');
        return { browser, page, close };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await delay(50);
    }
    throw new Error('Isolated browser did not start within 15 seconds');
  } catch (error) {
    await close();
    throw error;
  }
};
