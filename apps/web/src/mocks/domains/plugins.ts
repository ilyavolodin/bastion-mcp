/**
 * MSW mock of the plugins routes, typed by the generated OpenAPI types (see `../http.ts`). `buildPluginsData` seeds the
 * rows (API shapes: `Schemas['...']`), `pluginsHandlers` answer the routes from `getDb().data.plugins`.
 */
import type { HttpHandler } from 'msw';
import type { SampleFactory } from '../http';

export type PluginsData = Record<string, never>;

export const buildPluginsData = (_now: number): PluginsData => ({});

export const pluginsHandlers: HttpHandler[] = [];

/** One valid call per operation of this domain (checked against the OpenAPI document by route-contract.test.ts). */
export const pluginsSamples: SampleFactory = () => [];
