import { useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Loader2, Lock } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/useAuth";
import { useQueryMessages, useAddMessage } from "@/hooks/useQueryThread";
import { cn } from "@/lib/utils";

interface QueryThreadProps {
  queryId: string;
  className?: string;
}

export function QueryThread({ queryId, className }: QueryThreadProps) {
  const { profile, isYaoAdmin } = useAuth();
  const { data: messages = [], isLoading } = useQueryMessages(queryId);
  const addMessage = useAddMessage();

  const [body, setBody] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const handleSubmit = async () => {
    const trimmed = body.trim();
    if (!trimmed || addMessage.isPending) return;

    await addMessage.mutateAsync({
      query_id: queryId,
      body: trimmed,
      is_internal: isYaoAdmin ? isInternal : false,
    });

    setBody("");
    setIsInternal(false);
    // Scroll to bottom after message lands
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* ── Message list ── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin space-y-3 p-4">
        {isLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span className="text-sm">Loading messages…</span>
          </div>
        )}

        {!isLoading && messages.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-8">
            No messages yet. Be the first to reply.
          </p>
        )}

        {messages.map((msg) => {
          const isOwn = msg.author_id === profile?.id;
          const initials = getInitials(msg.author?.full_name);
          const timeAgo = formatDistanceToNow(new Date(msg.created_at), { addSuffix: true });

          return (
            <div
              key={msg.id}
              className={cn(
                "flex gap-3",
                isOwn && "flex-row-reverse",
              )}
            >
              {/* Avatar */}
              <Avatar className="h-7 w-7 shrink-0 mt-0.5">
                <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
              </Avatar>

              <div className={cn("flex flex-col gap-1 max-w-[75%]", isOwn && "items-end")}>
                {/* Author + timestamp */}
                <div className={cn("flex items-baseline gap-1.5", isOwn && "flex-row-reverse")}>
                  <span className="text-[11px] font-semibold text-foreground">
                    {msg.author?.full_name ?? "Unknown"}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{timeAgo}</span>
                  {/* Internal label — only admins see these messages */}
                  {msg.is_internal && (
                    <span className="inline-flex items-center gap-0.5 text-[9px] font-medium uppercase text-warning bg-warning/10 rounded-[3px] px-1.5 py-0.5">
                      <Lock className="h-2.5 w-2.5" />
                      Internal note
                    </span>
                  )}
                </div>

                {/* Bubble */}
                <div
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm leading-relaxed",
                    msg.is_internal
                      ? "bg-muted/60 border border-border text-muted-foreground italic"
                      : isOwn
                      ? "bg-primary text-primary-foreground"
                      : "bg-card border border-border text-foreground",
                  )}
                >
                  {msg.body}
                </div>
              </div>
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {/* ── Compose area ── */}
      <div className="border-t border-border p-4 space-y-3 bg-card">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Write a reply… (⌘↵ to send)"
          className="resize-none min-h-[80px] text-sm"
          disabled={addMessage.isPending}
        />

        <div className="flex items-center justify-between gap-3">
          {/* Internal note toggle — admin only */}
          {isYaoAdmin && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="internal-note"
                checked={isInternal}
                onCheckedChange={(val) => setIsInternal(val === true)}
              />
              <Label
                htmlFor="internal-note"
                className="text-[11px] text-muted-foreground cursor-pointer select-none"
              >
                Mark as internal note
              </Label>
            </div>
          )}

          <div className="flex items-center gap-2 ml-auto">
            <Button
              onClick={handleSubmit}
              disabled={!body.trim() || addMessage.isPending}
              size="sm"
            >
              {addMessage.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
