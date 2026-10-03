import type { Schemas } from '@/api/schema';
import type { Upstream } from '../../servers/overrides-engine';

export type Installation = Schemas['Installation'];
export type Endpoint = Schemas['Endpoint'];
export type EgressEntry = Schemas['EgressEntry'];

export type ServersData = {
  installations: Installation[];
  endpoints: Endpoint[];
  /** Recent egress decisions of the sandboxes, by installation id. */
  egress: Record<string, EgressEntry[]>;
  /** Upstream definitions the servers list, by installation id (what the router reads from the instance). */
  upstream: Record<string, Upstream>;
};
