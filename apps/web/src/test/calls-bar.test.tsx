import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderRoute } from './utils';

/** The two-segment calls bar, its count cell and its legend, as TrafficPanel and PeoplePanel render them (15.5). */
const normalise = (html: string) => html.replace(/width: [\d.]+%/g, 'width: N%');

const panelParts = async (title: string) => {
  const heading = await screen.findByRole('heading', { name: title });
  const card = heading.closest('section') as HTMLElement;
  await within(card).findAllByRole('link');
  const item = card.querySelector('li') as HTMLElement;
  const bar = item.querySelector('[aria-hidden="true"]') as HTMLElement;
  const count = item.querySelector('span.text-right') as HTMLElement;
  const legend = ['Succeeded', 'Errors'].map(
    (label) => (within(card).getByText(label) as HTMLElement).outerHTML,
  );
  const widths = [...bar.querySelectorAll('span')].map((s) => Number.parseFloat(s.style.width));
  return { bar, count, legend, widths };
};

describe('15.5 calls bar markup is the same in both observability panels', () => {
  for (const title of ['Where calls go', 'Busiest people']) {
    it(`${title}: bar, count cell and legend`, async () => {
      await renderRoute('/observability');
      const { bar, count, legend, widths } = await panelParts(title);
      expect(normalise(bar.outerHTML)).toMatchInlineSnapshot(
        `"<span class="flex h-4 overflow-hidden rounded-sm bg-sunken" aria-hidden="true"><span class="block h-full" style="width: N%; background: var(--sky);"></span><span class="block h-full" style="width: N%; background: var(--coral);"></span></span>"`,
      );
      expect(normalise(count.outerHTML.replace(/>[^<]*</, '>N<'))).toMatchInlineSnapshot(
        `"<span class="text-right text-caption tabular-nums text-muted">N</span>"`,
      );
      expect(legend).toMatchInlineSnapshot(`
        [
          "<span class="inline-flex items-center gap-1.5 text-caption text-muted"><span aria-hidden="true" style="background: var(--sky);" class="h-2.5 w-2 rounded-[2px]"></span>Succeeded</span>",
          "<span class="inline-flex items-center gap-1.5 text-caption text-muted"><span aria-hidden="true" style="background: var(--coral);" class="h-2.5 w-2 rounded-[2px]"></span>Errors</span>",
        ]
      `);
      expect(widths).toHaveLength(2);
      expect(widths[0]).toBeGreaterThanOrEqual(0);
      // The first row is the busiest: its two segments fill the whole bar.
      expect((widths[0] ?? 0) + (widths[1] ?? 0)).toBeCloseTo(100, 6);
    });
  }
});
