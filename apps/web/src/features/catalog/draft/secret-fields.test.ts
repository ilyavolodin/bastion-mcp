import { describe, expect, it } from 'vitest';
import { secretFieldsOf } from './secrets';
import { defaultSpec, type SpecDraft } from './types';

const withHeaders = (secretLabels: Record<string, string>): SpecDraft => ({
  ...defaultSpec(),
  type: 'remote',
  authMode: 'userSecret',
  headers: [
    { name: 'Authorization', value: 'Bearer {{secret.API_KEY}}', secret: true },
    { name: 'X-Org', value: '{{secret.ORG_ID}}', secret: true },
    { name: 'X-Plain', value: '{{secret.IGNORED}}', secret: false },
  ],
  secretLabels,
});

describe('secretFieldsOf', () => {
  it('uses the label of the secret, trimmed', () => {
    expect(secretFieldsOf(withHeaders({ API_KEY: '  Your API key ' }))).toEqual([
      { name: 'API_KEY', label: 'Your API key' },
      { name: 'ORG_ID', label: 'ORG_ID' },
    ]);
  });

  it('falls back to the name for a blank or missing label', () => {
    expect(secretFieldsOf(withHeaders({ API_KEY: '   ', ORG_ID: '' }))).toEqual([
      { name: 'API_KEY', label: 'API_KEY' },
      { name: 'ORG_ID', label: 'ORG_ID' },
    ]);
  });

  it('is empty when no binding carries a secret', () => {
    expect(secretFieldsOf({ ...defaultSpec(), type: 'remote' })).toEqual([]);
  });
});
