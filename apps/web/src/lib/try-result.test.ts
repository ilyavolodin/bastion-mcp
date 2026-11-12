import { describe, expect, it } from 'vitest';
import { resultBlocks } from './try-result';

describe('12.5 resultBlocks', () => {
  it('names a refusal by its code and keeps its position before the content', () => {
    expect(
      resultBlocks('tool', {
        error: { code: 'denied', message: 'No.' },
        content: [{ type: 'text', text: 'x' }],
      }),
    ).toEqual([
      { key: 'error', label: 'denied', text: 'No.' },
      { key: 'c0', label: 'Text', text: 'x' },
    ]);
  });

  it('reads only the part of the answer that belongs to the kind tried', () => {
    const answer = {
      content: [{ type: 'text', text: 'a' }],
      messages: [{ role: 'user' }],
      contents: [{ uri: 'u' }],
    };
    expect(resultBlocks('prompt', answer).map((b) => b.key)).toEqual(['m0']);
    expect(resultBlocks('resource', answer).map((b) => b.key)).toEqual(['r0']);
    expect(resultBlocks('tool', 'not an object')).toEqual([]);
  });
});
