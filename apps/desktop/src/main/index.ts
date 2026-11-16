// Select the isolated browser process before loading application services.
const boot =
  process.env.HIKARI_BROWSER_WORKER === '1'
    ? import('./browser/browser-worker').then(({ startBrowserWorker }) => startBrowserWorker())
    : import('./bootstrap');
void boot.catch((error) => {
  console.error(error);
  process.exit(1);
});
