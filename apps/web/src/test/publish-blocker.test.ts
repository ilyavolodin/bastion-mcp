import { describe, expect, it } from 'vitest';
import { publishBlocker } from '@/features/catalog/editor-page';

describe('publishBlocker (11.3)', () => {
  const base = { hasEntry: true, versionDirty: false, status: undefined, reason: undefined };
  it.each([
    [
      { hasEntry: false, versionDirty: true, status: 'failed' as const },
      'This draft is not saved or tested yet.',
      'Save the draft and run its test to publish it.',
    ],
    [
      { versionDirty: true, status: 'failed' as const },
      'This version changed since its last test.',
      'You changed this version since its last test. Save it and run the test again.',
    ],
    [{ status: 'running' as const }, 'The test is still running.', 'The test is running.'],
    [
      { status: 'failed' as const },
      'The last test failed.',
      'The last test failed. Fix the problem and run the test again.',
    ],
    [
      { status: 'failed' as const, reason: 'Connect: refused' },
      'The last test failed: Connect: refused',
      'The last test failed. Fix the problem and run the test again.',
    ],
    [
      {},
      'This version has not been tested.',
      'Publish needs a passing test of this exact version. Run the test.',
    ],
    [
      { status: 'passed' as const },
      'This version has not been tested.',
      'Publish needs a passing test of this exact version. Run the test.',
    ],
  ])('11.3 %j', (over, headline, hint) => {
    expect(publishBlocker({ ...base, ...over })).toEqual({ headline, hint });
  });
});
