import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { ConfigProvider } from '@/providers/ConfigProvider';
import { TooltipProvider } from '@/components/ui/tooltip';

// Auth pages
import LoginPage from '@/pages/LoginPage';
import RegisterPage from '@/pages/RegisterPage';
import ForgotPasswordPage from '@/pages/ForgotPasswordPage';
import ResetPasswordPage from '@/pages/ResetPasswordPage';

// Layout
import DashboardLayout from '@/components/layout/DashboardLayout';
import { DashboardPlaceholder } from '@/components/layout/DashboardPlaceholder';
import FirmOverviewPage from '@/pages/FirmOverviewPage';
import FeeEarnerPerformancePage from '@/pages/FeeEarnerPerformancePage';
import WipDashboardPage from '@/pages/WipDashboardPage';
import BillingDashboardPage from '@/pages/BillingDashboardPage';
import MatterAnalysisPage from '@/pages/MatterAnalysisPage';
import DataManagementPage from '@/pages/DataManagementPage';
import SettingsPage from '@/pages/SettingsPage';

// Help pages (existing)
import HelpQueriesPage from '@/pages/HelpQueries';
import HelpQueryDetailPage from '@/pages/HelpQueryDetail';
import NewHelpQueryPage from '@/pages/NewHelpQuery';

// ── Query client ──────────────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

// ── Route guards ──────────────────────────────────────────────────────────────

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, roleLoading } = useAuth();

  if (loading || roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-primary text-sm font-medium">Loading…</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-primary text-sm font-medium">Loading…</div>
      </div>
    );
  }

  if (user) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

// ── Routes ────────────────────────────────────────────────────────────────────

function AppRoutes() {
  return (
    <Routes>
      {/* Root → redirect to dashboard */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />

      {/* Public auth routes */}
      <Route path="/login" element={<PublicOnlyRoute><LoginPage /></PublicOnlyRoute>} />
      <Route path="/register" element={<PublicOnlyRoute><RegisterPage /></PublicOnlyRoute>} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* Legacy auth route redirect */}
      <Route path="/auth" element={<Navigate to="/login" replace />} />

      {/* Protected dashboard routes */}
      <Route
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<FirmOverviewPage />} />
        <Route path="/fee-earners" element={<FeeEarnerPerformancePage />} />
        <Route path="/wip" element={<WipDashboardPage />} />
        <Route path="/billing" element={<BillingDashboardPage />} />
        <Route path="/matters" element={<MatterAnalysisPage />} />
        <Route path="/clients" element={<DashboardPlaceholder title="Client Intelligence" />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/data" element={<DataManagementPage />} />

        {/* Help routes inside layout */}
        <Route path="/help" element={<HelpQueriesPage />} />
        <Route path="/help/new" element={<NewHelpQueryPage />} />
        <Route path="/help/:id" element={<HelpQueryDetailPage />} />
      </Route>

      {/* 404 */}
      <Route
        path="*"
        element={
          <div className="min-h-screen flex items-center justify-center bg-background">
            <p className="text-sm text-muted-foreground">Page not found</p>
          </div>
        }
      />
    </Routes>
  );
}

// ── App root ──────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster richColors position="top-right" />
        <BrowserRouter>
          <AuthProvider>
            <ConfigProvider>
              <AppRoutes />
            </ConfigProvider>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
