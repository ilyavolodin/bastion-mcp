import { Check, Play, X } from 'lucide-react';
import * as React from 'react';
import { useInstallations, useSimulate, useUsers } from '@/api/hooks';
import type { Body, Res } from '@/api/schema';
import { Field } from '@/components/form';
import { Avatar, Card, CardHeader, Tag } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { cn } from '@/lib/cn';

type SimBody = Body<'post', '/policies/simulate'>;
type SimResult = Res<'post', '/policies/simulate'>;

/** The simulator's answer: which policies decided, and whether the call is allowed. */
function SimulationResult({ result }: { result: SimResult }) {
  const denied = result.decision === 'deny';
  const deciding = result.determiningPolicies;
  return (
    <div aria-live="polite" className="flex flex-col gap-3">
      <div
        className={cn(
          'flex items-center gap-3.5 rounded-lg p-4',
          denied ? 'bg-coral-soft' : 'bg-mint-soft',
        )}
      >
        <span
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-full text-on-bright',
            denied ? 'bg-coral' : 'bg-mint',
          )}
        >
          {denied ? (
            <X className="size-5" strokeWidth={2.25} aria-hidden="true" />
          ) : (
            <Check className="size-5" strokeWidth={2.25} aria-hidden="true" />
          )}
        </span>
        <div>
          <div className={cn('text-card-title', denied ? 'text-coral-ink' : 'text-mint-ink')}>
            {denied ? 'Denied' : 'Allowed'}
          </div>
          <div className="text-caption">
            {result.errors.length > 0
              ? result.errors.join(' ')
              : `Decided by ${result.reasons.join(', ') || 'the defaults'}`}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-overline">Policies that decided</span>
        {deciding.map((p) => {
          const forbid = /^\s*forbid\b/m.test(p.text);
          return (
            <div
              key={p.id}
              data-deciding
              className={cn(
                'flex items-center gap-2 rounded-md border-[1.5px] px-2.5 py-2',
                forbid ? 'border-coral-ink' : 'border-mint-ink',
              )}
            >
              <Tag tone={forbid ? 'bad' : 'ok'}>{forbid ? 'forbid' : 'permit'}</Tag>
              <span className="font-mono text-[12px]">{p.id}</span>
              <span className="ml-auto text-[11px] font-semibold">Decided</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Simulator() {
  const users = useUsers({});
  const installs = useInstallations();
  const sim = useSimulate();
  const [userId, setUserId] = React.useState('');
  const [installationId, setInstallationId] = React.useState('');
  const [action, setAction] = React.useState<'callTool' | 'getPrompt' | 'readResource'>('callTool');
  const [tool, setTool] = React.useState('slack_post_message');
  const person = users.data?.find((u) => u.id === userId);
  const installation = installs.data?.find((i) => i.id === installationId);
  React.useEffect(() => {
    if (!userId && users.data?.[3]) setUserId(users.data[3].id);
  }, [users.data, userId]);
  React.useEffect(() => {
    if (!installationId && installs.data?.length) {
      setInstallationId(
        (installs.data.find((i) => i.slug === 'slack') ?? installs.data[0])?.id ?? '',
      );
    }
  }, [installs.data, installationId]);
  const run = () => {
    if (!person || !installation) return;
    const target = {
      installation: {
        id: installation.id,
        catalogEntryId: installation.catalogEntryId ?? installation.id,
      },
    };
    const body: SimBody = {
      principal: {
        kind: 'user',
        id: person.id,
        role: person.orgRole,
        teams: person.teams.map((t) => ({ id: t.id, role: t.role })),
      },
      action,
      resource:
        action === 'getPrompt'
          ? { type: 'Prompt', ...target, name: tool }
          : action === 'readResource'
            ? { type: 'Resource', ...target, uri: tool }
            : { type: 'Tool', ...target, name: tool },
    };
    sim.mutate(body);
  };
  return (
    <Card aria-label="Policy simulator" className="gap-3.5">
      <CardHeader title="Try a decision" />
      <Field label="Person">
        {({ id }) => (
          <div className="flex items-center gap-2">
            {person ? <Avatar name={person.name} size={24} /> : null}
            <Select id={id} value={userId} onChange={(e) => setUserId(e.target.value)}>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.teams[0] ? ` · ${u.teams[0].name}` : ''}
                </option>
              ))}
            </Select>
          </div>
        )}
      </Field>
      <Field label="Server">
        {({ id }) => (
          <Select
            id={id}
            value={installationId}
            onChange={(e) => setInstallationId(e.target.value)}
          >
            {(installs.data ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.displayName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Action">
        {({ id }) => (
          <Select
            id={id}
            value={action}
            onChange={(e) => setAction(e.target.value as typeof action)}
          >
            <option value="callTool">Call a tool</option>
            <option value="getPrompt">Get a prompt</option>
            <option value="readResource">Read a resource</option>
          </Select>
        )}
      </Field>
      <Field
        label={action === 'callTool' ? 'Tool' : action === 'getPrompt' ? 'Prompt' : 'Resource URI'}
      >
        {({ id }) => (
          <Input
            id={id}
            className="font-mono"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
          />
        )}
      </Field>
      <Button
        size="sm"
        className="self-start"
        disabled={!person || !installation || !tool.trim() || sim.isPending}
        onClick={run}
      >
        <Play className="size-4" aria-hidden="true" />
        Simulate
      </Button>
      {sim.data ? <SimulationResult result={sim.data} /> : null}
    </Card>
  );
}
