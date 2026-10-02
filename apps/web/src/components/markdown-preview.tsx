import type * as React from 'react';

/** A deliberately tiny, safe Markdown subset (headings, lists, code, paragraphs) for SKILL.md previews. */
export function MarkdownPreview({ source }: { source: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = source.split('\n');
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag
        key={blocks.length}
        className={`m-0 pl-5 ${list.ordered ? 'list-decimal' : 'list-disc'}`}
      >
        {list.items.map((t, i) => (
          <li key={`${i}-${t}`}>{t}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (code) {
        blocks.push(
          <pre
            key={blocks.length}
            className="m-0 overflow-x-auto rounded-md bg-sunken p-2.5 font-mono text-[12px]"
          >
            {code.join('\n')}
          </pre>,
        );
        code = null;
      } else {
        flushList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const level = (h[1] ?? '#').length;
      blocks.push(
        <p
          key={blocks.length}
          role="heading"
          aria-level={level}
          className={`m-0 font-semibold ${level === 1 ? 'text-[18px]' : 'text-[15px]'}`}
        >
          {h[2]}
        </p>,
      );
    } else if (ul || ol) {
      const ordered = Boolean(ol);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ul ?? ol)?.[1] ?? '');
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      blocks.push(
        <p key={blocks.length} className="m-0">
          {line}
        </p>,
      );
    }
  }
  flushList();
  return <div className="flex flex-col gap-2 text-[14px] leading-[22px]">{blocks}</div>;
}
