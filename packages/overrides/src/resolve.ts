/**
 * Per-item resolution (12.3): within a layer matching entries fold in application order (globs short
 * to long, exact last); the installation layer then overrides the catalog layer field by field.
 */
import { matchingEntries } from './matching';
import {
  mergePromptOverride,
  mergeResourceOverride,
  mergeResourceTemplateOverride,
  mergeToolOverride,
} from './merge';
import type {
  PromptOverride,
  ResourceOverride,
  ResourceTemplateOverride,
  ToolOverride,
} from './schema';
import type { OverrideLayers } from './types';

const fold = <T extends object>(
  record: Readonly<Record<string, T>> | undefined,
  subject: string,
  merge: (a: T, b: T) => T,
): T => {
  let acc = {} as T;
  for (const entry of matchingEntries(record ?? {}, subject)) acc = merge(acc, entry.value);
  return acc;
};

const resolveItem = <T extends object>(
  catalog: Readonly<Record<string, T>> | undefined,
  installation: Readonly<Record<string, T>> | undefined,
  subject: string,
  merge: (a: T, b: T) => T,
): T => merge(fold(catalog, subject, merge), fold(installation, subject, merge));

export const resolveToolOverride = (layers: OverrideLayers, name: string): ToolOverride =>
  resolveItem(layers.catalog?.tools, layers.installation?.tools, name, mergeToolOverride);

export const resolvePromptOverride = (layers: OverrideLayers, name: string): PromptOverride =>
  resolveItem(layers.catalog?.prompts, layers.installation?.prompts, name, mergePromptOverride);

export const resolveResourceOverride = (layers: OverrideLayers, uri: string): ResourceOverride =>
  resolveItem(
    layers.catalog?.resources,
    layers.installation?.resources,
    uri,
    mergeResourceOverride,
  );

export const resolveResourceTemplateOverride = (
  layers: OverrideLayers,
  uriTemplate: string,
): ResourceTemplateOverride =>
  resolveItem(
    layers.catalog?.resourceTemplates,
    layers.installation?.resourceTemplates,
    uriTemplate,
    mergeResourceTemplateOverride,
  );
