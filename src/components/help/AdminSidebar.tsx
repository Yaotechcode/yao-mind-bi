import { useState, useEffect } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { useUpdateHelpQuery } from "@/hooks/useHelpQueries";
import { useQueryCategories } from "@/hooks/useQueryCategories";
import { useAllYaoAdmins } from "@/hooks/useAllYaoAdmins";
import type { HelpQuery, HelpQueryStatus, HelpQueryPriority } from "@/hooks/useHelpQueries";

interface AdminSidebarProps {
  query: HelpQuery;
  onUpdate?: () => void;
  className?: string;
}

// ── Local types ───────────────────────────────────────────────────────────────

interface SidebarState {
  status: HelpQueryStatus;
  categoryId: string | null;
  assignedTo: string | null;
  priority: HelpQueryPriority;
  promoteToKb: boolean;
  internalNotes: string;
}

// ── Status options ─────────────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: HelpQueryStatus; label: string }[] = [
  { value: "new",        label: "New" },
  { value: "in_review",  label: "In Review" },
  { value: "responded",  label: "Responded" },
  { value: "closed",     label: "Closed" },
];

const PRIORITY_OPTIONS: { value: HelpQueryPriority; label: string }[] = [
  { value: "low",    label: "Low" },
  { value: "medium", label: "Normal" },
  { value: "high",   label: "High" },
  { value: "urgent", label: "Urgent" },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function AdminSidebar({ query, onUpdate, className }: AdminSidebarProps) {
  const { isYaoAdmin } = useAuth();
  const updateQuery = useUpdateHelpQuery();
  const { data: categories = [] } = useQueryCategories();
  const { data: admins = [] } = useAllYaoAdmins();

  // Initialise local form state from the query prop
  const [form, setForm] = useState<SidebarState>({
    status:       query.status,
    categoryId:   query.category_id,
    assignedTo:   query.assigned_to,
    priority:     query.priority,
    promoteToKb:  query.promote_to_kb,
    internalNotes: query.internal_notes ?? "",
  });
  const [notesDirty, setNotesDirty] = useState(false);

  // Keep form in sync if parent refreshes the query prop
  useEffect(() => {
    setForm({
      status:       query.status,
      categoryId:   query.category_id,
      assignedTo:   query.assigned_to,
      priority:     query.priority,
      promoteToKb:  query.promote_to_kb,
      internalNotes: query.internal_notes ?? "",
    });
    setNotesDirty(false);
  }, [query.id]); // re-init only when navigating to a different query

  if (!isYaoAdmin) return null;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleSave = async () => {
    await updateQuery.mutateAsync({
      id:              query.id,
      status:          form.status,
      category_id:     form.categoryId,
      assigned_to:     form.assignedTo,
      priority:        form.priority,
      promote_to_kb:   form.promoteToKb,
      internal_notes:  form.internalNotes,
      _prev_status:    query.status,
      _prev_assigned_to: query.assigned_to,
    });
    setNotesDirty(false);
    onUpdate?.();
  };

  const set = <K extends keyof SidebarState>(key: K, value: SidebarState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const isDirty =
    form.status       !== query.status       ||
    form.categoryId   !== query.category_id  ||
    form.assignedTo   !== query.assigned_to  ||
    form.priority     !== query.priority     ||
    form.promoteToKb  !== query.promote_to_kb ||
    notesDirty;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <aside className={className}>
      <div className="space-y-5">

        {/* Status */}
        <Field label="Status">
          <Select
            value={form.status}
            onValueChange={(v) => set("status", v as HelpQueryStatus)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* Category */}
        <Field label="Category">
          <Select
            value={form.categoryId ?? "none"}
            onValueChange={(v) => set("categoryId", v === "none" ? null : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="No category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No category</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* Assigned to */}
        <Field label="Assigned to">
          <Select
            value={form.assignedTo ?? "unassigned"}
            onValueChange={(v) => set("assignedTo", v === "unassigned" ? null : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {admins.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.display_name ?? a.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* Priority */}
        <Field label="Priority">
          <Select
            value={form.priority}
            onValueChange={(v) => set("priority", v as HelpQueryPriority)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* Promote to KB */}
        <div className="flex items-start gap-2.5">
          <Checkbox
            id="promote-to-kb"
            checked={form.promoteToKb}
            onCheckedChange={(val) => set("promoteToKb", val === true)}
            className="mt-0.5"
          />
          <div>
            <Label
              htmlFor="promote-to-kb"
              className="text-sm cursor-pointer"
            >
              Promote to knowledge base
            </Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Flag this query as a candidate for the public KB article.
            </p>
          </div>
        </div>

        {/* Save button */}
        <Button
          onClick={handleSave}
          disabled={!isDirty || updateQuery.isPending}
          className="w-full"
          size="sm"
        >
          {updateQuery.isPending
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <Save className="h-3 w-3" />
          }
          Save changes
        </Button>

        {/* Divider */}
        <hr className="border-border" />

        {/* Internal notes — separate save intentionally not required;
            saved together with the main form for simplicity.
            Shown as read-only-style textarea that unlocks on focus. */}
        <Field label="Internal notes">
          <Textarea
            value={form.internalNotes}
            onChange={(e) => {
              set("internalNotes", e.target.value);
              setNotesDirty(true);
            }}
            placeholder="Notes visible only to Yao admins…"
            className="min-h-[100px] text-sm bg-muted/40 focus:bg-background transition-colors"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            Only visible to Yao admins. Saved with the form above.
          </p>
        </Field>

      </div>
    </aside>
  );
}

// ── Helper ────────────────────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
