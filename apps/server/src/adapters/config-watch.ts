import { ORG_SETTING_DEFAULTS, type OrgSettings, REDIS_CHANNELS } from '@bastion-mcp/core';
import { z } from 'zod';
import type { Infra } from '../infra';

/** A `bastion:config` message: `{topic}` alone (API writes) or `{scope, id, version}` (repositories), 4.3. */
export type ConfigMessage = {
  topic?: string | undefined;
  scope?: string | undefined;
  id?: string | undefined;
  version?: string | undefined;
};

const messageSchema = z.object({
  topic: z.string().optional(),
  scope: z.string().optional(),
  id: z.string().optional(),
  version: z.union([z.string(), z.number()]).optional(),
});

export const parseConfigMessage = (raw: string): ConfigMessage | undefined => {
  try {
    const parsed = messageSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    const { version, ...rest } = parsed.data;
    return { ...rest, ...(version === undefined ? {} : { version: String(version) }) };
  } catch {
    return undefined;
  }
};

/** Subscribes to `bastion:config`; returns the unsubscribe function. Handler errors never propagate. */
export const watchConfig = (infra: Infra, handler: (event: ConfigMessage) => void): (() => void) =>
  infra.pubsub.subscribe(REDIS_CHANNELS.config, (raw) => {
    const event = parseConfigMessage(raw);
    if (!event) return;
    try {
      handler(event);
    } catch (error) {
      infra.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'config handler failed',
      );
    }
  });

/**
 * Org settings with a synchronous snapshot for hot paths (time zone, preview capture). Starts from the defaults,
 * `refresh()` loads the database values; `watch()` refreshes on every config event.
 */
export class SettingsCache {
  private current: OrgSettings = ORG_SETTING_DEFAULTS;

  constructor(private readonly infra: Infra) {}

  get(): OrgSettings {
    return this.current;
  }

  async refresh(): Promise<OrgSettings> {
    try {
      this.current = await this.infra.repos.orgSettings.getAll();
    } catch (error) {
      this.infra.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'org settings refresh failed',
      );
    }
    return this.current;
  }

  watch(): () => void {
    return watchConfig(this.infra, () => void this.refresh());
  }
}
