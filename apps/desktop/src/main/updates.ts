import { existsSync } from 'node:fs';
import path from 'node:path';
import { autoUpdater } from 'electron-updater';
export class UpdateService {
  private state = 'idle';
  private message = '';
  constructor(
    private supported: boolean,
    private version: string,
    private idle: () => boolean,
  ) {
    this.supported = supported && existsSync(path.join(process.resourcesPath, 'app-update.yml'));
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('error', (error) => {
      this.state = 'error';
      this.message = error.message;
    });
    autoUpdater.on('update-available', () => {
      this.state = 'available';
      this.message = '';
    });
    autoUpdater.on('update-not-available', () => {
      this.state = 'current';
      this.message = '';
    });
    autoUpdater.on('download-progress', (progress) => {
      this.state = 'downloading';
      this.message = `${Math.round(progress.percent)}%`;
    });
    autoUpdater.on('update-downloaded', () => {
      this.state = 'ready';
      this.message = '';
    });
  }
  status() {
    return {
      supported: this.supported,
      version: this.version,
      state: this.state,
      message: this.message,
    };
  }
  async check() {
    if (!this.supported)
      throw new Error('Updates are available in packaged releases with a configured release feed');
    this.state = 'checking';
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.state = 'error';
      this.message = String(error);
      throw error;
    }
  }
  async download() {
    if (this.state !== 'available') throw new Error('Check for an available update first');
    this.state = 'downloading';
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.state = 'error';
      this.message = String(error);
      throw error;
    }
  }
  install() {
    if (this.state !== 'ready') throw new Error('Download the update first');
    if (!this.idle())
      throw new Error('Finish or pause and interrupt active tasks before restarting for an update');
    autoUpdater.quitAndInstall();
  }
}
