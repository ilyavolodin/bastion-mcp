import { z } from 'zod';
import { PageHeader } from '@/components/page-header';
import { cn } from '@/lib/cn';
import { useSearchState } from '@/lib/search';
import {
  IdpSection,
  KmsSection,
  LimitsSection,
  ModelGuardsSection,
  OrganizationSection,
  RetentionSection,
  SandboxesSection,
} from './sections';
import { SystemStatusSection } from './system-status';

export const SECTIONS = [
  ['org', 'Organization'],
  ['idp', 'Identity provider'],
  ['kms', 'Encryption keys'],
  ['sandboxes', 'Sandboxes'],
  ['guards', 'Model guards'],
  ['limits', 'Limits'],
  ['retention', 'Retention'],
  ['system', 'System status'],
] as const;
type Section = (typeof SECTIONS)[number][0];

const searchSchema = z.object({
  section: z
    .enum(SECTIONS.map((s) => s[0]) as [Section, ...Section[]])
    .catch('org')
    .default('org'),
});

const BODY: Record<Section, () => React.JSX.Element> = {
  org: OrganizationSection,
  idp: IdpSection,
  kms: KmsSection,
  sandboxes: SandboxesSection,
  guards: ModelGuardsSection,
  limits: LimitsSection,
  retention: RetentionSection,
  system: SystemStatusSection,
};

export function SettingsPage() {
  const [s, setS] = useSearchState(searchSchema);
  const Body = BODY[s.section];
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Organization-wide configuration. Only Admins see this page."
      />
      <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav
          aria-label="Settings sections"
          className="flex flex-col gap-0.5 rounded-lg bg-surface p-2.5 shadow-card"
        >
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={id === s.section ? 'page' : undefined}
              onClick={() => setS({ section: id })}
              className={cn(
                'flex h-11 items-center rounded-md px-3 text-left text-label',
                id === s.section
                  ? 'bg-grad-tangerine font-semibold text-on-bright'
                  : 'hover:bg-sunken',
              )}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          <Body />
        </div>
      </div>
    </>
  );
}
