import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyToPrompt, applyToResourceTemplate, applyToTool } from '../src/apply';
import {
  applyMessagesTransform,
  applyOutputTransform,
  mapPromptGet,
  mapResourceRead,
  mapToolCall,
  resolvePinned,
} from '../src/call';
import { emptyOverrides, type OverridesDocument } from '../src/schema';
import type { FinalPrompt, FinalTool, UpstreamTool } from '../src/types';

const doc = (partial: Partial<OverridesDocument>): OverridesDocument => ({
  ...emptyOverrides(),
  ...partial,
});

const upstream: UpstreamTool = {
  name: 'create_issue',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string', enum: ['web', 'api', 'infra', 'docs'] },
      labels: { type: 'array', items: { type: 'string' } },
    },
    required: ['owner', 'repo'],
    additionalProperties: false,
  },
};

const finalTool = (override: OverridesDocument['tools'][string]): FinalTool => {
  const r = applyToTool(upstream, { installation: doc({ tools: { create_issue: override } }) });
  if (r.kind !== 'tool') throw new Error('expected tool');
  return r;
};
const ctx = { user: { email: 'a@acme.com' } };

describe('12.4 mapToolCall', () => {
  it('12.4 tools without a plan pass arguments through', () => {
    const r = mapToolCall(
      { finalName: 'gh__create_issue', arguments: { x: 1 } },
      { upstreamName: 'create_issue' },
      ctx,
    );
    expect(r).toEqual({ ok: true, upstreamName: 'create_issue', arguments: { x: 1 }, events: [] });
    expect(mapToolCall({ finalName: 'f' }, { upstreamName: 'u' }, ctx)).toMatchObject({
      arguments: {},
    });
  });

  it('12.4 maps the final name to the upstream name and merges pinned arguments', () => {
    const t = finalTool({ pinnedArguments: { owner: 'acme' } });
    const r = mapToolCall(
      { finalName: 'x', arguments: { repo: 'web' } },
      { upstreamName: 'create_issue', plan: t.plan },
      ctx,
    );
    expect(r).toEqual({
      ok: true,
      upstreamName: 'create_issue',
      arguments: { repo: 'web', owner: 'acme' },
      events: [],
    });
  });

  it('12.3 pinned value wins and a pinned_arg_overridden event is reported when the client sent a different value', () => {
    const t = finalTool({ pinnedArguments: { owner: 'acme' } });
    const r = mapToolCall(
      { finalName: 'x', arguments: { owner: 'evil', repo: 'web' } },
      { upstreamName: 'create_issue', plan: t.plan },
      ctx,
    );
    expect(r).toMatchObject({
      ok: true,
      arguments: { owner: 'acme' },
      events: [{ type: 'pinned_arg_overridden', argument: 'owner' }],
    });
  });

  it('12.3 no event when the client sent the pinned value itself', () => {
    const t = finalTool({ pinnedArguments: { owner: 'acme' } });
    const r = mapToolCall(
      { finalName: 'x', arguments: { owner: 'acme', repo: 'web' } },
      { upstreamName: 'create_issue', plan: t.plan },
      ctx,
    );
    expect(r).toMatchObject({ ok: true, events: [] });
  });

  it('12.3 pinned values resolve value templates per call', () => {
    const t = finalTool({ pinnedArguments: { owner: '{{user.email}}' } });
    const r = mapToolCall(
      { finalName: 'x', arguments: { repo: 'web' } },
      { upstreamName: 'create_issue', plan: t.plan },
      ctx,
    );
    expect(r).toMatchObject({ ok: true, arguments: { owner: 'a@acme.com' } });
  });

  it('12.3 an unresolvable pinned template is a tool error that does not leak values', () => {
    const t = finalTool({ pinnedArguments: { owner: '{{user.email}}' } });
    const r = mapToolCall(
      { finalName: 'x', arguments: { repo: 'web' } },
      { upstreamName: 'create_issue', plan: t.plan },
      {},
    );
    expect(r).toMatchObject({ ok: false, result: { isError: true } });
  });

  it('12.3 defaultArguments fill omitted values and never override client values', () => {
    const t = finalTool({ defaultArguments: { labels: ['from-mcp'] } });
    const entry = { upstreamName: 'create_issue', plan: t.plan };
    expect(
      mapToolCall({ finalName: 'x', arguments: { owner: 'o', repo: 'web' } }, entry, ctx),
    ).toMatchObject({ arguments: { labels: ['from-mcp'] } });
    expect(
      mapToolCall(
        { finalName: 'x', arguments: { owner: 'o', repo: 'web', labels: ['a'] } },
        entry,
        ctx,
      ),
    ).toMatchObject({ arguments: { labels: ['a'] } });
  });

  it('12.3 validates against the final schema when the tool has pinned arguments and returns violations as a tool error', () => {
    const t = finalTool({ pinnedArguments: { owner: 'acme' } });
    const r = mapToolCall(
      { finalName: 'gh__create_issue', arguments: { repo: 5 } },
      { upstreamName: 'create_issue', plan: t.plan },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toContain('gh__create_issue');
      expect(r.result.content[0].text).toContain('/repo');
    }
  });

  it('12.3 pinned arguments do not trip additionalProperties false in validation', () => {
    const t = finalTool({ pinnedArguments: { owner: 'acme' } });
    const r = mapToolCall(
      { finalName: 'x', arguments: { repo: 'web' } },
      { upstreamName: 'create_issue', plan: t.plan },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('12.3 validates patched schemas (enum from the patch is enforced)', () => {
    const t = finalTool({
      inputSchemaPatch: [{ op: 'replace', path: '/properties/repo/enum', value: ['web'] }],
    });
    const entry = { upstreamName: 'create_issue', plan: t.plan };
    expect(
      mapToolCall({ finalName: 'x', arguments: { owner: 'o', repo: 'docs' } }, entry, ctx).ok,
    ).toBe(false);
    expect(
      mapToolCall({ finalName: 'x', arguments: { owner: 'o', repo: 'web' } }, entry, ctx).ok,
    ).toBe(true);
  });

  it('12.3 unpatched tools without pinned arguments are left to upstream validation', () => {
    const t = finalTool({ title: 'Just a title' });
    const r = mapToolCall(
      { finalName: 'x', arguments: { repo: 5 } },
      { upstreamName: 'create_issue', plan: t.plan },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('12.3 carries timeout, guard profile and output transform for the router', () => {
    const t = finalTool({
      timeoutMs: 7,
      guardProfileId: 'g',
      outputTransform: { maxTextBytes: 3 },
    });
    const r = mapToolCall(
      { finalName: 'x', arguments: {} },
      { upstreamName: 'create_issue', plan: t.plan },
      ctx,
    );
    expect(r).toMatchObject({
      ok: true,
      timeoutMs: 7,
      guardProfileId: 'g',
      outputTransform: { maxTextBytes: 3 },
    });
  });

  it('12.3 resolvePinned resolves templates in nested values', () => {
    expect(resolvePinned({ a: { b: ['{{user.email}}', 1, null, true] }, c: 'plain' }, ctx)).toEqual(
      {
        a: { b: ['a@acme.com', 1, null, true] },
        c: 'plain',
      },
    );
  });
});

describe('12.4 mapPromptGet', () => {
  const upstreamPrompt = { name: 'review_pr', arguments: [{ name: 'style' }, { name: 'verbose' }] };
  const final = (override: OverridesDocument['prompts'][string]): FinalPrompt => {
    const r = applyToPrompt(upstreamPrompt, {
      installation: doc({ prompts: { review_pr: override } }),
    });
    if (r.kind !== 'prompt') throw new Error('expected prompt');
    return r;
  };

  it('12.4 pinned prompt arguments win and are reported when overridden', () => {
    const p = final({ arguments: { style: { pinned: 'acme' } } });
    const r = mapPromptGet(
      { finalName: 'x', arguments: { style: 'other' } },
      { upstreamName: 'review_pr', plan: p.plan },
      ctx,
    );
    expect(r).toMatchObject({
      ok: true,
      arguments: { style: 'acme' },
      events: [{ type: 'pinned_arg_overridden', argument: 'style' }],
    });
  });

  it('12.4 pinned prompt arguments resolve templates; failure is an error', () => {
    const p = final({ arguments: { style: { pinned: '{{user.email}}' } } });
    expect(
      mapPromptGet({ finalName: 'x' }, { upstreamName: 'review_pr', plan: p.plan }, ctx),
    ).toMatchObject({ arguments: { style: 'a@acme.com' } });
    expect(
      mapPromptGet({ finalName: 'x' }, { upstreamName: 'review_pr', plan: p.plan }, {}),
    ).toMatchObject({ ok: false });
  });

  it('12.4 hidden arguments sent by the client are dropped', () => {
    const p = final({ arguments: { verbose: { hidden: true } } });
    const r = mapPromptGet(
      { finalName: 'x', arguments: { verbose: 'yes', style: 's' } },
      { upstreamName: 'review_pr', plan: p.plan },
      ctx,
    );
    expect(r).toMatchObject({ arguments: { style: 's' } });
    expect(r).not.toHaveProperty('arguments.verbose');
  });

  it('12.4 returns the messagesTransform for response mapping; no plan passes through', () => {
    const mt = { append: [{ role: 'user' as const, content: { type: 'text', text: 'x' } }] };
    const p = final({ messagesTransform: mt });
    expect(
      mapPromptGet({ finalName: 'x' }, { upstreamName: 'review_pr', plan: p.plan }, ctx),
    ).toMatchObject({ messagesTransform: mt });
    expect(
      mapPromptGet({ finalName: 'x', arguments: { a: 'b' } }, { upstreamName: 'u' }, ctx),
    ).toEqual({ ok: true, upstreamName: 'u', arguments: { a: 'b' }, events: [] });
  });
});

describe('12.4 mapResourceRead', () => {
  it('12.4 strips the uriPrefix', () => {
    expect(mapResourceRead('bastion+fs:file:///a', { kind: 'resource', prefixSlug: 'fs' })).toEqual(
      { ok: true, uri: 'file:///a' },
    );
  });

  it('12.4 passes un-prefixed URIs through (seen URIs from tool results)', () => {
    expect(mapResourceRead('file:///a', { kind: 'resource', prefixSlug: 'fs' })).toEqual({
      ok: true,
      uri: 'file:///a',
    });
    expect(mapResourceRead('file:///a', { kind: 'resource' })).toEqual({
      ok: true,
      uri: 'file:///a',
    });
  });

  const template = 'repo://{owner}/{repo}/contents/{path}';
  const route = (prefixSlug?: string) => {
    const r = applyToResourceTemplate(
      { uriTemplate: template, name: 'c' },
      {
        installation: doc({
          uriPrefix: prefixSlug !== undefined,
          resourceTemplates: { [template]: { pinnedVariables: { owner: 'acme' } } },
        }),
      },
      { installationSlug: prefixSlug ?? 's' },
    );
    if (r.kind !== 'resourceTemplate') throw new Error('expected template');
    return r.route;
  };

  it('12.3 reads through a pinned template are mapped back to the upstream template', () => {
    expect(mapResourceRead('repo://acme/web/contents/README.md', route())).toEqual({
      ok: true,
      uri: 'repo://acme/web/contents/README.md',
    });
  });

  it('12.3 reads that change a pinned variable are refused', () => {
    expect(mapResourceRead('repo://evil/web/contents/README.md', route())).toMatchObject({
      ok: false,
      reason: expect.stringContaining('owner'),
    });
  });

  it('12.4 reads that do not match the template are refused', () => {
    expect(mapResourceRead('other://x', route())).toMatchObject({ ok: false });
  });

  it('12.4 prefix stripping and template restoration combine', () => {
    expect(mapResourceRead('bastion+gh:repo://acme/web/contents/a.md', route('gh'))).toEqual({
      ok: true,
      uri: 'repo://acme/web/contents/a.md',
    });
  });
});

const textResult = (text: string) => ({
  content: [{ type: 'text', text }],
  structuredContent: { big: 'x'.repeat(500) },
});

describe('12.3 applyOutputTransform', () => {
  it('12.3 truncates text above maxTextBytes with the marker', () => {
    const r = applyOutputTransform(textResult('abcdefghij'), { maxTextBytes: 4 });
    expect(r.content[0]?.text).toBe('abcd\n[truncated by Bastion: 6 bytes omitted]');
  });

  it('12.3 leaves text at or below the limit alone', () => {
    const input = textResult('abcd');
    expect(applyOutputTransform(input, { maxTextBytes: 4 }).content).toEqual(input.content);
  });

  it('12.3 truncation is UTF-8 safe and never splits a code point', () => {
    const r = applyOutputTransform(textResult('a€€'), { maxTextBytes: 3 });
    // "a" is 1 byte, "€" is 3 bytes; 3 bytes would cut inside the first euro sign.
    expect(r.content[0]?.text).toBe('a\n[truncated by Bastion: 6 bytes omitted]');
  });

  it('12.3 property: kept text is valid UTF-8, within the budget, and the omitted count adds up', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), fc.integer({ min: 1, max: 40 }), (text, max) => {
        const total = new TextEncoder().encode(text).length;
        const r = applyOutputTransform(textResult(text), { maxTextBytes: max });
        const out = r.content[0]?.text as string;
        if (total <= max) {
          expect(out).toBe(text);
          return;
        }
        const m = /^([\s\S]*)\n\[truncated by Bastion: (\d+) bytes omitted\]$/.exec(out);
        expect(m).not.toBeNull();
        const kept = m?.[1] as string;
        const keptBytes = new TextEncoder().encode(kept).length;
        expect(keptBytes).toBeLessThanOrEqual(max);
        expect(keptBytes + Number(m?.[2])).toBe(total);
        expect(text.startsWith(kept)).toBe(true);
        expect(kept).not.toContain('�');
      }),
    );
  });

  it('12.3 drops listed content types', () => {
    const input = {
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'x', mimeType: 'image/png' },
        { type: 'audio', data: 'y' },
      ],
    };
    const r = applyOutputTransform(input, { dropContentTypes: ['image', 'audio'] });
    expect(r.content).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('12.3 never modifies structuredContent or other result fields, and does not mutate input', () => {
    const input = { ...textResult('x'.repeat(100)), isError: false, _meta: { a: 1 } };
    const copy = structuredClone(input);
    const r = applyOutputTransform(input, { maxTextBytes: 1, dropContentTypes: ['text'] });
    expect(r.structuredContent).toEqual(copy.structuredContent);
    expect(r.isError).toBe(false);
    expect(r._meta).toEqual({ a: 1 });
    expect(input).toEqual(copy);
  });

  it('12.3 non-text blocks are kept when only maxTextBytes is set; absent transform or content is a no-op', () => {
    const input = {
      content: [
        { type: 'image', data: 'x' },
        { type: 'text', text: 'abc' },
      ],
    };
    expect(applyOutputTransform(input, { maxTextBytes: 1 }).content[0]).toEqual({
      type: 'image',
      data: 'x',
    });
    expect(applyOutputTransform(input, undefined)).toBe(input);
    const noContent = { structuredContent: {} };
    expect(applyOutputTransform(noContent, { maxTextBytes: 1 })).toBe(noContent);
  });
});

describe('12.3 applyMessagesTransform', () => {
  const msg = (text: string) => ({ role: 'user' as const, content: { type: 'text', text } });

  it('12.3 prepends and appends messages', () => {
    const r = applyMessagesTransform(
      { messages: [msg('mid')], description: 'd' },
      { prepend: [msg('a')], append: [msg('z')] },
    );
    expect(r.messages.map((m) => m.content.text)).toEqual(['a', 'mid', 'z']);
    expect(r.description).toBe('d');
  });

  it('12.3 without a transform the result is untouched', () => {
    const input = { messages: [msg('x')] };
    expect(applyMessagesTransform(input, undefined)).toBe(input);
    expect(applyMessagesTransform(input, {}).messages).toHaveLength(1);
  });
});
