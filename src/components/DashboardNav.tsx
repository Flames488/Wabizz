import { Link, useRouterState } from "@tanstack/react-router";
import { Menu, Users, Megaphone, Zap, Layers, Sparkles, Settings2, LogOut } from "lucide-react";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from "@/components/ui/sheet";
import { InstallAppButton } from "@/components/InstallAppButton";

const NAV_LINKS = [
  { to: "/contacts", label: "Contacts", icon: Users },
  { to: "/campaigns", label: "Campaigns", icon: Megaphone },
  { to: "/automation", label: "Automation", icon: Zap },
  { to: "/dashboard/niche", label: "Niche Modules", icon: Layers },
  { to: "/simulator", label: "Test AI", icon: Sparkles },
  { to: "/settings", label: "Train My AI", icon: Settings2 },
] as const;

/**
 * Hamburger menu + slide-out drawer for the dashboard section. Replaces the
 * old stack of 6 floating round buttons pinned to the bottom-right corner —
 * that pattern overflows or overlaps content on short/narrow phone screens
 * (especially with the on-screen keyboard open, or behind iOS's home
 * indicator / Android's gesture bar).
 */
export function DashboardNav({ onSignOut }: { onSignOut: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          className="h-9 w-9 rounded-full flex items-center justify-center hover:bg-muted transition-smooth shrink-0"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[85vw] max-w-xs flex flex-col p-0">
        <SheetHeader className="p-5 pb-0 text-left">
          <SheetTitle>Wabizz</SheetTitle>
          <SheetDescription className="sr-only">Navigation menu</SheetDescription>
        </SheetHeader>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {NAV_LINKS.map((item) => {
            const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
            return (
              <SheetClose asChild key={item.to}>
                <Link
                  to={item.to}
                  className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-smooth ${
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-muted active:bg-muted/70"
                  }`}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </Link>
              </SheetClose>
            );
          })}
        </nav>

        <div className="p-3 border-t border-border/60 space-y-1">
          <InstallAppButton className="w-full justify-start" />
          <button
            onClick={onSignOut}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium text-muted-foreground hover:bg-muted active:bg-muted/70 transition-smooth"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            Sign out
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
