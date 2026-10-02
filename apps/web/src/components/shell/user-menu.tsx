import * as Primitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronsUpDown, LogOut, Moon } from 'lucide-react';
import { CSRF_COOKIE, CSRF_HEADER, readCookie } from '@/api/client';
import { useAuth } from '@/auth/auth';
import { Avatar } from '@/components/primitives';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/cn';
import { roleLabel } from '@/lib/roles';

export async function signOut(): Promise<void> {
  const csrf = readCookie(CSRF_COOKIE);
  try {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: csrf ? { [CSRF_HEADER]: csrf } : {},
    });
  } finally {
    window.location.assign('/auth/login');
  }
}

/** Sidebar footer chip that opens the user menu: theme toggle and sign out (18.1). */
export function UserMenu({ collapsed }: { collapsed?: boolean }) {
  const { me, role, theme, setTheme } = useAuth();
  const label = roleLabel(role, me);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${me.name}`}
          className="flex w-full items-center gap-3 rounded-lg bg-sunken p-3 text-left"
        >
          <Avatar
            name={me.name}
            size={36}
            color="var(--gradient-sunset)"
            className="!bg-grad-sunset text-[13px]"
          />
          <span className={cn('flex min-w-0 flex-1 flex-col', collapsed && 'max-[1279px]:hidden')}>
            <span className="truncate text-label">{me.name}</span>
            <span className="truncate text-caption text-muted">{label}</span>
          </span>
          <ChevronsUpDown
            className={cn('size-4 text-muted', collapsed && 'max-[1279px]:hidden')}
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuLabel>
          <span className="block text-label text-ink">{me.name}</span>
          {me.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <Primitive.CheckboxItem
          checked={theme === 'dark'}
          onCheckedChange={(v) => setTheme(v ? 'dark' : 'light')}
          className="flex h-10 cursor-pointer select-none items-center gap-2.5 rounded-md px-3 text-label outline-none data-[highlighted]:bg-sunken"
        >
          <Moon className="size-4" aria-hidden="true" />
          Dark theme
          <Primitive.ItemIndicator className="ml-auto">
            <Check className="size-4 text-tangerine-ink" aria-hidden="true" />
          </Primitive.ItemIndicator>
        </Primitive.CheckboxItem>
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
