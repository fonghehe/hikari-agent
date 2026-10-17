import { redactText } from '@hikari/agent-core';

/** Buffer incomplete lines so credentials split across process chunks stay together. */
export class RedactedOutputStream {
  private pending = '';
  private privateKey = false;
  constructor(private emit: (text: string) => void) {}
  push(chunk: string): void {
    this.pending += chunk;
    for (let end = this.pending.indexOf('\n'); end !== -1; end = this.pending.indexOf('\n')) {
      this.line(this.pending.slice(0, end + 1));
      this.pending = this.pending.slice(end + 1);
    }
  }
  flush(): void {
    if (this.pending) this.line(this.pending);
    this.pending = '';
  }
  private line(text: string): void {
    if (this.privateKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(text)) this.privateKey = false;
      return;
    }
    if (
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) &&
      !/-----END [A-Z ]*PRIVATE KEY-----/.test(text)
    ) {
      this.privateKey = true;
      this.emit('[REDACTED PRIVATE KEY]\n');
      return;
    }
    this.emit(redactText(text));
  }
}
