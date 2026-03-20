import { useState, useCallback } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  HelpCircle,
  LogOut,
  Pin,
  PinOff,
  Menu,
  X,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { useQueryStats } from '@/hooks/useQueryStats';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const STORAGE_KEY = 'yaomind-sidebar-pinned';

// ── Navigation definition ────────────────────────────────────────────────────

interface NavItem {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
}

// Rendered by SidebarNav — receives live badge counts
function buildNavItems(openQueryCount: number): NavItem[] {
  return [
    { title: 'Dashboard',      url: '/dashboard',  icon: LayoutDashboard },
    { title: 'Help & Queries', url: '/help',       icon: HelpCircle, badge: openQueryCount || 0 },
  ];
}

// ── Component ────────────────────────────────────────────────────────────────

export function AppSidebar() {
  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === 'true'; } catch { return false; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  const location = useLocation();
  const { profile, signOut, isYaoAdmin } = useAuth();

  // Badge: new + in_review queries
  const { data: stats } = useQueryStats();
  const openQueryCount = stats ? stats.new + stats.in_review : 0;

  const navItems = buildNavItems(openQueryCount);

  const togglePin = useCallback(() => {
    setPinned(prev => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch {}
      return next;
    });
  }, []);

  const handleNavClick = useCallback(() => setMobileOpen(false), []);

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'U';
    return name.trim().split(/\s+/).map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  // ── Shared nav item renderer ────────────────────────────────────────────

  const renderNavItem = (item: NavItem, isActive: boolean, expanded: boolean) => (
    <Tooltip key={item.url} delayDuration={expanded ? 9999 : 300}>
      <TooltipTrigger asChild>
        <NavLink
          to={item.url}
          onClick={handleNavClick}
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-md transition-all duration-150 relative',
            isActive
              ? 'bg-white/10 text-white border-l-2 border-white font-semibold'
              : 'text-white/85 hover:bg-white/10 hover:text-white',
            !expanded && 'justify-center',
            expanded && 'justify-start',
          )}
        >
          <item.icon className="w-5 h-5 flex-shrink-0" />
          {expanded && (
            <span className="text-sm truncate whitespace-nowrap flex-1">{item.title}</span>
          )}
          {/* Badge */}
          {(item.badge ?? 0) > 0 && (
            <span
              className={cn(
                'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-pink text-white text-[10px] font-semibold',
                !expanded && 'absolute -top-1 -right-1',
              )}
            >
              {(item.badge ?? 0) > 99 ? '99+' : item.badge}
            </span>
          )}
        </NavLink>
      </TooltipTrigger>
      {!expanded && (
        <TooltipContent side="right" className="text-xs">
          {item.title}
          {(item.badge ?? 0) > 0 && ` (${item.badge} open)`}
        </TooltipContent>
      )}
    </Tooltip>
  );

  // ── Shared sidebar body ─────────────────────────────────────────────────

  const SidebarBody = ({ expanded }: { expanded: boolean }) => (
    <>
      <nav className="flex-1 p-3 space-y-1">
        {navItems.map(item => {
          const isActive =
            location.pathname === item.url ||
            (item.url === '/help' && location.pathname.startsWith('/help'));
          return renderNavItem(item, isActive, expanded);
        })}

        {/* Admin section */}
        {isYaoAdmin && (
          <div className="pt-3 mt-3 border-t border-white/20">
            {expanded && (
              <span className="text-[10px] uppercase tracking-wider text-white/50 px-3 mb-2 block">
                Admin
              </span>
            )}
            {renderNavItem(
              { title: 'Settings', url: '/settings', icon: Settings },
              location.pathname === '/settings',
              expanded,
            )}
          </div>
        )}
      </nav>

      {/* User profile footer */}
      <div className="p-3 border-t border-white/20">
        <div className={cn('flex items-center gap-2.5', !expanded && 'flex-col')}>
          <div className="w-8 h-8 rounded-[3px] bg-white/20 flex items-center justify-center text-white text-xs font-medium flex-shrink-0">
            {getInitials(profile?.display_name)}
          </div>
          {expanded && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {profile?.display_name ?? profile?.email ?? 'User'}
              </p>
              <p className="text-[11px] text-white/60 truncate">{profile?.email}</p>
            </div>
          )}
          <Tooltip delayDuration={expanded ? 9999 : 300}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={signOut}
                className="text-white/70 hover:bg-white/10 hover:text-white flex-shrink-0"
              >
                <LogOut className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side={expanded ? 'top' : 'right'} className="text-xs">
              Sign out
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </>
  );

  // ── Mobile: hamburger + slide-over ──────────────────────────────────────

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  if (isMobile) {
    return (
      <>
        <button
          onClick={() => setMobileOpen(true)}
          className="fixed top-3 left-3 z-50 w-10 h-10 rounded-lg bg-sidebar flex items-center justify-center shadow-lg"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5 text-white" />
        </button>

        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
        )}

        <aside
          className={cn(
            'fixed left-0 top-0 bottom-0 z-50 w-72 flex flex-col transition-transform duration-200 ease-in-out shadow-2xl',
            'bg-[hsl(var(--sidebar-background,178_43%_54%))]',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex items-center justify-between p-4 border-b border-white/20">
            <span className="text-white font-semibold tracking-tight">Yao Mind</span>
            <button
              onClick={() => setMobileOpen(false)}
              className="p-1.5 rounded-md text-white/80 hover:bg-white/10"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <SidebarBody expanded />
        </aside>
      </>
    );
  }

  // ── Desktop: hover-expand with pin ──────────────────────────────────────

  return (
    <>
      {/* Spacer reserves collapsed width so content doesn't shift */}
      {!pinned && <div className="w-16 flex-shrink-0" />}

      <aside
        className={cn(
          'group/sidebar flex flex-col min-h-screen overflow-hidden transition-[width] duration-200 ease-in-out',
          // Sidebar background colour via CSS variable (defined in index.css as sidebar- tokens)
          'bg-[hsl(193,98%,35%)]',
          pinned
            ? 'relative w-60'
            : 'fixed left-0 top-0 bottom-0 z-50 w-16 hover:w-60 hover:shadow-2xl',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/20 h-14">
          <span
            className={cn(
              'text-white font-semibold tracking-tight text-sm transition-opacity duration-200 whitespace-nowrap',
              pinned ? 'opacity-100' : 'opacity-0 group-hover/sidebar:opacity-100',
            )}
          >
            Yao Mind
          </span>

          {/* Pin toggle — only visible when expanded */}
          <div
            className={cn(
              'transition-opacity duration-200',
              pinned ? 'opacity-100' : 'opacity-0 group-hover/sidebar:opacity-100',
            )}
          >
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={togglePin}
                  className={cn(
                    'transition-colors',
                    pinned
                      ? 'text-white bg-white/15 hover:bg-white/20'
                      : 'text-white/60 hover:bg-white/10 hover:text-white',
                  )}
                >
                  {pinned ? <Pin className="w-4 h-4" /> : <PinOff className="w-4 h-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                {pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Nav content — pass expanded=true when pinned OR when hovered */}
        {/* We use a CSS group trick: pinned → always expanded, else expand on hover */}
        <div
          className={cn(
            'flex flex-col flex-1',
            // When not pinned, nav items switch between collapsed/expanded via group-hover
            // We handle this by always rendering in "expanded" mode but hiding labels via CSS
          )}
        >
          {/* Pinned: always show expanded layout */}
          {pinned ? (
            <SidebarBody expanded />
          ) : (
            // Not pinned: collapsed by default, expanded on hover via CSS
            // We render two layers: collapsed (shown) and expanded (shown on hover)
            <>
              <div className="group-hover/sidebar:hidden flex flex-col flex-1">
                <SidebarBody expanded={false} />
              </div>
              <div className="hidden group-hover/sidebar:flex flex-col flex-1">
                <SidebarBody expanded />
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
