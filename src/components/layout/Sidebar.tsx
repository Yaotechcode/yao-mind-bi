/**
 * Sidebar — collapsible left navigation for Yao Mind.
 */

import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  BarChart3,
  User,
  Clock,
  PoundSterling,
  ClipboardList,
  Users,
  Settings,
  FolderOpen,
  LogOut,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';

const navItems = [
  { label: 'Firm Overview', to: '/dashboard', icon: BarChart3 },
  { label: 'Fee Earner Performance', to: '/fee-earners', icon: User },
  { label: 'Work in Progress', to: '/wip', icon: Clock },
  { label: 'Billing & Collections', to: '/billing', icon: PoundSterling },
  { label: 'Matter Analysis', to: '/matters', icon: ClipboardList },
  { label: 'Client Intelligence', to: '/clients', icon: Users },
  { label: 'Settings', to: '/settings', icon: Settings },
  { label: 'Data Management', to: '/data', icon: FolderOpen },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <aside
      className={cn(
        'flex flex-col border-r border-border bg-card transition-all duration-200',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between h-14 px-3 border-b border-border">
        {!collapsed && (
          <span className="text-sm font-bold text-foreground tracking-tight">Yao Mind</span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </Button>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-2 overflow-y-auto scrollbar-thin">
        <ul className="space-y-0.5 px-2">
          {navItems.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] font-medium transition-colors',
                    isActive
                      ? 'bg-accent text-primary'
                      : 'text-menu-foreground hover:bg-muted hover:text-foreground',
                  )
                }
                title={collapsed ? item.label : undefined}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Footer — user info */}
      <div className="border-t border-border p-3">
        {!collapsed && profile && (
          <div className="mb-2">
            <p className="text-xs font-medium text-foreground truncate">
              {profile.display_name ?? profile.email}
            </p>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
              {profile.role}
            </p>
          </div>
        )}
        <Button
          variant="ghost"
          size={collapsed ? 'icon-sm' : 'sm'}
          className={cn('text-muted-foreground hover:text-destructive', !collapsed && 'w-full justify-start')}
          onClick={handleLogout}
          title="Sign out"
        >
          <LogOut className="h-4 w-4" />
          {!collapsed && <span className="ml-2">Sign out</span>}
        </Button>
      </div>
    </aside>
  );
}
