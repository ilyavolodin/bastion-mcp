/**
 * MSW mock of the registry routes, typed by the generated OpenAPI types (see `../http.ts`). `buildRegistryData` seeds the
 * rows (API shapes: `Schemas['...']`), `registryHandlers` answer the routes from `getDb().data.registry`.
 */
import type { HttpHandler } from 'msw';
import type { SampleFactory } from '../http';

export type RegistryData = Record<string, never>;

export const buildRegistryData = (_now: number): RegistryData => ({});

export const registryHandlers: HttpHandler[] = [];

/** One valid call per operation of this domain (checked against the OpenAPI document by route-contract.test.ts). */
export const registrySamples: SampleFactory = () => [];
