/** Owned registrations/resources are released once, in reverse dependency order. */
export class ResourceScope {
  private disposers: (() => void | Promise<void>)[] = [];
  private closing?: Promise<void>;
  private closed = false;
  defer(dispose: () => void | Promise<void>) {
    if (this.closed) throw new Error('Resource scope is closed');
    this.disposers.push(dispose);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      for (const dispose of this.disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Resource cleanup failed');
    });
    return this.closing;
  }
}
