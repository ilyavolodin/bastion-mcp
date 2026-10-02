/**
 * Call-time mapping (12.4): final names to upstream calls with pinned and default arguments,
 * validation, resource read mapping, and response mapping (`outputTransform`, `messagesTransform`).
 */
import {
  canonicalJson,
  resolveTemplate,
  type TemplateContext,
  TemplateError,
} from '@bastion-mcp/core';
import type { JsonValue, MessagesTransform, OutputTransform, PromptMessage } from './schema';
import { isObject, validateAgainstSchema } from './schema-tools';
import type { PromptPlan, ResourceRoute, ToolPlan } from './types';
import { matchUriTemplate, stripUriPrefix } from './uri';

export type PinnedArgOverriddenEvent = { type: 'pinned_arg_overridden'; argument: string };

export type ToolErrorResult = {
  isError: true;
  content: [{ type: 'text'; text: string }];
};

const errorResult = (text: string): ToolErrorResult => ({
  isError: true,
  content: [{ type: 'text', text }],
});

const sameJson = (a: unknown, b: unknown): boolean => {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
};

const resolveJson = (value: JsonValue, ctx: TemplateContext): JsonValue => {
  if (typeof value === 'string') return value.includes('{{') ? resolveTemplate(value, ctx) : value;
  if (Array.isArray(value)) return value.map((v) => resolveJson(v, ctx));
  if (isObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveJson(v, ctx);
    return out;
  }
  return value;
};

/** Resolves value templates (`{{user.email}}`) in pinned values for this call (12.3). */
export const resolvePinned = (
  pinned: Readonly<Record<string, JsonValue>>,
  ctx: TemplateContext,
): Record<string, JsonValue> => {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(pinned)) out[key] = resolveJson(value, ctx);
  return out;
};

export type ToolRoutingEntry = {
  upstreamName: string;
  /** Absent for tools without overrides: arguments pass through untouched. */
  plan?: ToolPlan | undefined;
};

export type MappedToolCall =
  | {
      ok: true;
      upstreamName: string;
      arguments: Record<string, JsonValue>;
      events: PinnedArgOverriddenEvent[];
      timeoutMs?: number;
      guardProfileId?: string | null;
      outputTransform?: OutputTransform;
    }
  | { ok: false; result: ToolErrorResult };

/**
 * `tools/call` (12.4): merges defaults, client arguments and pinned values (pinned wins, a
 * differing client value is reported as `pinned_arg_overridden`), validates the client-visible
 * arguments against the final schema when the tool has pinned arguments or a patch, and returns the
 * upstream call. Unpatched tools are left to upstream validation.
 */
export const mapToolCall = (
  call: { finalName: string; arguments?: Record<string, JsonValue> | undefined },
  entry: ToolRoutingEntry,
  ctx: TemplateContext,
): MappedToolCall => {
  const sent = call.arguments ?? {};
  const plan = entry.plan;
  if (!plan)
    return { ok: true, upstreamName: entry.upstreamName, arguments: { ...sent }, events: [] };

  let pinned: Record<string, JsonValue>;
  try {
    pinned = resolvePinned(plan.pinned, ctx);
  } catch (error) {
    if (!(error instanceof TemplateError)) throw error;
    return { ok: false, result: errorResult(`Cannot resolve pinned argument: ${error.message}`) };
  }

  const events: PinnedArgOverriddenEvent[] = [];
  const merged: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(plan.defaults)) merged[key] = value;
  for (const [key, value] of Object.entries(sent)) if (value !== undefined) merged[key] = value;
  for (const [key, value] of Object.entries(pinned)) {
    if (key in sent && !sameJson(sent[key], value)) {
      events.push({ type: 'pinned_arg_overridden', argument: key });
    }
    delete merged[key];
  }

  if (plan.validate) {
    const violations = validateAgainstSchema(plan.schema, merged);
    if (violations.length > 0) {
      return {
        ok: false,
        result: errorResult(
          `Invalid arguments for ${call.finalName}:\n${violations.map((v) => `- ${v}`).join('\n')}`,
        ),
      };
    }
  }

  const out: MappedToolCall = {
    ok: true,
    upstreamName: plan.upstreamName,
    arguments: { ...merged, ...pinned },
    events,
  };
  if (plan.timeoutMs !== undefined) out.timeoutMs = plan.timeoutMs;
  if (plan.guardProfileId !== undefined) out.guardProfileId = plan.guardProfileId;
  if (plan.outputTransform) out.outputTransform = plan.outputTransform;
  return out;
};

export type PromptRoutingEntry = { upstreamName: string; plan?: PromptPlan | undefined };

export type MappedPromptGet = {
  ok: true;
  upstreamName: string;
  arguments: Record<string, string>;
  events: PinnedArgOverriddenEvent[];
  messagesTransform?: MessagesTransform;
};

/** `prompts/get` (12.4): pinned arguments win, hidden arguments are dropped. */
export const mapPromptGet = (
  call: { finalName: string; arguments?: Record<string, string> | undefined },
  entry: PromptRoutingEntry,
  ctx: TemplateContext,
): MappedPromptGet | { ok: false; error: string } => {
  const sent = call.arguments ?? {};
  const plan = entry.plan;
  if (!plan) {
    return { ok: true, upstreamName: entry.upstreamName, arguments: { ...sent }, events: [] };
  }
  const args: Record<string, string> = { ...sent };
  const events: PinnedArgOverriddenEvent[] = [];
  for (const name of plan.hidden) delete args[name];
  try {
    for (const [name, template] of Object.entries(plan.pinned)) {
      const value = template.includes('{{') ? resolveTemplate(template, ctx) : template;
      if (name in sent && sent[name] !== value) {
        events.push({ type: 'pinned_arg_overridden', argument: name });
      }
      args[name] = value;
    }
  } catch (error) {
    if (!(error instanceof TemplateError)) throw error;
    return { ok: false, error: `Cannot resolve pinned argument: ${error.message}` };
  }
  const out: MappedPromptGet = {
    ok: true,
    upstreamName: plan.upstreamName,
    arguments: args,
    events,
  };
  if (plan.messagesTransform) out.messagesTransform = plan.messagesTransform;
  return out;
};

export type MappedResourceRead = { ok: true; uri: string } | { ok: false; reason: string };

/**
 * `resources/read` (12.4): strips the `bastion+{slug}:` prefix and, for a pinned template, checks
 * the URI against the upstream template so pinned variables keep their pinned values.
 */
export const mapResourceRead = (uri: string, route: ResourceRoute): MappedResourceRead => {
  const stripped = route.prefixSlug === undefined ? null : stripUriPrefix(uri, route.prefixSlug);
  const upstreamUri = stripped ?? uri;
  if (route.kind === 'resource') return { ok: true, uri: upstreamUri };

  const variables = matchUriTemplate(route.upstreamTemplate, upstreamUri);
  if (!variables) {
    return { ok: false, reason: `URI does not match template ${route.upstreamTemplate}` };
  }
  for (const [name, expected] of Object.entries(route.pinnedVariables)) {
    if (variables[name] !== expected) {
      return { ok: false, reason: `variable "${name}" is pinned and cannot be changed` };
    }
  }
  return { ok: true, uri: upstreamUri };
};

type ContentBlock = { type: string; text?: unknown } & Record<string, unknown>;

export type ToolResultLike = { content?: ContentBlock[] } & Record<string, unknown>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a code point. */
const truncateUtf8 = (text: string, maxBytes: number): { text: string; omitted: number } => {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, omitted: 0 };
  let cut = maxBytes;
  while (cut > 0 && ((bytes[cut] as number) & 0xc0) === 0x80) cut -= 1;
  return { text: decoder.decode(bytes.subarray(0, cut)), omitted: bytes.length - cut };
};

/**
 * `outputTransform` (12.3): drops listed content types and truncates text blocks above
 * `maxTextBytes`, appending `[truncated by Bastion: <n> bytes omitted]`. `structuredContent` and
 * everything else in the result is left untouched; the input is not modified.
 */
export const applyOutputTransform = <T extends ToolResultLike>(
  result: T,
  transform: OutputTransform | undefined,
): T => {
  if (!transform || !Array.isArray(result.content)) return result;
  const drop = new Set(transform.dropContentTypes ?? []);
  const content: ContentBlock[] = [];
  for (const block of result.content) {
    if (drop.has(block.type)) continue;
    if (
      block.type === 'text' &&
      typeof block.text === 'string' &&
      transform.maxTextBytes !== undefined
    ) {
      const { text, omitted } = truncateUtf8(block.text, transform.maxTextBytes);
      content.push(
        omitted === 0
          ? block
          : { ...block, text: `${text}\n[truncated by Bastion: ${omitted} bytes omitted]` },
      );
    } else content.push(block);
  }
  return { ...result, content };
};

export type PromptResultLike = { messages: PromptMessage[] } & Record<string, unknown>;

/** `messagesTransform` (12.3): prepends and appends messages to a `prompts/get` result. */
export const applyMessagesTransform = <T extends PromptResultLike>(
  result: T,
  transform: MessagesTransform | undefined,
): T => {
  if (!transform) return result;
  return {
    ...result,
    messages: [...(transform.prepend ?? []), ...result.messages, ...(transform.append ?? [])],
  };
};
