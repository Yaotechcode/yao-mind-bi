import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { TooltipProvider } from '@/components/ui/tooltip';
import HelpQueriesPage from './pages/HelpQueries';
import HelpQueryDetailPage from './pages/HelpQueryDetail';
import NewHelpQueryPage from './pages/NewHelpQuery';

// ── Query client ──────────────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,   // 5 minutes
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

  if (!user) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}

// ── Routes ────────────────────────────────────────────────────────────────────

function AppRoutes() {
  return (
    <Routes>
      {/* Root → redirect to help (adjust when dashboard exists) */}
      <Route path="/" element={<Navigate to="/help" replace />} />

      {/* Help & Queries */}
      <Route
        path="/help"
        element={
          <ProtectedRoute>
            <HelpQueriesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/help/new"
        element={
          <ProtectedRoute>
            <NewHelpQueryPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/help/:id"
        element={
          <ProtectedRoute>
            <HelpQueryDetailPage />
          </ProtectedRoute>
        }
      />

      {/* Placeholder: auth page (to be built) */}
      <Route
        path="/auth"
        element={
          <div className="min-h-screen flex items-center justify-center bg-background">
            <p className="text-muted-foreground text-sm">Auth page — coming soon</p>
          </div>
        }
      />

      {/* Dashboard placeholder */}
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <div className="min-h-screen flex items-center justify-center bg-background">
              <p className="text-muted-foreground text-sm">Dashboard — coming soon</p>
            </div>
          </ProtectedRoute>
        }
      />

      {/* 404 */}
      <Route
        path="*"
        element={
          <div className="min-h-screen flex items-center justify-center bg-background">
            <p className="text-muted-foreground text-sm">Page not found</p>
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
            <AppRoutes />
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
