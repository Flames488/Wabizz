import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
  Package,
  Loader2,
  User,
  Bot,
  CheckCheck,
} from "lucide-react";
import { useRequireAuth } from "@/hooks/use-auth";
import { useAuthedServerFn } from "@/lib/authed-fn";
import { getConversationDetail, resolveConversation } from "@/lib/conversation.functions";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export const Route = createFileRoute("/conversation/$id")({
  validateSearch: z.object({}).optional(),
  head: () => ({
    meta: [
      { title: "Conversation — Wabizz AI" },
      { name: "description", content: "Full message thread for this customer." },
    ],
  }),
  component: ConversationDetail,
});

const statusStyles: Record<string, string> = {
  handled: "bg-muted text-muted-foreground",
  needs_you: "bg-warning/15 text-warning-foreground border border-warning/30",
  order_placed: "bg-success/15 text-success border border-success/30",
  open: "bg-primary/10 text-primary border border-primary/20",
};

const statusIcon: Record<string, typeof CheckCircle2> = {
  handled: CheckCircle2,
  needs_you: AlertCircle,
  order_placed: Package,
  open: CheckCheck,
};

const statusLabel: Record<string, string> = {
  handled: "Handled",
  needs_you: "Needs You",
  order_placed: "Order Placed",
  open: "Open",
};

type Message = {
  id: string;
  role: string;
  content: string;
  created_at: string;
};

type Conversation = {
  id: string;
  customer_name: string | null;
  customer_number: string;
  status: string;
  last_message_at: string;
  created_at: string;
};

function ConversationDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { session, loading: authLoading } = useRequireAuth();
  const callDetail = useAuthedServerFn(getConversationDetail);
  const callResolve = useAuthedServerFn(resolveConversation);

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (!session) return;
    callDetail({ data: { conversationId: id } })
      .then((res) => {
        if (!res.ok) {
          toast.error(res.error ?? "Conversation not found");
          navigate({ to: "/dashboard" });
          return;
        }
        setConversation(res.conversation as Conversation);
        setMessages(res.messages as Message[]);
      })
      .catch(() => {
        toast.error("Couldn't load conversation. Please try again.");
        navigate({ to: "/dashboard" });
      })
      .finally(() => setLoading(false));
  }, [session, id]);

  const handleResolve = async () => {
    if (!conversation) return;
    setResolving(true);
    const res = await callResolve({ data: { conversationId: id } });
    if (!res.ok) {
      toast.error(res.error ?? "Couldn't resolve conversation");
      setResolving(false);
      return;
    }
    toast.success("Conversation marked as handled ✓");
    setConversation({ ...conversation, status: "handled" });
    setResolving(false);
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!conversation) return null;

  const Icon = statusIcon[conversation.status] ?? CheckCircle2;
  const displayName = conversation.customer_name ?? conversation.customer_number;
  const initials = displayName
    .split(/\s+/)
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      {/* Header */}
      <header className="bg-card border-b border-border/60 sticky top-0 z-10 backdrop-blur-md bg-card/90">
        <div className="mx-auto max-w-2xl px-4 py-3 flex items-center gap-3">
          <Link
            to="/dashboard"
            className="h-8 w-8 rounded-full flex items-center justify-center hover:bg-muted transition-smooth shrink-0"
            aria-label="Back to dashboard"
          >
            <ArrowLeft className="h-4 w-4 text-muted-foreground" />
          </Link>

          <div className="h-9 w-9 rounded-full bg-gradient-primary flex items-center justify-center text-primary-foreground font-semibold text-sm shrink-0">
            {initials}
          </div>

          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate">{displayName}</p>
            {conversation.customer_name && (
              <p className="text-xs text-muted-foreground truncate">
                {conversation.customer_number}
              </p>
            )}
          </div>

          <div
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0 ${
              statusStyles[conversation.status] ?? statusStyles.handled
            }`}
          >
            <Icon className="h-3 w-3" />
            {statusLabel[conversation.status] ?? conversation.status}
          </div>
        </div>
      </header>

      {/* Message thread */}
      <main className="flex-1 mx-auto w-full max-w-2xl px-4 py-4 space-y-3 pb-28 animate-fade-in">
        {messages.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No messages yet in this conversation.
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.role === "user";
          return (
            <div key={msg.id} className={`flex gap-2 ${isUser ? "justify-start" : "justify-end"}`}>
              {isUser && (
                <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-1">
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
              )}

              <div
                className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm ${
                  isUser
                    ? "bg-card border border-border/50 text-foreground rounded-tl-sm"
                    : "bg-primary text-primary-foreground rounded-tr-sm"
                }`}
              >
                {msg.content}
                <p
                  className={`text-[10px] mt-1 ${
                    isUser ? "text-muted-foreground" : "text-primary-foreground/70"
                  }`}
                >
                  {formatTime(msg.created_at)}
                </p>
              </div>

              {!isUser && (
                <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
                  <Bot className="h-3.5 w-3.5 text-primary" />
                </div>
              )}
            </div>
          );
        })}
      </main>

      {/* Footer action */}
      {conversation.status === "needs_you" && (
        <div className="fixed bottom-0 left-0 right-0 bg-card/95 backdrop-blur-md border-t border-border/60 px-4 py-3">
          <div className="mx-auto max-w-2xl">
            <div className="bg-warning/10 border border-warning/30 rounded-xl p-3 mb-3 flex gap-2 items-start">
              <AlertCircle className="h-4 w-4 text-warning-foreground shrink-0 mt-0.5" />
              <p className="text-xs text-warning-foreground">
                This customer needs your personal attention. Reply to them on WhatsApp, then mark
                this conversation as handled.
              </p>
            </div>
            <Button
              onClick={handleResolve}
              disabled={resolving}
              className="w-full"
              variant="default"
            >
              {resolving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Marking as handled…
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  Mark as handled
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();

  if (isToday) {
    return d.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", hour12: true });
  }
  return d.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}
