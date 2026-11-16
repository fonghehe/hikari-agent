import { createHash } from 'node:crypto';
import { redactText } from '@hikari/agent-core';

export const splitterVersion = 'structure-char-v1';
export interface KnowledgeChunk {
  index: number;
  chunkId: string;
  label: string;
  text: string;
  start: number;
  end: number;
  heading?: string;
}

/** Offsets address sanitized UTF-16 text. Limits are characters, not model tokens. */
export function splitKnowledgeText(
  input: string,
  label = 'Paragraph',
  maxChars = 1800,
  overlapChars = 180,
): KnowledgeChunk[] {
  if (
    !Number.isSafeInteger(maxChars) ||
    maxChars < 64 ||
    !Number.isSafeInteger(overlapChars) ||
    overlapChars < 0 ||
    overlapChars >= maxChars / 2
  )
    throw new Error('Invalid chunk size or overlap');
  const text = redactText(input);
  const chunks: KnowledgeChunk[] = [];
  const headings: string[] = [];
  const sections: { start: number; end: number; heading: string }[] = [];
  const blocks: { start: number; end: number }[] = [];
  let start = 0;
  let fence: string | undefined;
  let fenceStart = 0;
  for (const match of text.matchAll(/^.*(?:\r?\n|$)/gm)) {
    const line = match[0];
    const position = match.index;
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) {
        fence = marker;
        fenceStart = position;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        blocks.push({ start: fenceStart, end: position + line.length });
        fence = undefined;
      }
      continue;
    }
    const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trimEnd());
    if (heading) {
      if (position > start)
        sections.push({ start, end: position, heading: headings.join(' / ').slice(0, 200) });
      headings.length = Math.min(headings.length, heading[1]!.length - 1);
      headings[heading[1]!.length - 1] = heading[2]!.slice(0, 200);
      start = position;
    }
  }
  if (fence) blocks.push({ start: fenceStart, end: text.length });
  sections.push({
    start,
    end: text.length,
    heading: headings.filter(Boolean).join(' / ').slice(0, 200),
  });
  const safeBoundary = (position: number) => {
    const code = text.charCodeAt(position);
    return code >= 0xdc00 && code <= 0xdfff ? position - 1 : position;
  };
  for (const section of sections) {
    let offset = section.start;
    while (offset < section.end) {
      let end = safeBoundary(Math.min(offset + maxChars, section.end));
      const crossing = blocks.find(
        (block) => block.start < end && block.end > end && block.end - block.start <= maxChars,
      );
      if (crossing) end = crossing.start > offset ? crossing.start : crossing.end;
      else if (end < section.end) {
        const tail = text.slice(offset + Math.floor(maxChars / 2), end);
        const boundaries = [...tail.matchAll(/\n\s*\n|[。！？.!?]\s*/g)];
        const boundary = boundaries.at(-1);
        if (boundary) end = offset + Math.floor(maxChars / 2) + boundary.index + boundary[0].length;
      }
      const raw = text.slice(offset, end);
      const content = raw.trim();
      const left = raw.length - raw.trimStart().length;
      if (content) {
        const chunkStart = offset + left;
        const chunkEnd = chunkStart + content.length;
        chunks.push({
          index: chunks.length,
          chunkId: createHash('sha256')
            .update(JSON.stringify([splitterVersion, label, section.heading, chunkStart, content]))
            .digest('hex'),
          label:
            `${label} ${chunks.length + 1}${section.heading ? ` — ${section.heading}` : ''}`.slice(
              0,
              512,
            ),
          text: content,
          start: chunkStart,
          end: chunkEnd,
          heading: section.heading || undefined,
        });
      }
      if (end >= section.end) break;
      let next = Math.max(offset + 1, safeBoundary(end - overlapChars));
      // Do not carry a partial fenced block into the next chunk.
      const inFence = blocks.find(
        (block) => block.start < next && block.end > next && block.end - block.start <= maxChars,
      );
      if (inFence) next = inFence.end <= end ? end : inFence.start;
      offset = Math.max(offset + 1, next);
    }
  }
  return chunks;
}
