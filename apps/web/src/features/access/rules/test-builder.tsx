import * as React from 'react';
import { useInstallations, useTeams } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { buildPolicyTest, type PolicyTest, TEST_ACTIONS } from '../forms';

/** Adds a test case to a custom policy: who does what, and whether the answer is allow or deny. */
export function TestBuilder({ onAdd }: { onAdd: (t: PolicyTest) => void }) {
  const teams = useTeams();
  const installs = useInstallations();
  const [name, setName] = React.useState('');
  const [expectation, setExpectation] = React.useState<'allow' | 'deny'>('deny');
  const [action, setAction] = React.useState<(typeof TEST_ACTIONS)[number]>('callTool');
  const [role, setRole] = React.useState<'admin' | 'auditor' | 'member'>('member');
  const [teamId, setTeamId] = React.useState('');
  const [installationId, setInstallationId] = React.useState('');
  const [toolName, setToolName] = React.useState('');
  const first = installs.data?.[0];
  const installation = installs.data?.find((i) => i.id === installationId) ?? first;
  return (
    <fieldset className="m-0 flex flex-col gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-overline">Add a test</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label="Test name"
          placeholder="Name, e.g. Support cannot post"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          aria-label="Expected answer"
          value={expectation}
          onChange={(e) => setExpectation(e.target.value as typeof expectation)}
        >
          <option value="allow">Expect allow</option>
          <option value="deny">Expect deny</option>
        </Select>
        <Select
          aria-label="Test role"
          value={role}
          onChange={(e) => setRole(e.target.value as typeof role)}
        >
          <option value="member">A member</option>
          <option value="auditor">An auditor</option>
          <option value="admin">An admin</option>
        </Select>
        <Select aria-label="Test team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">On no team</option>
          {(teams.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              On {t.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Test action"
          value={action}
          onChange={(e) => setAction(e.target.value as typeof action)}
        >
          {TEST_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Test server"
          value={installation?.id ?? ''}
          onChange={(e) => setInstallationId(e.target.value)}
        >
          {(installs.data ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.displayName}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Test tool"
          className="font-mono sm:col-span-2"
          placeholder="Tool name, prompt name or resource URI"
          value={toolName}
          onChange={(e) => setToolName(e.target.value)}
        />
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        disabled={!name.trim() || !toolName.trim() || !installation}
        onClick={() => {
          if (!installation) return;
          onAdd(
            buildPolicyTest({
              name: name.trim(),
              expect: expectation,
              action,
              role,
              teamId,
              teamRole: 'member',
              installationId: installation.id,
              catalogEntryId: installation.catalogEntryId ?? installation.id,
              toolName: toolName.trim(),
            }),
          );
          setName('');
          setToolName('');
        }}
      >
        Add test
      </Button>
    </fieldset>
  );
}
