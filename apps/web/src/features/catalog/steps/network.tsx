import * as React from 'react';
import { Field } from '@/components/form';
import { Card, CardHeader, Chip } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { isEgressRule, isPublicIpv4Cidr, type SpecDraft } from '../draft';
import { type StepProps, setSpec } from './props';

export function NetworkStep({ draft, onChange, readOnly }: StepProps) {
  const [host, setHost] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  const hosts = draft.spec.egress;
  const remote = draft.spec.type === 'remote';
  // A CIDR rule allows what the SSRF check refuses: private ranges. A public one is almost always a typo.
  const publicCidrs = hosts.filter((h) => h.includes('/') && isPublicIpv4Cidr(h));
  const add = () => {
    const h = host.trim().toLowerCase();
    if (!h) return;
    if (!isEgressRule(h)) return setError('Use host[:port], *.suffix[:port] or a CIDR');
    setError(undefined);
    if (!hosts.includes(h)) onChange(setSpec(draft, { egress: [...hosts, h] }));
    setHost('');
  };
  return (
    <Card aria-label="Network" className="gap-4">
      <CardHeader
        title="Network"
        subtitle="The only places this server may connect (egress allowlist)"
      />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Allowed hosts">
        {hosts.length === 0 ? (
          <span className="text-caption text-muted">No outbound access.</span>
        ) : null}
        {hosts.map((h) => (
          <Chip
            key={h}
            onRemove={
              readOnly
                ? undefined
                : () => onChange(setSpec(draft, { egress: hosts.filter((x) => x !== h) }))
            }
            removeLabel={`Remove ${h}`}
          >
            {h}
          </Chip>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <Field label="Add a host" className="flex-1" error={error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              disabled={readOnly || remote}
              value={host}
              placeholder="api.example.com"
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
          )}
        </Field>
        <Button variant="outline" disabled={readOnly || !host.trim() || remote} onClick={add}>
          Add
        </Button>
      </div>
      {publicCidrs.map((c) => (
        <p key={c} role="note" className="m-0 text-caption font-medium text-coral-ink">
          {c} is not on a private network, so it allows nothing the server could not already reach.
          Check the address: a machine on your network is usually 192.168.x.x, 10.x.x.x or
          172.16-31.x.x.
        </p>
      ))}
      {remote ? (
        <p className="m-0 text-caption text-muted">
          A remote server is reached by its URL; the allowlist applies to packages that Bastion
          runs.
        </p>
      ) : (
        <p className="m-0 text-caption text-muted">
          A host that resolves to an address on your own network (for example 192.168.1.2) is
          refused unless that address is listed here as well, such as <code>192.168.1.2/32</code>.
        </p>
      )}
      {remote ? null : (
        <Field label="Sandbox size">
          {({ id }) => (
            <Select
              id={id}
              disabled={readOnly}
              value={draft.spec.size}
              onChange={(e) =>
                onChange(setSpec(draft, { size: e.target.value as SpecDraft['size'] }))
              }
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </Select>
          )}
        </Field>
      )}
    </Card>
  );
}
