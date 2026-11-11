import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderRoute } from './utils';

/**
 * Baseline for the "add" selects of the rule form (10.3): their markup, and what choosing an option does. The placeholder
 * stays selected after a choice, and choosing the placeholder changes nothing.
 */

const LABELS = [
  'Add a team',
  'Add a role',
  'Add a person',
  'Add a service account',
  'Add a server',
  'Add a tool kind',
];

const openDialog = async () => {
  const view = await renderRoute('/access');
  await view.user.click(await screen.findByRole('button', { name: 'Add rule' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'New tool rule' }));
  // The lookups arrive after the dialog.
  await dialog.findByRole('option', { name: 'Support' });
  return { ...view, dialog };
};

describe('10.3 the add selects of a rule', () => {
  it('the markup of the Who and What control rows', async () => {
    const { dialog } = await openDialog();
    const html = LABELS.map((l) => dialog.getByLabelText(l).outerHTML);
    expect(html).toMatchInlineSnapshot(`
      [
        "<select class="rounded-md border border-line-strong bg-surface px-3 text-ink placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-coral-ink appearance-none bg-no-repeat pr-9 h-9 w-auto text-[13px]" aria-label="Add a team"><option value="">+ Team</option><option value="t-platform">Platform team</option><option value="t-data">Data platform</option><option value="t-analytics">Analytics</option><option value="t-support">Support</option></select>",
        "<select class="rounded-md border border-line-strong bg-surface px-3 text-ink placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-coral-ink appearance-none bg-no-repeat pr-9 h-9 w-auto text-[13px]" aria-label="Add a role"><option value="">+ Role</option><option value="member">Member</option><option value="manager">Manager</option><option value="auditor">Auditor</option><option value="admin">Admin</option></select>",
        "<select class="rounded-md border border-line-strong bg-surface px-3 text-ink placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-coral-ink appearance-none bg-no-repeat pr-9 h-9 w-auto text-[13px]" aria-label="Add a person"><option value="">+ Person</option><option value="u-dana">Dana Whitfield</option><option value="u-raj">Raj Mehta</option><option value="u-jo">Jo Okafor</option><option value="u-ana">Ana Kim</option><option value="u-li">Li Chen</option><option value="u-sam">Sam Patel</option><option value="u-eve">Eve Torres</option><option value="u-max">Max Rivera</option><option value="u-ivy">Ivy Nguyen</option><option value="u-ben">Ben Stone</option><option value="u-kai">Kai Lee</option><option value="u-zoe">Zoe Fox</option><option value="u-tom">Tom Hart</option><option value="u-uma">Uma Gupta</option></select>",
        "<select class="rounded-md border border-line-strong bg-surface px-3 text-ink placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-coral-ink appearance-none bg-no-repeat pr-9 h-9 w-auto text-[13px]" aria-label="Add a service account"><option value="">+ Service account</option><option value="sa-1">ci-bot</option><option value="sa-2">support-triage</option></select>",
        "<select class="rounded-md border border-line-strong bg-surface px-3 text-ink placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-coral-ink appearance-none bg-no-repeat pr-9 h-9 w-auto text-[13px]" aria-label="Add a server"><option value="">+ Server</option><option value="i-github">GitHub</option><option value="i-jira">Jira</option><option value="i-linear">Linear</option><option value="i-postgres">Postgres analytics</option><option value="i-sentry">Sentry</option><option value="i-slack">Slack</option><option value="i-notion">Notion</option><option value="i-filesystem">Filesystem</option><option value="i-zendesk">Zendesk</option><option value="i-webfetch">Web fetch</option></select>",
        "<select class="rounded-md border border-line-strong bg-surface px-3 text-ink placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-coral-ink appearance-none bg-no-repeat pr-9 h-9 w-auto text-[13px]" aria-label="Add a tool kind"><option value="">+ Tool kind</option><option value="destructive">Destructive tools</option><option value="readOnly">Read-only tools</option><option value="openWorld">Open-world tools</option></select>",
      ]
    `);
  });

  it('each select shows its placeholder first, then the options in order', async () => {
    const { dialog } = await openDialog();
    const options = LABELS.map((l) => [
      l,
      within(dialog.getByLabelText(l))
        .getAllByRole('option')
        .map((o) => [(o as HTMLOptionElement).value, o.textContent]),
    ]);
    expect(options).toMatchInlineSnapshot(`
      [
        [
          "Add a team",
          [
            [
              "",
              "+ Team",
            ],
            [
              "t-platform",
              "Platform team",
            ],
            [
              "t-data",
              "Data platform",
            ],
            [
              "t-analytics",
              "Analytics",
            ],
            [
              "t-support",
              "Support",
            ],
          ],
        ],
        [
          "Add a role",
          [
            [
              "",
              "+ Role",
            ],
            [
              "member",
              "Member",
            ],
            [
              "manager",
              "Manager",
            ],
            [
              "auditor",
              "Auditor",
            ],
            [
              "admin",
              "Admin",
            ],
          ],
        ],
        [
          "Add a person",
          [
            [
              "",
              "+ Person",
            ],
            [
              "u-dana",
              "Dana Whitfield",
            ],
            [
              "u-raj",
              "Raj Mehta",
            ],
            [
              "u-jo",
              "Jo Okafor",
            ],
            [
              "u-ana",
              "Ana Kim",
            ],
            [
              "u-li",
              "Li Chen",
            ],
            [
              "u-sam",
              "Sam Patel",
            ],
            [
              "u-eve",
              "Eve Torres",
            ],
            [
              "u-max",
              "Max Rivera",
            ],
            [
              "u-ivy",
              "Ivy Nguyen",
            ],
            [
              "u-ben",
              "Ben Stone",
            ],
            [
              "u-kai",
              "Kai Lee",
            ],
            [
              "u-zoe",
              "Zoe Fox",
            ],
            [
              "u-tom",
              "Tom Hart",
            ],
            [
              "u-uma",
              "Uma Gupta",
            ],
          ],
        ],
        [
          "Add a service account",
          [
            [
              "",
              "+ Service account",
            ],
            [
              "sa-1",
              "ci-bot",
            ],
            [
              "sa-2",
              "support-triage",
            ],
          ],
        ],
        [
          "Add a server",
          [
            [
              "",
              "+ Server",
            ],
            [
              "i-github",
              "GitHub",
            ],
            [
              "i-jira",
              "Jira",
            ],
            [
              "i-linear",
              "Linear",
            ],
            [
              "i-postgres",
              "Postgres analytics",
            ],
            [
              "i-sentry",
              "Sentry",
            ],
            [
              "i-slack",
              "Slack",
            ],
            [
              "i-notion",
              "Notion",
            ],
            [
              "i-filesystem",
              "Filesystem",
            ],
            [
              "i-zendesk",
              "Zendesk",
            ],
            [
              "i-webfetch",
              "Web fetch",
            ],
          ],
        ],
        [
          "Add a tool kind",
          [
            [
              "",
              "+ Tool kind",
            ],
            [
              "destructive",
              "Destructive tools",
            ],
            [
              "readOnly",
              "Read-only tools",
            ],
            [
              "openWorld",
              "Open-world tools",
            ],
          ],
        ],
      ]
    `);
  });

  it('choosing an option adds a chip and the select returns to its placeholder', async () => {
    const { user, dialog } = await openDialog();
    const picks: [string, string][] = [
      ['Add a team', 't-support'],
      ['Add a role', 'manager'],
      ['Add a person', ''],
      ['Add a service account', ''],
      ['Add a server', 'i-slack'],
      ['Add a tool kind', 'destructive'],
    ];
    for (const [label, value] of picks) {
      const select = dialog.getByLabelText(label) as HTMLSelectElement;
      const chosen = value || (select.options[1]?.value ?? '');
      await user.selectOptions(select, chosen);
      expect(select).toHaveValue('');
    }
    const chips = Array.from(
      (dialog.getByText('Who').parentElement as HTMLElement).querySelectorAll(
        'button[aria-label^="Remove"]',
      ),
    ).map((b) => b.getAttribute('aria-label'));
    const whatChips = Array.from(
      (dialog.getByText('What').parentElement as HTMLElement).querySelectorAll(
        'button[aria-label^="Remove"]',
      ),
    ).map((b) => b.getAttribute('aria-label'));
    expect({ chips, whatChips }).toMatchInlineSnapshot(`
      {
        "chips": [
          "Remove Role · Manager",
          "Remove Team · Support",
          "Remove Person · Dana Whitfield",
          "Remove Service account · ci-bot",
        ],
        "whatChips": [
          "Remove Slack",
          "Remove destructive tools",
        ],
      }
    `);
  });

  it('choosing the placeholder adds nothing', async () => {
    const { user, dialog } = await openDialog();
    for (const l of LABELS) await user.selectOptions(dialog.getByLabelText(l), '');
    expect(dialog.getAllByText(/^(Everyone|Any tool)$/)).toHaveLength(2);
  });
});
