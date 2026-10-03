import { describe, expect, it } from 'vitest';
import {
  assertNoPerUserReferences,
  extractReferences,
  resolveTemplate,
  secretRef,
  TemplateError,
  validateTemplate,
  varRef,
} from '../src/template';

const ctx = {
  var: { REGION: 'eu' },
  secret: { API_KEY: 's3cr3t' },
  oauth: { accessToken: 'tok' },
  user: { email: 'a@acme.com', id: 'u1', teams: ['data', 'ops'] },
  sandbox: { workspace: '/workspace' },
};

describe('8.1 value templates', () => {
  it('resolves var, secret, oauth, user and sandbox references', () => {
    expect(resolveTemplate('Bearer {{oauth.accessToken}}', ctx)).toBe('Bearer tok');
    expect(resolveTemplate('{{var.REGION}}-{{user.id}}', ctx)).toBe('eu-u1');
    expect(resolveTemplate('{{user.teams}}', ctx)).toBe('data,ops');
    expect(resolveTemplate('{{sandbox.workspace}}/x {{secret.API_KEY}}', ctx)).toBe(
      '/workspace/x s3cr3t',
    );
    expect(resolveTemplate('{{ user.email }}', ctx)).toBe('a@acme.com');
  });

  it('leaves text without references untouched, including single braces', () => {
    expect(resolveTemplate('{"a":1}', ctx)).toBe('{"a":1}');
  });

  it('fails on unknown references at validation time', () => {
    expect(() => validateTemplate('{{nope.x}}')).toThrow(TemplateError);
    expect(() => validateTemplate('{{var.}}')).toThrow(TemplateError);
    expect(() => validateTemplate('{{user.phone}}')).toThrow(TemplateError);
    expect(() => validateTemplate('{{var.A}} {{oauth.accessToken}}')).not.toThrow();
  });

  it('does not support expressions', () => {
    expect(() => validateTemplate('{{var.A + 1}}')).toThrow(TemplateError);
  });

  it('fails resolution when a value is missing', () => {
    expect(() => resolveTemplate('{{var.MISSING}}', ctx)).toThrow(/var\.MISSING/);
  });

  it('extracts references in order without duplicates', () => {
    expect(extractReferences('{{var.A}}{{secret.B}}{{var.A}}')).toEqual(['var.A', 'secret.B']);
  });

  it('8.6 shared instances reject {{user.*}} and {{oauth.*}} templates', () => {
    expect(() => assertNoPerUserReferences(['{{var.A}}', '{{secret.B}}'])).not.toThrow();
    expect(() => assertNoPerUserReferences(['x {{user.email}}'])).toThrow(TemplateError);
    expect(() => assertNoPerUserReferences(['{{oauth.accessToken}}'])).toThrow(TemplateError);
  });
});

describe('8.1 reference builders', () => {
  it('secretRef and varRef build references that validate and resolve', () => {
    expect(secretRef('API_KEY')).toBe('{{secret.API_KEY}}');
    expect(varRef('REGION')).toBe('{{var.REGION}}');
    expect(resolveTemplate(`${varRef('REGION')}-${secretRef('API_KEY')}`, ctx)).toBe('eu-s3cr3t');
  });
});
