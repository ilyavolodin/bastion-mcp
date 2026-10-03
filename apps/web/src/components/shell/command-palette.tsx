import { useQueries } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { LayoutGrid, Server, Settings2, User, Users, Wrench } from 'lucide-react';
import { api } from '@/api/client';
import { useInstallations, useTeams, useUsers } from '@/api/hooks';
import { STALE_LONG_MS } from '@/api/timing';
import { toCapabilities } from '@/api/views/servers';
import { useAuth } from '@/auth/auth';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SECTIONS, visibleSections } from '@/lib/roles';
import { usePalette } from './palette-context';

export const SETTINGS_PAGES = [
  ['org', 'Organization'],
  ['idp', 'Identity provider'],
  ['kms', 'Encryption keys'],
  ['sandboxes', 'Sandboxes'],
  ['guards', 'Model guards'],
  ['limits', 'Limits'],
  ['retention', 'Retention'],
  ['system', 'System status'],
] as const;

type Go = (to: string, search?: Record<string, unknown>) => void;

function PeopleGroups({ go }: { go: Go }) {
  const users = useUsers({});
  const teams = useTeams();
  return (
    <>
      {(users.data ?? []).length > 0 ? (
        <CommandGroup heading="People">
          {(users.data ?? []).map((u) => (
            <CommandItem
              key={u.id}
              value={`person ${u.name} ${u.email}`}
              onSelect={() => go('/access', { tab: 'people', q: u.name })}
            >
              <User className="size-4 text-muted" aria-hidden="true" />
              {u.name}
              <span className="ml-auto text-caption text-muted">{u.email}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {(teams.data ?? []).length > 0 ? (
        <CommandGroup heading="Teams">
          {(teams.data ?? []).map((t) => (
            <CommandItem
              key={t.id}
              value={`team ${t.name}`}
              onSelect={() => go('/access', { tab: 'teams' })}
            >
              <Users className="size-4 text-muted" aria-hidden="true" />
              {t.name}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
    </>
  );
}

/** Cmd/Ctrl+K: servers, tools, people, teams and settings pages, filtered by what the role may open. */
export function CommandPalette() {
  const { open, setOpen } = usePalette();
  const { role, me, can } = useAuth();
  const navigate = useNavigate();
  const installations = useInstallations();
  const servers = installations.data ?? [];
  const canPeople = role === 'admin' || role === 'manager';

  // Tool names come from each installation's final definitions; fetched only while the palette is open.
  const tools = useQueries({
    queries: servers.map((s) => ({
      queryKey: ['installations', s.id, 'palette-tools'],
      enabled: open,
      staleTime: STALE_LONG_MS,
      queryFn: () =>
        api.get(`/installations/${s.id}/tools`).then((res) => toCapabilities('tool', res)),
    })),
  });

  const go: Go = (to, search) => {
    setOpen(false);
    void navigate({ to, ...(search ? { search } : {}) } as never);
  };

  const toolItems = tools.flatMap((q, i) =>
    (q.data ?? []).map((t) => ({ tool: t, server: servers[i] })),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        title="Search"
        description="Servers, tools, people, teams and settings"
        hideTitle
        className="top-[20%] max-w-xl -translate-y-0 gap-0 overflow-hidden p-0"
      >
        <Command label="Search Bastion">
          <CommandInput placeholder="Search servers, tools, people and settings" autoFocus />
          <CommandList>
            <CommandEmpty>No results. Try a server or tool name.</CommandEmpty>
            <CommandGroup heading="Pages">
              {visibleSections(role, me.capabilities).map((s) => (
                <CommandItem
                  key={s}
                  value={`page ${SECTIONS[s].label}`}
                  onSelect={() => go(SECTIONS[s].path)}
                >
                  <LayoutGrid className="size-4 text-muted" aria-hidden="true" />
                  {SECTIONS[s].label}
                </CommandItem>
              ))}
            </CommandGroup>
            {servers.length > 0 ? (
              <CommandGroup heading="Servers">
                {servers.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={`server ${s.displayName} ${s.slug}`}
                    onSelect={() => go(`/servers/${s.id}`)}
                  >
                    <Server className="size-4 text-muted" aria-hidden="true" />
                    {s.displayName}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {toolItems.length > 0 ? (
              <CommandGroup heading="Tools">
                {toolItems.map(({ tool, server }) => (
                  <CommandItem
                    key={`${server?.id}-${tool.name}`}
                    value={`tool ${tool.name} ${tool.description} ${server?.displayName}`}
                    onSelect={() => go(`/servers/${server?.id}`, { tab: 'capabilities' })}
                  >
                    <Wrench className="size-4 text-muted" aria-hidden="true" />
                    <span className="font-mono text-[13px]">{tool.name}</span>
                    <span className="ml-auto text-caption text-muted">{server?.displayName}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {open && canPeople ? <PeopleGroups go={go} /> : null}
            {can('settings') ? (
              <CommandGroup heading="Settings">
                {SETTINGS_PAGES.map(([id, label]) => (
                  <CommandItem
                    key={id}
                    value={`settings ${label}`}
                    onSelect={() => go('/settings', { section: id })}
                  >
                    <Settings2 className="size-4 text-muted" aria-hidden="true" />
                    {label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
