import { computeDrift, type Definition, pinDefinition, pinKey } from '@bastion-mcp/guards';
import type { InstallationRegistry, PinChecker } from '@bastion-mcp/mcp-upstream';
import type { GuardService } from '../../contracts';
import type { Infra } from '../../infra';

const asDefinition = (tool: unknown): Definition =>
  ({ ...(tool as object), kind: 'tool' }) as Definition;

/**
 * `PinChecker` (13.6) backed by `definition_pins` and `drift_reviews`. The first list of a subject pins every tool
 * (trust on first use); later lists are compared with `computeDrift` under the effective `onDrift` policy of the
 * guard profile layers. New and changed tools open (or reuse) a review and notify the org admins and the owner of a
 * personal installation. The subject is the catalog version, or the installation for personal ones.
 */
export const createPinChecker = (
  infra: Infra,
  deps: {
    installations: Pick<InstallationRegistry, 'get'>;
    guards: Pick<GuardService, 'profiles'>;
  },
): PinChecker => ({
  async check(installationId, tools) {
    const installation = await deps.installations.get(installationId);
    if (!installation) return { ok: true };
    const subject =
      installation.origin === 'personal'
        ? { installationId }
        : { catalogVersionId: installation.catalogVersionId };
    const layers = deps.guards.profiles.layersFor({
      installationId,
      catalogEntryId: installation.catalogEntryId,
      catalogVersionId: installation.catalogVersionId,
    });
    const onDrift = layers.catalogVersion?.onDrift ?? layers.org?.onDrift ?? 'hideChanged';
    const defs = tools.map(asDefinition);
    const pinSet = await infra.repos.definitionPins.pinSet(subject);
    const drift = computeDrift(pinSet, defs, onDrift);

    if (drift.firstPin) {
      if (defs.length > 0) {
        await infra.repos.definitionPins.upsertPins(
          subject,
          defs.map((def) => ({
            itemKind: 'tool' as const,
            itemKey: def.name,
            hash: pinDefinition(def),
            definition: JSON.parse(JSON.stringify(def)) as Record<string, unknown>,
          })),
        );
      }
      return { ok: true };
    }

    const changedItems = drift.items.filter((i) => i.change !== 'removed');
    if (changedItems.length === 0) return { ok: true };

    for (const item of changedItems) {
      if (!item.after || item.newPin === undefined) continue;
      const { review, created } = await infra.repos.driftReviews.open(subject, {
        itemKind: 'tool',
        itemKey: item.name,
        oldHash: item.previousPin ?? null,
        newHash: item.newPin,
        newDefinition: JSON.parse(JSON.stringify(item.after)) as Record<string, unknown>,
      });
      if (created)
        await notifyOwners(infra, installation.ownerUserId, review.id, installationId, item.name);
    }

    const changed = changedItems.map((i) => i.name);
    if (drift.installationDisabled) return { ok: false, changed, action: 'block' };
    if (onDrift === 'hideChanged') return { ok: false, changed, action: 'hideChanged' };
    return { ok: false, changed, action: 'warn' };
  },
});

const notifyOwners = async (
  infra: Infra,
  ownerUserId: string | null,
  reviewId: string,
  installationId: string,
  tool: string,
): Promise<void> => {
  try {
    const admins = await infra.db.prisma.user.findMany({
      where: { orgRole: 'admin', status: 'active' },
      select: { id: true },
    });
    const recipients = new Set(admins.map((a) => a.id));
    if (ownerUserId) recipients.add(ownerUserId);
    for (const userId of recipients) {
      await infra.repos.notifications.create({
        userId,
        kind: 'drift',
        payload: {
          title: `Definition changed: ${tool}`,
          data: { message: 'Review it on the Security page.', reviewId, installationId, tool },
        },
      });
    }
  } catch (error) {
    infra.logger.warn({ err: String(error) }, 'drift notification failed');
  }
};

export { pinKey };
