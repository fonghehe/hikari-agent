import { parentPort } from 'node:worker_threads';
import { prepareAttachment } from './attachments';
import type { AttachmentUpload } from '@hikari/shared';
parentPort?.once('message', (input: AttachmentUpload) => {
  void prepareAttachment(input).then(
    (value) => parentPort?.postMessage({ value }),
    (error: unknown) =>
      parentPort?.postMessage({
        error: error instanceof Error ? error.message : 'Could not process attachment',
      }),
  );
});
