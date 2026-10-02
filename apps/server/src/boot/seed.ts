/**
 * First-start seeding (19.2, 22.5, 14.3, 11.6): every step is idempotent and only fills what is missing, so an
 * admin's later changes survive restarts.
 */
import { createHash } from 'node:crypto';
import { ORG_SETTING_DEFAULTS, type OrgSettingKey } from '@bastion-mcp/core';
import { ORG_DEFAULT_PROFILE } from '@bastion-mcp/guards';
import { defaultRules } from '@bastion-mcp/limits';
import { type KeyringPurpose, rotateKeyring } from '@bastion-mcp/secrets';
import type { Infra } from '../infra';
import { keyStoreOf } from './key-store';

export const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

/** Deterministic UUID so a restart never creates a second copy of a seeded row. */
export const seedId = (name: string): string => {
  const h = createHash('sha256').update(`bastion-seed:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export type SeedReport = {
  settings: string[];
  guardProfile: boolean;
  registrySource: boolean;
  limitRules: number;
  keys: KeyringPurpose[];
};

const SYSTEM_AUDIT = { actorType: 'system', actorId: null } as const;

export const seedDefaults = async (infra: Infra): Promise<SeedReport> => {
  const { repos, db } = infra;
  const report: SeedReport = {
    settings: [],
    guardProfile: false,
    registrySource: false,
    limitRules: 0,
    keys: [],
  };

  // Org settings: only keys that have no stored row.
  const stored = new Set(
    (await db.prisma.orgSetting.findMany({ select: { key: true } })).map((r) => r.key),
  );
  for (const key of Object.keys(ORG_SETTING_DEFAULTS) as OrgSettingKey[]) {
    if (stored.has(key)) continue;
    await repos.orgSettings.set(key, ORG_SETTING_DEFAULTS[key] as never, { audit: SYSTEM_AUDIT });
    report.settings.push(key);
  }

  // Shipped org default guard profile (13.7): one is_org_default row, mirrored into settings.guards.
  if ((await repos.guardProfiles.getOrgDefault()) === null) {
    const id = seedId('guard-profile:org-default');
    const existing = await repos.guardProfiles.get(id);
    if (!existing) {
      await repos.guardProfiles.create(
        {
          id,
          name: 'Org default',
          latencyBudgetMs: ORG_DEFAULT_PROFILE.latencyBudgetMs,
          guards: [...ORG_DEFAULT_PROFILE.guards],
          settings: {
            maxScanBytes: ORG_DEFAULT_PROFILE.maxScanBytes,
            onOversize: ORG_DEFAULT_PROFILE.onOversize,
            onDrift: ORG_DEFAULT_PROFILE.onDrift,
            riskEscalation: { ...ORG_DEFAULT_PROFILE.riskEscalation },
          },
        },
        SYSTEM_AUDIT,
      );
    }
    await repos.guardProfiles.setOrgDefault(id, SYSTEM_AUDIT);
    report.guardProfile = true;
  }

  // Official registry: preconfigured, disabled until an admin enables it (11.6).
  const sources = await repos.registrySources.list();
  if (!sources.some((s) => s.baseUrl === OFFICIAL_REGISTRY_URL)) {
    await repos.registrySources.save(
      {
        id: seedId('registry-source:official'),
        name: 'Official MCP Registry',
        baseUrl: OFFICIAL_REGISTRY_URL,
        trust: 'official',
        enabled: false,
        syncIntervalS: 3600,
        lastUpdatedSince: null,
        lastSync: null,
      },
      SYSTEM_AUDIT,
    );
    report.registrySource = true;
  }

  // Default limit rules (14.3): only into an empty table.
  if ((await repos.limitRules.list()).length === 0) {
    for (const rule of defaultRules()) {
      await repos.limitRules.create(
        {
          id: seedId(rule.id),
          name: rule.name,
          subject: rule.subject,
          subjectMatch: rule.subjectMatch,
          scope: rule.scope,
          kind: rule.kind,
          params: rule.params,
          metric: rule.metric,
          action: rule.action,
          enabled: rule.enabled,
        },
        SYSTEM_AUDIT,
      );
      report.limitRules += 1;
    }
  }

  // Signing keys and the state keyring (22.3): created when none is usable.
  const keyStore = keyStoreOf(infra);
  const now = new Date();
  const usable = (keys: { activeFrom: Date; retireAfter: Date }[]) =>
    keys.some((k) => k.activeFrom <= now && k.retireAfter > now);
  const missing: KeyringPurpose[] = [];
  if (!usable(await keyStore.listSigningKeys('as'))) missing.push('as');
  if (!usable(await keyStore.listSigningKeys('upstream-client'))) missing.push('upstream-client');
  if (!usable(await keyStore.listStateKeys())) missing.push('state');
  for (const purpose of missing) {
    await rotateKeyring(keyStore, purpose);
    report.keys.push(purpose);
  }
  return report;
};
