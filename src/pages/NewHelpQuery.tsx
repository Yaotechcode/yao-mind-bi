import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { ChevronRight, Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateHelpQuery } from '@/hooks/useHelpQueries';
import { useQueryCategories } from '@/hooks/useQueryCategories';
import { useProjects } from '@/hooks/useProjects';
import type { HelpQueryPriority } from '@/hooks/useHelpQueries';

const PRIORITY_OPTIONS: { value: HelpQueryPriority; label: string }[] = [
  { value: 'low',    label: 'Low' },
  { value: 'medium', label: 'Normal' },
  { value: 'high',   label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export default function NewHelpQueryPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Pre-select project if navigated from a project page via ?projectId=
  const preselectedProjectId = searchParams.get('projectId') ?? '';

  const [title, setTitle]           = useState('');
  const [body, setBody]             = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [projectId, setProjectId]   = useState(preselectedProjectId);
  const [priority, setPriority]     = useState<HelpQueryPriority>('medium');
  const [errors, setErrors]         = useState<Record<string, string>>({});

  const createQuery = useCreateHelpQuery();
  const { data: categories = [] } = useQueryCategories();
  const { data: projects = [] }   = useProjects();

  // ── Validation ────────────────────────────────────────────────────────────
  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!title.trim())       next.title = 'Title is required';
    if (title.length > 255)  next.title = 'Title must be 255 characters or fewer';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    const data = await createQuery.mutateAsync({
      title:       title.trim(),
      description: body.trim() || undefined,
      category_id: categoryId || null,
      project_id:  projectId  || null,
      priority,
    });

    navigate(`/help/${data.id}`);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <AppLayout>
      <div className="p-6 lg:p-8 max-w-2xl mx-auto">

        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-[12px] text-muted-foreground mb-6">
          <Link to="/help" className="hover:text-foreground transition-colors">
            Help &amp; Queries
          </Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">New Query</span>
        </nav>

        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground">Submit a Query</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Describe your question or issue and our team will get back to you.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate>
          <div className="bg-card border border-border rounded-lg shadow-card p-6 space-y-5">

            {/* Title */}
            <div className="space-y-1.5">
              <Label htmlFor="title">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="title"
                placeholder="Briefly describe your question or issue"
                value={title}
                onChange={e => setTitle(e.target.value)}
                className={errors.title ? 'border-destructive focus-visible:ring-destructive' : ''}
                maxLength={255}
              />
              {errors.title && (
                <p className="text-[11px] text-destructive">{errors.title}</p>
              )}
            </div>

            {/* Body */}
            <div className="space-y-1.5">
              <Label htmlFor="body">
                Description
                <span className="text-[11px] font-normal text-muted-foreground ml-1">(optional)</span>
              </Label>
              <Textarea
                id="body"
                placeholder="Provide any additional context, steps to reproduce, or relevant details…"
                value={body}
                onChange={e => setBody(e.target.value)}
                className="min-h-[120px]"
              />
            </div>

            {/* Row: Category + Priority */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="category">Category</Label>
                <Select
                  value={categoryId || 'none'}
                  onValueChange={v => setCategoryId(v === 'none' ? '' : v)}
                >
                  <SelectTrigger id="category">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No category</SelectItem>
                    {categories.map(c => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="priority">Priority</Label>
                <Select
                  value={priority}
                  onValueChange={v => setPriority(v as HelpQueryPriority)}
                >
                  <SelectTrigger id="priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITY_OPTIONS.map(o => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Project */}
            {projects.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="project">Project</Label>
                <Select
                  value={projectId || 'none'}
                  onValueChange={v => setProjectId(v === 'none' ? '' : v)}
                >
                  <SelectTrigger id="project">
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No project</SelectItem>
                    {projects.map(p => (
                      <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate('/help')}
              disabled={createQuery.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createQuery.isPending}>
              {createQuery.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
              Submit Query
            </Button>
          </div>
        </form>

      </div>
    </AppLayout>
  );
}
