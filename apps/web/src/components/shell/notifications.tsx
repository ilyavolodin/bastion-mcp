import { useNavigate } from '@tanstack/react-router';
import { Bell } from 'lucide-react';
import { useMarkNotificationRead, useNotifications } from '@/api/hooks';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';

/** Bell with an unread dot; the list updates live from the SSE stream (18.1). */
export function NotificationsBell() {
  const q = useNotifications();
  const mark = useMarkNotificationRead();
  const navigate = useNavigate();
  const items = q.data ?? [];
  const unread = items.filter((n) => !n.readAt).length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          className="relative inline-flex size-11 items-center justify-center rounded-md bg-surface text-ink shadow-card"
        >
          <Bell className="size-5" aria-hidden="true" />
          {unread > 0 ? (
            <span
              data-testid="unread-dot"
              className="absolute right-[11px] top-2.5 size-2 rounded-full bg-coral ring-2 ring-surface"
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label="Notifications">
        <h2 className="m-0 mb-2 text-card-title">Notifications</h2>
        {items.length === 0 ? (
          <p className="m-0 py-4 text-center text-muted">You are all caught up.</p>
        ) : (
          <ul className="m-0 flex max-h-[360px] list-none flex-col gap-1 overflow-y-auto p-0">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!n.readAt) mark.mutate(n.id);
                    if (n.href) void navigate({ to: n.href } as never);
                  }}
                  className="flex w-full items-start gap-2.5 rounded-md p-2.5 text-left hover:bg-sunken"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      n.readAt ? 'bg-line' : 'bg-coral',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-label">
                      {n.title}
                      {!n.readAt ? <span className="sr-only"> (unread)</span> : null}
                    </span>
                    <span className="block text-[13px] leading-5 text-muted">{n.body}</span>
                    <span className="block text-[11px] text-muted">
                      {formatRelative(n.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
