/**
 * MSW mock of the servers routes, typed by the generated OpenAPI types (see `../http.ts`). `buildServersData` seeds the
 * rows (API shapes: `Schemas['...']`), `serversHandlers` answer the routes from `getDb().data.servers`.
 */
import type { HttpHandler } from 'msw';
import type { SampleFactory } from '../http';

export type ServersData = Record<string, never>;

export const buildServersData = (_now: number): ServersData => ({});

export const serversHandlers: HttpHandler[] = [];

/** One valid call per operation of this domain (checked against the OpenAPI document by route-contract.test.ts). */
export const serversSamples: SampleFactory = () => [];
