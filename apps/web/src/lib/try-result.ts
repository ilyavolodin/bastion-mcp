import { isRecord } from '@/lib/json';

export type TryKind = 'tool' | 'prompt' | 'resource';

export type ResultBlock = { key: string; label: string; text: string };

/** What a call answered, in the form of what it is: text blocks, prompt messages, resource contents. */
export const resultBlocks = (kind: TryKind, result: unknown): ResultBlock[] => {
  const body = isRecord(result) ? result : {};
  const blocks: ResultBlock[] = [];
  // A refusal (policy, a guard, limits, an unknown name) is a legitimate answer of a try: say it in words.
  if (isRecord(body.error)) {
    blocks.push({
      key: 'error',
      label: typeof body.error.code === 'string' ? body.error.code : 'Error',
      text:
        typeof body.error.message === 'string' ? body.error.message : JSON.stringify(body.error),
    });
  } else if (typeof body.error === 'string') {
    blocks.push({ key: 'error', label: 'Error', text: body.error });
  }
  if (kind === 'tool' && Array.isArray(body.content)) {
    body.content.forEach((c, i) => {
      if (isRecord(c) && c.type === 'text' && typeof c.text === 'string') {
        blocks.push({ key: `c${i}`, label: 'Text', text: c.text });
      } else if (isRecord(c)) {
        blocks.push({
          key: `c${i}`,
          label: String(c.type ?? 'Content'),
          text: JSON.stringify(c, null, 2),
        });
      }
    });
    if (body.structuredContent !== undefined) {
      blocks.push({
        key: 'structured',
        label: 'Structured',
        text: JSON.stringify(body.structuredContent, null, 2),
      });
    }
  }
  if (kind === 'prompt' && Array.isArray(body.messages)) {
    body.messages.forEach((m, i) => {
      if (!isRecord(m)) return;
      const content = isRecord(m.content) ? m.content : {};
      blocks.push({
        key: `m${i}`,
        label: String(m.role ?? 'message'),
        text: typeof content.text === 'string' ? content.text : JSON.stringify(m.content, null, 2),
      });
    });
  }
  if (kind === 'resource' && Array.isArray(body.contents)) {
    body.contents.forEach((c, i) => {
      if (!isRecord(c)) return;
      const label = `${String(c.uri ?? 'resource')}${typeof c.mimeType === 'string' ? ` · ${c.mimeType}` : ''}`;
      blocks.push({
        key: `r${i}`,
        label,
        text:
          typeof c.text === 'string'
            ? c.text
            : typeof c.blob === 'string'
              ? `(${c.blob.length} characters of base64 data)`
              : JSON.stringify(c, null, 2),
      });
    });
  }
  return blocks;
};
