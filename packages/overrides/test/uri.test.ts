import { describe, expect, it } from 'vitest';
import {
  addUriPrefix,
  matchUriTemplate,
  parseUriPrefix,
  pinTemplateVariables,
  stripUriPrefix,
  templateVariables,
  uriPrefixOf,
} from '../src/uri';

describe('7.4 URI prefix rewriting', () => {
  it('7.4 prefixes as bastion+{slug}:{original}', () => {
    expect(uriPrefixOf('fs-a')).toBe('bastion+fs-a:');
    expect(addUriPrefix('fs-a', 'file:///x')).toBe('bastion+fs-a:file:///x');
  });

  it('7.4 strips only this installation prefix', () => {
    expect(stripUriPrefix('bastion+fs-a:file:///x', 'fs-a')).toBe('file:///x');
    expect(stripUriPrefix('bastion+fs-b:file:///x', 'fs-a')).toBeNull();
    expect(stripUriPrefix('file:///x', 'fs-a')).toBeNull();
  });

  it('7.4 parses the slug out of a prefixed URI for routing', () => {
    expect(parseUriPrefix('bastion+fs-a:file:///x')).toEqual({ slug: 'fs-a', uri: 'file:///x' });
    expect(parseUriPrefix('file:///x')).toBeNull();
  });

  it('7.4 prefix then strip round-trips', () => {
    expect(stripUriPrefix(addUriPrefix('s', 'a:b/c?d'), 's')).toBe('a:b/c?d');
  });
});

describe('12.3 URI templates', () => {
  it('12.3 lists template variables', () => {
    expect(templateVariables('repo://{owner}/{repo}/{+path}{?q,r}')).toEqual([
      'owner',
      'repo',
      'path',
      'q',
      'r',
    ]);
    expect(templateVariables('x://{a:3}/{b*}')).toEqual(['a', 'b']);
  });

  it('12.3 pinning substitutes variables into the advertised template', () => {
    expect(
      pinTemplateVariables('repo://{owner}/{repo}/contents/{path}', { owner: 'acme' }),
    ).toEqual({ ok: true, template: 'repo://acme/{repo}/contents/{path}' });
  });

  it('12.3 pinned values are encoded for the expression operator', () => {
    expect(pinTemplateVariables('x://{a}', { a: 'a b/c' })).toEqual({
      ok: true,
      template: 'x://a%20b%2Fc',
    });
    expect(pinTemplateVariables('x://{+a}', { a: 'a b/c' })).toEqual({
      ok: true,
      template: 'x://a%20b/c',
    });
    expect(pinTemplateVariables('x://h{#a}', { a: 'f' })).toEqual({
      ok: true,
      template: 'x://h#f',
    });
  });

  it('12.3 pinning inside unsupported expressions is an error', () => {
    expect(pinTemplateVariables('x://{?a,b}', { a: '1' }).ok).toBe(false);
    expect(pinTemplateVariables('x://{a,b}', { a: '1' }).ok).toBe(false);
  });

  it('12.3 templates without pinned variables are unchanged', () => {
    expect(pinTemplateVariables('x://{a}', { z: '1' })).toEqual({ ok: true, template: 'x://{a}' });
  });

  it('12.3 matches URIs against templates and decodes variables', () => {
    expect(
      matchUriTemplate(
        'repo://{owner}/{repo}/contents/{+path}',
        'repo://acme/web/contents/a/b%20c.md',
      ),
    ).toEqual({
      owner: 'acme',
      repo: 'web',
      path: 'a/b c.md',
    });
    expect(matchUriTemplate('repo://{owner}/x', 'repo://acme/y')).toBeNull();
    expect(matchUriTemplate('x://{a}', 'x://%E0%A4%A')).toEqual({ a: '%E0%A4%A' });
  });

  it('12.3 query and multi-variable expressions match', () => {
    expect(matchUriTemplate('x://{a}{?q,r}', 'x://one?q=1&r=2')).toEqual({ a: 'one' });
    expect(matchUriTemplate('x://{a,b}', 'x://one,two')).toEqual({ a: 'one', b: 'two' });
    expect(matchUriTemplate('x://h{#a}', 'x://h#frag')).toEqual({ a: 'frag' });
    expect(matchUriTemplate('x://h{/a}', 'x://h/seg')).toEqual({ a: '/seg' });
  });
});
