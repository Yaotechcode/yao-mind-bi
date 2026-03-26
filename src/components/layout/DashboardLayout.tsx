/**
 * DashboardLayout — Main app shell for authenticated pages.
 * Left sidebar + content area with status banners.
 */

import { Outlet } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { CalculationStatusBanner } from '@/components/layout/CalculationStatusBanner';

export default function DashboardLayout() {
  return (
    <div className="min-h-screen flex w-full bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <CalculationStatusBanner />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
