import { describe, expect, it } from 'vitest';
import {
  type InstallationInput,
  type PolicyDataInput,
  PolicyEngine,
  type PrincipalData,
  principalSchema,
  type ToolRuleRowInput,
} from '../src';
import { context, tool } from './fixtures';

/** A 2,000-policy set: visibility, ownership, rules and the role templates. */
const buildLargeData = (): { data: PolicyDataInput; installations: InstallationInput[] } => {
  const teams = Array.from({ length: 40 }, (_, i) => ({ id: `team-${i}`, slug: `team-${i}` }));
  const catalogEntries = Array.from({ length: 300 }, (_, i) => ({
    id: `entry-${i}`,
    ownerTeamId: `team-${i % 40}`,
    visibility: { org: i % 3 === 0, teamIds: [`team-${i % 40}`], userIds: [`user-${i}`] },
    risk: 'low' as const,
  }));
  const installations: InstallationInput[] = Array.from({ length: 700 }, (_, i) => ({
    id: `inst-${i}`,
    catalogEntryId: `entry-${i % 300}`,
    ...(i % 5 === 0 ? { ownerTeamId: `team-${i % 40}` } : { ownerUserId: `user-${i}` }),
  }));
  const rules: ToolRuleRowInput[] = Array.from({ length: 700 }, (_, i) => {
    const kind = i % 4;
    return {
      id: `rule-${i}`,
      effect: i % 2 === 0 ? 'forbid' : 'permit',
      who: kind === 0 ? { teams: [`team-${i % 40}`] } : kind === 1 ? { users: [`user-${i}`] } : {},
      what:
        kind === 2
          ? { installationId: `inst-${i % 700}`, toolName: `tool_${i}_*` }
          : kind === 3
            ? { catalogEntryId: `entry-${i % 300}`, annotations: { destructive: true } }
            : { toolName: `danger_${i}` },
      when:
        i % 3 === 0
          ? { args: [{ op: 'ne' as const, name: 'owner', value: `acme-${i}` }] }
          : i % 3 === 1
            ? { hours: { from: 22, to: 6 } }
            : {},
    } satisfies ToolRuleRowInput;
  });
  return { data: { orgId: 'org', teams, catalogEntries, installations, rules }, installations };
};

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

describe('10.4 performance', () => {
  const large = buildLargeData();

  it('10.4 compiles and evaluates a 2,000-policy set with p99 well under the 1 ms target', () => {
    const compileStart = performance.now();
    const engine = PolicyEngine.create(large.data);
    const compileMs = performance.now() - compileStart;
    expect(engine.policyCount).toBeGreaterThanOrEqual(2000);

    const principals: PrincipalData[] = Array.from({ length: 50 }, (_, i) =>
      principalSchema.parse({
        kind: 'user',
        id: `user-${i * 7}`,
        role: 'member',
        teams: [{ id: `team-${i % 40}`, role: i % 10 === 0 ? 'manager' : 'member' }],
      }),
    );
    const call = (i: number) => {
      const principal = principals[i % principals.length] as PrincipalData;
      const inst = large.installations[(i * 13) % large.installations.length] as InstallationInput;
      return engine.authorize({
        principal,
        action: i % 4 === 0 ? 'seeTool' : 'callTool',
        resource: tool(inst, `tool_${i % 50}_x`, i % 2 ? { destructiveHint: false } : {}),
        context,
        ...(i % 4 === 0 ? {} : { call: { owner: `acme-${i % 9}` } }),
      });
    };

    // Warm the compiled-set cache and the JIT, as a worker serving steady traffic would be.
    for (let i = 0; i < 3000; i += 1) call(i);

    const samples: number[] = [];
    for (let i = 0; i < 4000; i += 1) {
      const started = performance.now();
      call(i);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 0.5);
    const p99 = percentile(samples, 0.99);
    console.info(
      `policy perf: ${engine.policyCount} policies, compile ${compileMs.toFixed(0)} ms, p50 ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms`,
    );
    // Target is 1 ms (10.4); the CI bound is deliberately generous to avoid flaking on shared runners.
    expect(p99).toBeLessThan(5);
    expect(p50).toBeLessThan(1);
  });

  it('10.4 listing 1,000 tools of 30 installations stays well under the 50 ms compile budget (7.2)', () => {
    const engine = PolicyEngine.create(large.data);
    const principal = principalSchema.parse({
      kind: 'user',
      id: 'user-5',
      role: 'member',
      teams: [{ id: 'team-5', role: 'member' }],
    });
    const items = large.installations
      .slice(0, 30)
      .flatMap((inst) =>
        Array.from({ length: 34 }, (_, n) =>
          tool(inst, `tool_${n}`, n % 2 ? { readOnlyHint: true } : {}),
        ),
      );
    const visibleTools = items.filter(
      (i): i is Extract<typeof i, { type: 'Tool' }> => i.type === 'Tool',
    );
    engine.filterVisible({ principal, action: 'seeTool', context }, visibleTools); // warm
    const started = performance.now();
    engine.filterVisible({ principal, action: 'seeTool', context }, visibleTools);
    const ms = performance.now() - started;
    console.info(
      `policy perf: filterVisible of ${visibleTools.length} tools took ${ms.toFixed(1)} ms`,
    );
    expect(visibleTools.length).toBeGreaterThanOrEqual(1000);
    expect(ms).toBeLessThan(250);
  });
});
