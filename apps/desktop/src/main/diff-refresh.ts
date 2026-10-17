/** Coalesce file bursts and never publish a diff that was read before a newer edit. */
export class DiffRefresh {
  private version = 0;
  private dirty = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  constructor(
    private read: () => Promise<string>,
    private publish: (diff: string) => void,
  ) {}

  request() {
    if (this.closed) return;
    this.version++;
    this.dirty = true;
    if (!this.timer && !this.running) {
      this.timer = setTimeout(() => void this.flush(), 40);
      this.timer.unref();
    }
  }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return this.running;
    if (this.closed || !this.dirty) return Promise.resolve();
    this.running = this.drain().finally(() => {
      this.running = undefined;
      // A microtask may request another refresh after drain has returned.
      if (this.dirty && !this.closed) {
        this.timer = setTimeout(() => void this.flush(), 40);
        this.timer.unref();
      }
    });
    return this.running;
  }
  private async drain() {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      const version = this.version;
      try {
        const diff = await this.read();
        if (!this.closed && version === this.version) this.publish(diff);
      } catch {
        // Non-Git workspaces still support file tools.
      }
    }
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
