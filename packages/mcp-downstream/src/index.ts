export type {
  Exchange,
  LegacyAdapter,
  ListenAdapter,
  NotifyEvent,
  OpRunner,
  StreamTarget,
} from './adapters/contracts';
export { createLegacyAdapter } from './adapters/legacy';
export { createListenAdapter } from './adapters/modern/listen';
export { createModernAdapter } from './adapters/modern/server';
export { fullyLocal, partitionInputRequests } from './bridge';
export type { BastionRequestContext } from './context';
export { bastionRequestContext, currentRequestContext } from './context';
export type { Downstream, DownstreamConfig, DownstreamDeps } from './downstream';
export { createDownstream } from './downstream';
export { isLegacyExchange, registerMcpRoutes } from './http/plugin';
export { EndpointResolver } from './http/resolver';
export { NotifyHub } from './notify-hub';
export type { OperationDeps, ReadCachePort } from './operations/deps';
export { createOperations, createOpRunner } from './operations/registry';
export { CONFIRM_KEY, CONFIRM_MARKER } from './operations/routed';
export type * from './ports';
export type * from './types';
export { upstreamPortFrom } from './upstream-port';
