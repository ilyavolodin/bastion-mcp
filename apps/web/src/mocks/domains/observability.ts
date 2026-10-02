/**
 * MSW mock of the observability routes, typed by the generated OpenAPI types (see `../http.ts`). `buildObservabilityData` seeds the
 * rows (API shapes: `Schemas['...']`), `observabilityHandlers` answer the routes from `getDb().data.observability`.
 */
import type { HttpHandler } from 'msw';
import type { SampleFactory } from '../http';

export type ObservabilityData = Record<string, never>;

export const buildObservabilityData = (_now: number): ObservabilityData => ({});

export const observabilityHandlers: HttpHandler[] = [];

/** One valid call per operation of this domain (checked against the OpenAPI document by route-contract.test.ts). */
export const observabilitySamples: SampleFactory = () => [];
