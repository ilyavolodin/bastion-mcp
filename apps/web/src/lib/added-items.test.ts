import { describe, expect, it } from 'vitest';
import {
  definitionToDraft,
  draftToDefinition,
  emptyDraft,
  formatArgs,
  parseArgs,
  undeclaredPlaceholders,
} from './added-items';
import { setAddedItem, validateOverrideText } from './override-schema';

describe('12.2 the form for hosted items', () => {
  it('prompt arguments: one per line, * marks required, text after a colon describes', () => {
    const args = parseArgs('repo*: the repository\nfocus\n\n  depth* ');
    expect(args).toEqual([
      { name: 'repo', description: 'the repository', required: true },
      { name: 'focus' },
      { name: 'depth', required: true },
    ]);
    expect(parseArgs(formatArgs(args))).toEqual(args);
  });

  it('a prompt becomes its definition and back, leaving empty optional fields out', () => {
    const draft = {
      ...emptyDraft('prompt'),
      key: 'review',
      description: 'Review a change',
      args: 'repo*',
      messages: [{ role: 'user' as const, text: 'Review {{repo}}' }],
    };
    const def = draftToDefinition(draft);
    expect(def).toEqual({
      description: 'Review a change',
      arguments: [{ name: 'repo', required: true }],
      messages: [{ role: 'user', text: 'Review {{repo}}' }],
    });
    expect(definitionToDraft('prompt', 'review', def)).toMatchObject({
      key: 'review',
      args: 'repo*',
      description: 'Review a change',
    });
  });

  it('a resource becomes its definition, with the mime type only when given', () => {
    const draft = {
      ...emptyDraft('resource'),
      key: 'notes://welcome',
      name: 'welcome',
      text: 'Hi',
    };
    expect(draftToDefinition(draft)).toEqual({ name: 'welcome', text: 'Hi' });
    expect(draftToDefinition({ ...draft, mimeType: 'text/markdown' })).toMatchObject({
      mimeType: 'text/markdown',
    });
  });

  it('the stored document stays valid and the item can be removed again', () => {
    const draft = {
      ...emptyDraft('resource'),
      key: 'notes://welcome',
      name: 'welcome',
      text: 'Hi',
    };
    const doc = setAddedItem({ version: 1 }, 'resources', draft.key, draftToDefinition(draft));
    expect(validateOverrideText(JSON.stringify(doc)).ok).toBe(true);
    expect(setAddedItem(doc, 'resources', draft.key, undefined)).toEqual({ version: 1 });
  });

  it('names placeholders that nothing declares, because they would be sent as written', () => {
    const prompt = {
      ...emptyDraft('prompt'),
      key: 'p',
      args: 'repo',
      messages: [{ role: 'user' as const, text: '{{repo}} {{who}}' }],
    };
    expect(undeclaredPlaceholders(prompt)).toEqual(['who']);
    const template = {
      ...emptyDraft('template'),
      key: 'notes://{book}/page/{id}',
      text: '{{book}} {{id}} {{page}}',
    };
    expect(undeclaredPlaceholders(template)).toEqual(['page']);
  });
});
