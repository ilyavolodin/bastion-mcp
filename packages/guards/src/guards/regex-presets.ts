import type { GuardAction, GuardPhase } from '../types';

/** Shipped regex presets (13.4). Patterns are RE2 syntax: no lookaround, no backreferences. */

export type PresetRule = {
  id: string;
  label: string;
  pattern: string;
  flags: string;
  /** Cheap literal prefilter: the rule runs only if the text contains one of these (lowercase). */
  hints?: readonly string[];
};

export type PresetDefinition = {
  name: string;
  /** Default action per phase (13.4). */
  defaultActions: Readonly<Record<GuardPhase, GuardAction>>;
  category: 'sensitive-data' | 'injection';
  verdict: 'suspicious' | 'malicious';
  rules: readonly PresetRule[];
};

const secrets: PresetDefinition = {
  name: 'secrets',
  defaultActions: { request: 'warn', response: 'redact', definition: 'warn' },
  category: 'sensitive-data',
  verdict: 'suspicious',
  rules: [
    {
      id: 'aws-access-key',
      label: 'aws-access-key',
      pattern: '\\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\\b',
      flags: '',
      hints: ['akia', 'asia', 'agpa', 'aida', 'aroa', 'anpa', 'anva', 'aipa'],
    },
    {
      id: 'github-token',
      label: 'github-token',
      pattern: '\\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\\b',
      flags: '',
      hints: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'],
    },
    {
      id: 'gitlab-token',
      label: 'gitlab-token',
      pattern: '\\bglpat-[A-Za-z0-9_-]{20,}',
      flags: '',
      hints: ['glpat-'],
    },
    {
      id: 'slack-token',
      label: 'slack-token',
      pattern: '\\bxox[abpr]-[A-Za-z0-9-]{10,}',
      flags: '',
      hints: ['xox'],
    },
    {
      id: 'stripe-key',
      label: 'stripe-key',
      pattern: '\\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\\b',
      flags: '',
      hints: ['k_live_', 'k_test_'],
    },
    {
      id: 'google-api-key',
      label: 'google-api-key',
      pattern: '\\bAIza[0-9A-Za-z_-]{35}',
      flags: '',
      hints: ['aiza'],
    },
    {
      id: 'pem-private-key',
      label: 'private-key',
      pattern:
        '-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:[\\s\\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----)?',
      flags: '',
      hints: ['private key-----'],
    },
    {
      id: 'jwt',
      label: 'jwt',
      pattern: '\\beyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*',
      flags: '',
      hints: ['eyj'],
    },
  ],
};

const injection: PresetDefinition = {
  name: 'injection-heuristics',
  defaultActions: { request: 'warn', response: 'warn', definition: 'warn' },
  category: 'injection',
  verdict: 'suspicious',
  rules: [
    {
      id: 'ignore-previous-instructions',
      label: 'ignore-previous-instructions',
      pattern:
        '\\b(?:ignore|disregard|forget|override|bypass)\\s+(?:all\\s+|any\\s+|the\\s+|your\\s+|my\\s+|these\\s+|those\\s+)*(?:previous|prior|above|earlier|preceding|former|original|system)\\s+(?:instructions?|prompts?|rules|directions|directives|guidelines|context|messages)',
      flags: 'i',
      hints: ['ignore', 'disregard', 'forget', 'override', 'bypass'],
    },
    {
      id: 'ignore-all-instructions',
      label: 'ignore-all-instructions',
      pattern:
        '\\b(?:ignore|disregard)\\s+(?:all|any|every)\\s+(?:of\\s+)?(?:the\\s+|your\\s+)?(?:instructions?|rules|guidelines|safety|restrictions)',
      flags: 'i',
      hints: ['ignore', 'disregard'],
    },
    {
      id: 'new-instructions',
      label: 'new-instructions',
      pattern:
        '\\b(?:new|updated|revised|additional)\\s+(?:system\\s+)?instructions?\\s*:|\\byou\\s+are\\s+now\\s+(?:in\\s+)?(?:developer|dan|jailbreak|unrestricted|god)\\b|\\bdo\\s+not\\s+(?:tell|inform|mention\\s+(?:this\\s+)?to)\\s+the\\s+user\\b',
      flags: 'i',
      hints: ['instruction', 'you are now', 'the user'],
    },
    {
      id: 'chat-template-token',
      label: 'fake-role-marker',
      pattern:
        '<\\|(?:im_start|im_end|system|assistant|user|endoftext)\\|>|\\[/?INST\\]|<</?SYS>>|</?(?:system|assistant)>',
      flags: 'i',
      hints: [
        '<|',
        '[inst]',
        '[/inst]',
        '<<sys>>',
        '<</sys>>',
        '<system>',
        '</system>',
        '<assistant>',
        '</assistant>',
      ],
    },
    {
      id: 'role-line-marker',
      label: 'fake-role-marker',
      pattern: '^[ \\t]*(?:#{1,4}[ \\t]*)?(?:SYSTEM|ASSISTANT)[ \\t]*(?:PROMPT|MESSAGE)?[ \\t]*:',
      flags: 'm',
      hints: ['system', 'assistant'],
    },
    {
      id: 'hidden-html-comment',
      label: 'hidden-comment-for-assistant',
      pattern:
        '<!--[\\s\\S]{0,400}?\\b(?:assistant|llm|language model|ai agent|ai model|claude|chatgpt|gpt-?4|copilot)\\b[\\s\\S]{0,400}?-->',
      flags: 'i',
      hints: ['<!--'],
    },
    {
      id: 'markdown-image-exfil',
      label: 'markdown-image-exfiltration',
      pattern:
        '!\\[[^\\]]{0,200}\\]\\(\\s*https?://[^)\\s]{1,300}[?&](?:[^=\\s)&]{1,40}=[^&\\s)]{24,}|(?:data|secret|token|key|password|passwd|session|cookie|prompt|content|payload|exfil|leak|chat|history)=[^&\\s)]+)[^)\\s]{0,300}\\)',
      flags: 'i',
      hints: ['!['],
    },
  ],
};

export const REGEX_PRESETS: Readonly<Record<string, PresetDefinition>> = {
  secrets,
  'injection-heuristics': injection,
};
