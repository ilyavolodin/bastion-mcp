import { Outlet, useRouterState } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { useServerEvents } from '@/api/events';
import { useAuth } from '@/auth/auth';
import { ErrorBoundary } from '@/components/problem';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SECTIONS, sectionForPath } from '@/lib/roles';
import { CommandPalette } from './command-palette';
import { PaletteProvider } from './palette-context';
import { RoleBar } from './role-bar';
import { BastionMark, NavLinks, Sidebar } from './sidebar';
import { UserMenu } from './user-menu';

function MobileBar() {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 md:hidden">
      <BastionMark size={24} />
      <span className="flex-1 text-[16px] font-semibold">Bastion</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Open navigation"
        onClick={() => setOpen(true)}
      >
        <Menu className="size-5" aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Navigation" placement="drawer" hideTitle>
          <nav aria-label="Main" className="flex flex-col gap-1.5 pt-8">
            <NavLinks
              collapsible={false}
              only={(s) => Boolean(SECTIONS[s].compact)}
              onNavigate={() => setOpen(false)}
            />
            <p className="m-0 mt-3 px-3 text-caption text-muted">
              Other screens need a wider display.
            </p>
          </nav>
          <div className="mt-auto">
            <UserMenu />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AppShell() {
  const { previewEnabled } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const compact = Boolean(SECTIONS[sectionForPath(path)].compact);
  useServerEvents((n) => toast(n.title, { description: n.body }));
  return (
    <TooltipProvider>
      <PaletteProvider>
        <div className="flex min-h-screen flex-col bg-canvas text-ink">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-surface focus:px-4 focus:py-2"
          >
            Skip to content
          </a>
          {previewEnabled ? <RoleBar /> : null}
          <div className="flex flex-1 items-stretch">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <MobileBar />
              <main
                id="main"
                tabIndex={-1}
                className="flex min-w-0 flex-1 flex-col gap-6 px-8 pb-12 pt-6 max-md:px-4"
              >
                {!compact ? (
                  <p
                    role="note"
                    className="m-0 rounded-md bg-sky-soft px-3.5 py-2.5 text-[13px] text-sky-ink md:hidden"
                  >
                    This screen is best on a wider display. Home, Store and Activity work here.
                  </p>
                ) : null}
                <ErrorBoundary key={path}>
                  <Outlet />
                </ErrorBoundary>
              </main>
            </div>
          </div>
          <CommandPalette />
          <Toaster />
        </div>
      </PaletteProvider>
    </TooltipProvider>
  );
}
