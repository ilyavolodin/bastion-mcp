import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderRoute } from './utils';

/** The explorer's strip, legend and column templates, pinned as markup (18.3). Digits are masked: the data is relative to now. */
const mask = (text: string) =>
  text
    .replace(/\d+/g, '9')
    .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/, 'Mon');

const explorer = async (query: string, role?: 'member') => {
  await renderRoute(`/activity${query}`, role ? { role } : undefined);
  const card = (await screen.findByRole('heading', { name: 'Calls over time' })).closest(
    'section',
  ) as HTMLElement;
  const list = (await screen.findByRole('region', { name: 'Calls' })) as HTMLElement;
  await within(list).findAllByRole('button', { name: /./ });
  return { card, list };
};

const LEGEND = [
  ['Succeeded', 'var(--mint)'],
  ['Upstream error', 'var(--sun)'],
  ['Denied by policy', 'var(--berry-ink)'],
  ['Blocked by guard', 'var(--coral-ink)'],
];

const PEOPLE_ROW =
  'grid min-h-14 w-full items-center gap-3 border-b border-line px-5 text-left grid-cols-[72px_minmax(0,1.6fr)_minmax(0,1fr)_110px_150px] max-lg:grid-cols-[64px_minmax(0,1fr)_auto]';
const PEOPLE_HEAD =
  'grid h-11 items-center gap-3 border-b border-line px-5 text-overline grid-cols-[72px_minmax(0,1.6fr)_minmax(0,1fr)_110px_150px] max-lg:hidden';
const SOLO_ROW =
  'grid min-h-14 w-full items-center gap-3 border-b border-line px-5 text-left grid-cols-[72px_minmax(0,2fr)_110px_150px] max-lg:grid-cols-[64px_minmax(0,1fr)_auto]';
const SOLO_HEAD =
  'grid h-11 items-center gap-3 border-b border-line px-5 text-overline grid-cols-[72px_minmax(0,2fr)_110px_150px] max-lg:hidden';

describe('18.3 call explorer markup', () => {
  for (const [range, title, tick] of [
    ['24h', '9:9', '9:9'],
    ['7d', 'Mon 9', 'Mon 9'],
  ] as const) {
    it(`${range}: strip titles, tick labels, segment colors and legend`, async () => {
      const { card } = await explorer(`?range=${range}`);
      const strip = card.querySelector('div[aria-hidden="true"]') as HTMLElement;
      const bars = [...strip.querySelectorAll('[title]')] as HTMLElement[];
      expect(bars.length).toBeGreaterThan(0);
      expect(mask(bars[0]?.getAttribute('title') ?? '').replace(/: 9 calls$/, '')).toBe(title);
      expect(mask(bars[0]?.getAttribute('title') ?? '')).toMatch(/: 9 calls$/);
      const colors = new Set(
        [...strip.querySelectorAll('[title] > span')].map(
          (s) => (s as HTMLElement).style.background,
        ),
      );
      expect([...colors].every((c) => /^var\(--(mint|sun|berry-ink|coral-ink)\)$/.test(c))).toBe(
        true,
      );
      const ticks = [...(strip.lastElementChild as HTMLElement).querySelectorAll('span')];
      expect(ticks.map((t) => mask(t.textContent ?? ''))).toEqual(Array(5).fill(tick));
      const legend = LEGEND.map(([label]) => [
        label,
        (within(card).getByText(label as string).firstElementChild as HTMLElement).style.background,
      ]);
      expect(legend).toEqual(LEGEND);
    });
  }

  for (const [name, role, head, rowClass, labels] of [
    [
      'admin',
      undefined,
      PEOPLE_HEAD,
      PEOPLE_ROW,
      ['Time', 'Call', 'Person', 'Duration', 'Outcome'],
    ],
    ['member', 'member', SOLO_HEAD, SOLO_ROW, ['Time', 'Call', 'Duration', 'Outcome']],
  ] as const) {
    it(`${name}: header row and list row column templates`, async () => {
      const { list } = await explorer('', role);
      const header = list.querySelector('div[aria-hidden="true"]') as HTMLElement;
      const row = list.querySelector('li > button') as HTMLElement;
      expect(header.className).toBe(head);
      expect(row.className.replace(/ ?(bg-coral-soft\/50|bg-tangerine-soft)/g, '')).toBe(rowClass);
      expect([...header.querySelectorAll('span')].map((s) => s.textContent)).toEqual(labels);
    });
  }
});
