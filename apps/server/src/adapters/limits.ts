import {
  compileRulesFor,
  createLimiter,
  defaultRules,
  parseRule,
  type Rule,
} from '@bastion-mcp/limits';
import type { LimitService } from '../contracts';
import type { Infra } from '../infra';
import { SettingsCache, watchConfig } from './config-watch';

/**
 * The production limiter (14.2): Redis with automatic fail-open fallback, quota periods in the org time zone, and the
 * rules from `limit_rules` compiled per call. When the table holds no rules at all the built-in defaults of 14.3
 * apply, so a deployment that never seeded still gets a per-user cap.
 */
export const createLimitService = (infra: Infra): LimitService & { ready(): Promise<void> } => {
  const settings = new SettingsCache(infra);
  let rules: Rule[] = defaultRules();

  const refresh = async (): Promise<void> => {
    try {
      const rows = await infra.repos.limitRules.list({ enabled: true });
      if (rows.length === 0) {
        rules = defaultRules();
        return;
      }
      const parsed: Rule[] = [];
      for (const row of rows) {
        try {
          parsed.push(
            parseRule({
              id: row.id,
              name: row.name,
              subject: row.subject,
              subjectMatch: row.subjectMatch,
              scope: row.scope,
              kind: row.kind,
              params: row.params,
              metric: row.metric,
              ...(row.cost ? { cost: row.cost } : {}),
              action: row.action,
              enabled: row.enabled,
            }),
          );
        } catch (error) {
          infra.logger.warn({ rule: row.id, err: String(error) }, 'ignoring invalid limit rule');
        }
      }
      rules = parsed;
    } catch (error) {
      infra.logger.warn(
        { err: String(error) },
        'limit rules refresh failed; keeping previous rules',
      );
    }
  };

  const limiter = createLimiter({
    redis: infra.redis as never,
    expectedWorkers: infra.config.expectedWorkers,
    timeZone: () => settings.get().org.timeZone,
    onDegraded: (value) => {
      if (value === 1) infra.metrics.limitsDegraded.add(1, {});
    },
  });

  return {
    limiter,
    rules: {
      rulesFor: (op, endpoint) => compileRulesFor(op.principal, endpoint, rules),
    },
    async ready() {
      await Promise.all([settings.refresh(), refresh()]);
    },
    watch() {
      const stopSettings = settings.watch();
      const stop = watchConfig(infra, () => void refresh());
      void refresh();
      return () => {
        stopSettings();
        stop();
      };
    },
  };
};
