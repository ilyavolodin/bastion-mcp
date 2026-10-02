import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './ui/button';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function useCopy(resetMs = 1800) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text: string) => {
    if (await copyText(text)) {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), resetMs);
    }
  };
  return { copied, copy };
}

/** A read-only value with a copy button; announces "Copied" to screen readers. */
export function CopyField({
  value,
  label,
  className,
  tone = 'white',
  mono,
  buttonLabel = 'Copy',
}: {
  value: string;
  label: string;
  className?: string;
  tone?: 'white' | 'sunken' | 'dark';
  mono?: boolean;
  buttonLabel?: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md py-1.5 pl-4 pr-1.5',
        tone === 'white' && 'bg-white text-[#171a3a]',
        tone === 'sunken' && 'bg-sunken text-ink',
        tone === 'dark' && 'bg-[#171a3a] pl-3 text-[#f4f4f6]',
        className,
      )}
    >
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[15px] leading-[22px] font-medium tabular-nums',
          mono && 'font-mono text-[12px] leading-[18px]',
        )}
      >
        <span className="sr-only">{label}: </span>
        <span>{value}</span>
      </span>
      <Button
        variant={tone === 'dark' ? 'ghost' : 'outline'}
        size="sm"
        onClick={() => copy(value)}
        aria-label={`${buttonLabel} ${label}`}
        className={cn(
          tone === 'white' && 'bg-white text-[#171a3a] hover:bg-white',
          tone === 'dark' && 'bg-[#2e2e36] text-[#f4f4f6] hover:bg-[#2e2e36] hover:text-[#f4f4f6]',
        )}
      >
        {copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
        {copied ? 'Copied' : buttonLabel}
      </Button>
      <span role="status" className="sr-only">
        {copied ? `${label} copied` : ''}
      </span>
    </div>
  );
}
