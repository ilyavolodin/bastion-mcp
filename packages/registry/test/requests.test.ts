import { describe, expect, it } from 'vitest';
import {
  approveRequest,
  approverIds,
  buildInstallPlan,
  cancelRequest,
  canDecide,
  createInstallRequest,
  describeInstall,
  type InstallActor,
  type InstallRequest,
  InstallRequestForbiddenError,
  InstallRequestStateError,
  rejectRequest,
  serverJsonSchema,
} from '../src';
import * as fx from './fixtures/server-json';

const NOW = new Date('2026-03-01T12:00:00Z');
const admin: InstallActor = { id: 'admin', orgRole: 'admin', managedTeamIds: [] };
const teamManager: InstallActor = { id: 'mgr', orgRole: 'member', managedTeamIds: ['t1'] };
const otherManager: InstallActor = { id: 'mgr2', orgRole: 'member', managedTeamIds: ['t9'] };
const requesterTeams = ['t1', 't2'];

const open = (): InstallRequest =>
  createInstallRequest({
    id: 'r1',
    requesterId: 'user',
    sourceId: 'src',
    serverName: 'io.github.acme/github-tools',
    version: '2.4.1',
    justification: '  Need PR search  ',
    now: NOW,
  }).request;

const approval = (actor: InstallActor) => ({
  actor,
  requesterTeamIds: requesterTeams,
  now: NOW,
  serverJson: serverJsonSchema.parse(fx.npmStdioSecrets),
  risk: 'medium' as const,
  runtime: 'npm' as const,
  trust: 'community' as const,
});

describe('11.7 install requests', () => {
  it('11.7 creating opens a request with a trimmed justification and an audit event', () => {
    const { request, audit } = createInstallRequest({
      id: 'r1',
      requesterId: 'user',
      sourceId: 'src',
      serverName: 's/n',
      version: '1.0.0',
      justification: ' why ',
      now: NOW,
    });
    expect(request).toMatchObject({
      status: 'open',
      justification: 'why',
      decidedBy: null,
      reason: null,
      createdAt: NOW,
    });
    expect(audit).toMatchObject({
      action: 'registry.install_request.create',
      actorId: 'user',
      targetType: 'install_request',
      targetId: 'r1',
    });
  });

  it('11.7 the justification is required and bounded', () => {
    const base = {
      id: 'r',
      requesterId: 'u',
      sourceId: 's',
      serverName: 'a/b',
      version: '1.0.0',
      now: NOW,
    };
    expect(() => createInstallRequest({ ...base, justification: '   ' })).toThrow(
      InstallRequestStateError,
    );
    expect(() => createInstallRequest({ ...base, justification: 'x'.repeat(2001) })).toThrow(
      /longer/,
    );
  });

  it('11.7 admins and managers of the requester teams may decide; others and the requester may not', () => {
    const req = open();
    expect(canDecide(req, admin, requesterTeams)).toBe(true);
    expect(canDecide(req, teamManager, requesterTeams)).toBe(true);
    expect(canDecide(req, otherManager, requesterTeams)).toBe(false);
    expect(
      canDecide(req, { id: 'user', orgRole: 'member', managedTeamIds: ['t1'] }, requesterTeams),
    ).toBe(false);
    expect(canDecide(req, { id: 'x', orgRole: 'member', managedTeamIds: [] }, requesterTeams)).toBe(
      false,
    );
    expect(approverIds([admin, teamManager, otherManager], req, requesterTeams)).toEqual([
      'admin',
      'mgr',
    ]);
  });

  it('11.7 approval returns the direct-flow plan for the requester, with audit events', () => {
    const out = approveRequest(open(), approval(teamManager));
    expect(out.request).toMatchObject({ status: 'approved', decidedBy: 'mgr', decidedAt: NOW });
    expect(out.audit).toMatchObject({ action: 'registry.install_request.approve', actorId: 'mgr' });
    expect(out.plan).toEqual({
      catalogEntry: {
        source: {
          registrySourceId: 'src',
          serverName: 'io.github.acme/github-tools',
          version: '2.4.1',
        },
        slug: 'github-tools',
        displayName: 'Acme GitHub Tools',
        description: 'Issues, pull requests and code search for GitHub.',
        risk: 'medium',
        visibility: { org: false, teamIds: [], userIds: ['user'] },
        pinnedVersion: '2.4.1',
        runtime: 'npm',
        reuseExisting: true,
      },
      automaticTest: true,
      installation: { userId: 'user', origin: 'registry' },
    });
    expect(out.installAudit).toMatchObject({
      action: 'registry.install',
      actorId: 'user',
      metadata: { requestId: 'r1', trust: 'community', version: '2.4.1' },
    });
  });

  it('11.7 approval by someone outside the requester teams is forbidden', () => {
    expect(() => approveRequest(open(), approval(otherManager))).toThrow(
      InstallRequestForbiddenError,
    );
  });

  it('11.7 rejection needs a reason and records it', () => {
    const out = rejectRequest(open(), {
      actor: admin,
      requesterTeamIds: requesterTeams,
      now: NOW,
      reason: ' not vetted ',
    });
    expect(out.request).toMatchObject({
      status: 'rejected',
      reason: 'not vetted',
      decidedBy: 'admin',
    });
    expect(out.audit).toMatchObject({
      action: 'registry.install_request.reject',
      metadata: { reason: 'not vetted' },
    });
    expect(() =>
      rejectRequest(open(), {
        actor: admin,
        requesterTeamIds: requesterTeams,
        now: NOW,
        reason: ' ',
      }),
    ).toThrow(/reason/);
    expect(() =>
      rejectRequest(open(), {
        actor: otherManager,
        requesterTeamIds: requesterTeams,
        now: NOW,
        reason: 'x',
      }),
    ).toThrow(InstallRequestForbiddenError);
  });

  it('11.7 only the requester cancels', () => {
    const out = cancelRequest(open(), { actorId: 'user', now: NOW });
    expect(out.request.status).toBe('cancelled');
    expect(out.audit.action).toBe('registry.install_request.cancel');
    expect(() => cancelRequest(open(), { actorId: 'admin', now: NOW })).toThrow(
      InstallRequestForbiddenError,
    );
  });

  it('11.7 decided requests are final: no second decision of any kind', () => {
    const approved = approveRequest(open(), approval(admin)).request;
    const rejected = rejectRequest(open(), {
      actor: admin,
      requesterTeamIds: requesterTeams,
      now: NOW,
      reason: 'no',
    }).request;
    const cancelled = cancelRequest(open(), { actorId: 'user', now: NOW }).request;
    for (const done of [approved, rejected, cancelled]) {
      expect(() => approveRequest(done, approval(admin))).toThrow(InstallRequestStateError);
      expect(() =>
        rejectRequest(done, {
          actor: admin,
          requesterTeamIds: requesterTeams,
          now: NOW,
          reason: 'x',
        }),
      ).toThrow(InstallRequestStateError);
      expect(() => cancelRequest(done, { actorId: 'user', now: NOW })).toThrow(
        InstallRequestStateError,
      );
    }
  });
});

describe('11.7 install plan and audit', () => {
  it('11.7 direct plan restricts visibility to the user and pins the version', () => {
    const plan = buildInstallPlan({
      requesterId: 'u1',
      sourceId: 's',
      serverJson: serverJsonSchema.parse(fx.remoteWithHeaders),
      version: '1.2.0',
      risk: 'low',
      runtime: 'remote',
    });
    expect(plan.catalogEntry.visibility).toEqual({ org: false, teamIds: [], userIds: ['u1'] });
    expect(plan.catalogEntry.pinnedVersion).toBe('1.2.0');
    expect(plan.catalogEntry.displayName).toBe('Jira');
    expect(plan.catalogEntry.slug).toBe('jira');
    expect(plan.automaticTest).toBe(true);
  });

  it('11.7 slug and name fall back for odd names', () => {
    const plan = buildInstallPlan({
      requesterId: 'u1',
      sourceId: 's',
      serverJson: serverJsonSchema.parse({ name: 'com.x/___', version: '1.0.0', description: '' }),
      version: '1.0.0',
      risk: 'low',
      runtime: 'remote',
    });
    expect(plan.catalogEntry.slug).toBe('com-x');
  });

  it('11.7 every install writes an audit event description', () => {
    const e = describeInstall({
      actorId: 'u',
      sourceId: 's',
      serverName: 'a/b',
      version: '1.0.0',
      runtime: 'remote',
      trust: 'official',
      at: NOW,
    });
    expect(e).toMatchObject({
      action: 'registry.install',
      targetType: 'registry_server',
      targetId: 's:a/b@1.0.0',
      at: NOW,
    });
    expect(e.metadata).not.toHaveProperty('requestId');
  });
});
