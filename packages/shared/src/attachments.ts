import type { Attachment, ModelImage } from '@hikari/agent-core';

export type { Attachment } from '@hikari/agent-core';
export const attachmentLimits = {
  maxFiles: 6,
  maxImages: 3,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxTextChars: 12000,
  maxTotalTextChars: 24000,
} as const;
export interface AttachmentUpload {
  name: string;
  bytes: Uint8Array;
}
export interface AttachmentBatch {
  items: Attachment[];
  errors: { name: string; message: string }[];
}
export interface AttachmentContent {
  attachment: Attachment;
  text?: string;
  image?: ModelImage;
  chunks?: {
    index: number;
    label: string;
    text: string;
    chunkId?: string;
    start?: number;
    end?: number;
    heading?: string;
  }[];
  ocr?: boolean;
}
