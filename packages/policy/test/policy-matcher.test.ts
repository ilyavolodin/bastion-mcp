import { describe, expect, it } from 'vitest';
import { analyzePolicyJson, policyToJson } from '../src/cedar';

const matcherOf = (conditions: string) =>
  analyzePolicyJson(policyToJson(`permit (principal, action, resource) ${conditions};`)).matcher;

describe('10.3 resource attribute matcher found in a policy', () => {
  it('10.3 resource.name == "x" is an exact one-segment matcher', () => {
    expect(matcherOf('when { resource.name == "alpha" }')).toEqual({
      attr: 'name',
      segments: ['alpha'],
    });
  });

  it('10.3 resource.uri == "x" is an exact matcher on uri', () => {
    expect(matcherOf('when { resource.uri == "file:///a" }')).toEqual({
      attr: 'uri',
      segments: ['file:///a'],
    });
  });

  it('10.3 resource.name like with wildcards yields the literal segments between them', () => {
    expect(matcherOf('when { resource.name like "pre*mid*post" }')).toEqual({
      attr: 'name',
      segments: ['pre', 'mid', 'post'],
    });
    expect(matcherOf('when { resource.uri like "*tail" }')).toEqual({
      attr: 'uri',
      segments: ['', 'tail'],
    });
    expect(matcherOf('when { resource.name like "*" }')).toEqual({
      attr: 'name',
      segments: ['', ''],
    });
  });

  it('10.3 a like pattern without wildcards is one segment', () => {
    expect(matcherOf('when { resource.name like "plain" }')).toEqual({
      attr: 'name',
      segments: ['plain'],
    });
  });

  it('10.3 attributes other than name and uri give no matcher', () => {
    expect(matcherOf('when { resource.kind == "tool" }')).toBeNull();
    expect(matcherOf('when { resource.kind like "t*" }')).toBeNull();
    expect(matcherOf('when { principal.name == "alpha" }')).toBeNull();
  });

  it('10.3 an equality with a non-literal right side gives no matcher', () => {
    expect(matcherOf('when { resource.name == principal.name }')).toBeNull();
  });

  it('10.3 the first qualifying conjunct wins, skipping the ones that do not qualify', () => {
    expect(
      matcherOf(
        'when { resource.kind == "tool" && resource.name like "a*b" && resource.uri == "u" }',
      ),
    ).toEqual({ attr: 'name', segments: ['a', 'b'] });
    expect(matcherOf('when { resource.name == principal.name && resource.uri like "x*" }')).toEqual(
      { attr: 'uri', segments: ['x', ''] },
    );
  });

  it('10.3 a like on a non-resource attribute is skipped in favour of a later conjunct', () => {
    expect(matcherOf('when { principal.name like "x*" && resource.name == "z" }')).toEqual({
      attr: 'name',
      segments: ['z'],
    });
  });

  it('10.3 the first when clause with a matcher wins; unless clauses are ignored', () => {
    expect(
      matcherOf(
        'when { resource.kind == "t" } when { resource.name == "b" } when { resource.name == "c" }',
      ),
    ).toEqual({ attr: 'name', segments: ['b'] });
    expect(matcherOf('unless { resource.name == "x" }')).toBeNull();
  });

  it('10.3 a disjunction is not mined for a matcher', () => {
    expect(matcherOf('when { resource.name == "a" || resource.name == "b" }')).toBeNull();
  });

  it('10.3 a policy without conditions has no matcher', () => {
    expect(matcherOf('')).toBeNull();
  });
});
