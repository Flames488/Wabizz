import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Zap,
  Plus,
  ArrowLeft,
  Loader2,
  Trash2,
  Edit,
  MessageSquare,
  Tag,
  UserMinus,
  ToggleLeft,
  ToggleRight,
  ChevronUp,
  ChevronDown,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useRequireAuth } from "@/hooks/use-auth";
import { useAuthedServerFn } from "@/lib/authed-fn";
import {
  createAutomationRule,
  listAutomationRules,
  updateAutomationRule,
  toggleAutomationRule,
  deleteAutomationRule,
} from "@/lib/automation.functions";

export const Route = createFileRoute("/automation")({
  head: () => ({
    meta: [
      { title: "Automation — Wabizz AI" },
      { name: "description", content: "Create keyword-triggered auto-reply rules." },
    ],
  }),
  component: AutomationPage,
});

type Rule = {
  id: string;
  name: string;
  is_active: boolean;
  priority: number;
  trigger_type: string;
  keywords: string[];
  match_mode: string;
  action_type: string;
  reply_template: string | null;
  add_tags: string[];
  match_count: number;
  created_at: string;
};

const ACTION_ICONS: Record<string, typeof MessageSquare> = {
  reply: MessageSquare,
  tag: Tag,
  opt_out: UserMinus,
};

const ACTION_LABELS: Record<string, string> = {
  reply: "Send Reply",
  tag: "Add Tags",
  opt_out: "Opt Out",
};

const MATCH_LABELS: Record<string, string> = {
  exact: "Exact match",
  contains: "Contains",
  starts_with: "Starts with",
};

function AutomationPage() {
  const { session, loading: authLoading } = useRequireAuth();
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    name: "",
    isActive: true,
    priority: 0,
    triggerType: "keyword" as const,
    keywords: "",
    matchMode: "contains" as "exact" | "contains" | "starts_with",
    actionType: "reply" as "reply" | "tag" | "opt_out",
    replyTemplate: "",
    addTags: "",
  });

  const callList = useAuthedServerFn(listAutomationRules);
  const callCreate = useAuthedServerFn(createAutomationRule);
  const callUpdate = useAuthedServerFn(updateAutomationRule);
  const callToggle = useAuthedServerFn(toggleAutomationRule);
  const callDelete = useAuthedServerFn(deleteAutomationRule);

  async function load() {
    setLoading(true);
    const res = await callList({});
    setRules((res.rules ?? []) as Rule[]);
    setLoading(false);
  }

  useEffect(() => {
    if (!authLoading && session) load();
  }, [authLoading, session]);

  function resetForm() {
    setForm({
      name: "",
      isActive: true,
      priority: 0,
      triggerType: "keyword",
      keywords: "",
      matchMode: "contains",
      actionType: "reply",
      replyTemplate: "",
      addTags: "",
    });
    setEditingRule(null);
  }

  function openEdit(r: Rule) {
    setEditingRule(r);
    setForm({
      name: r.name,
      isActive: r.is_active,
      priority: r.priority,
      triggerType: r.trigger_type as "keyword",
      keywords: (r.keywords ?? []).join(", "),
      matchMode: r.match_mode as "exact" | "contains" | "starts_with",
      actionType: r.action_type as "reply" | "tag" | "opt_out",
      replyTemplate: r.reply_template ?? "",
      addTags: (r.add_tags ?? []).join(", "),
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!form.name.trim()) return toast.error("Rule name is required.");
    if (form.triggerType === "keyword" && !form.keywords.trim()) {
      return toast.error("At least one keyword is required.");
    }
    if (form.actionType === "reply" && !form.replyTemplate.trim()) {
      return toast.error("Reply template is required.");
    }

    setSaving(true);
    const payload = {
      name: form.name,
      isActive: form.isActive,
      priority: form.priority,
      triggerType: form.triggerType,
      keywords: form.keywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
      matchMode: form.matchMode,
      actionType: form.actionType,
      replyTemplate: form.actionType === "reply" ? form.replyTemplate : undefined,
      addTags: form.addTags
        ? form.addTags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    };

    const res = editingRule
      ? await callUpdate({ id: editingRule.id, ...payload })
      : await callCreate(payload);

    setSaving(false);
    if (!res.ok) return toast.error(res.error ?? "Failed.");
    toast.success(editingRule ? "Rule updated." : "Rule created.");
    setDialogOpen(false);
    resetForm();
    load();
  }

  async function handleToggle(r: Rule) {
    const res = await callToggle({ id: r.id, isActive: !r.is_active });
    if (!res.ok) return toast.error(res.error ?? "Failed.");
    toast.success(r.is_active ? "Rule disabled." : "Rule enabled.");
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this rule?")) return;
    const res = await callDelete({ id });
    if (!res.ok) return toast.error(res.error ?? "Failed.");
    toast.success("Rule deleted.");
    load();
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/dashboard">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4 mr-1" /> Dashboard
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" /> Automation Rules
            </h1>
            <p className="text-sm text-muted-foreground">
              Keyword-triggered auto-replies and actions
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => {
            resetForm();
            setDialogOpen(true);
          }}
        >
          <Plus className="w-4 h-4 mr-1" /> New Rule
        </Button>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-6">
        {/* Explainer */}
        <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 mb-6 text-sm">
          <p className="font-medium mb-1 flex items-center gap-1.5">
            <Zap className="w-4 h-4 text-primary" /> How Automation Rules Work
          </p>
          <p className="text-muted-foreground">
            When a customer sends a WhatsApp message matching one of your keywords, the configured
            action fires automatically — without you touching anything. Rules run 24/7 in the
            background. Higher priority rules are checked first. Only the first matching rule fires.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : rules.length === 0 ? (
          <div className="text-center py-20 border border-dashed border-border rounded-xl text-muted-foreground">
            <Zap className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No automation rules yet</p>
            <p className="text-sm mt-1 mb-4">
              Create a rule to automatically reply to customer messages.
            </p>
            <Button
              size="sm"
              onClick={() => {
                resetForm();
                setDialogOpen(true);
              }}
            >
              <Plus className="w-4 h-4 mr-1" /> Create First Rule
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {rules.map((r) => {
              const ActionIcon = ACTION_ICONS[r.action_type] ?? MessageSquare;
              return (
                <div
                  key={r.id}
                  className={`border rounded-lg p-4 bg-card transition-opacity ${!r.is_active ? "opacity-50" : ""}`}
                >
                  <div className="flex items-start gap-3">
                    {/* Priority badge */}
                    <div className="flex flex-col items-center gap-0.5 mt-0.5">
                      <ChevronUp className="w-3 h-3 text-muted-foreground" />
                      <span className="text-xs font-mono text-muted-foreground">{r.priority}</span>
                      <ChevronDown className="w-3 h-3 text-muted-foreground" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        <span className="font-medium text-sm">{r.name}</span>
                        <Badge variant={r.is_active ? "default" : "secondary"} className="text-xs">
                          {r.is_active ? "Active" : "Disabled"}
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {MATCH_LABELS[r.match_mode] ?? r.match_mode}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {r.match_count} matches
                        </span>
                      </div>

                      {/* Keywords */}
                      {r.keywords && r.keywords.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          <span className="text-xs text-muted-foreground mr-1">When message</span>
                          {r.keywords.map((kw) => (
                            <span
                              key={kw}
                              className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono"
                            >
                              {kw}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Action */}
                      <div className="flex items-start gap-1.5 text-sm text-muted-foreground">
                        <ActionIcon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
                        <span className="text-xs">
                          <span className="font-medium text-foreground">
                            {ACTION_LABELS[r.action_type]}
                          </span>
                          {r.action_type === "reply" && r.reply_template && (
                            <span className="ml-1 text-muted-foreground">
                              → "{r.reply_template.slice(0, 80)}
                              {r.reply_template.length > 80 ? "…" : ""}"
                            </span>
                          )}
                          {r.action_type === "tag" && r.add_tags?.length > 0 && (
                            <span className="ml-1 text-muted-foreground">
                              → {r.add_tags.join(", ")}
                            </span>
                          )}
                        </span>
                      </div>
                    </div>

                    {/* Controls */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => handleToggle(r)}
                        title={r.is_active ? "Disable" : "Enable"}
                      >
                        {r.is_active ? (
                          <ToggleRight className="w-5 h-5 text-primary" />
                        ) : (
                          <ToggleLeft className="w-5 h-5" />
                        )}
                      </button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(r)}>
                        <Edit className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => handleDelete(r.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create/Edit Dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(o) => {
          if (!o) {
            setDialogOpen(false);
            resetForm();
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingRule ? "Edit Rule" : "New Automation Rule"}</DialogTitle>
            <DialogDescription>
              Define when to trigger and what action to take automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1 max-h-[65vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Label>Rule Name *</Label>
                <Input
                  placeholder="Order Confirmation"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label>Priority</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                  className="mt-1.5"
                />
              </div>
            </div>

            <div>
              <Label>
                Keywords *{" "}
                <span className="text-muted-foreground font-normal text-xs">(comma-separated)</span>
              </Label>
              <Input
                placeholder="hello, hi, start, menu"
                value={form.keywords}
                onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                className="mt-1.5"
              />
            </div>

            <div>
              <Label>Match Mode</Label>
              <div className="grid grid-cols-3 gap-2 mt-1.5">
                {(["contains", "exact", "starts_with"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`text-xs px-3 py-2 rounded-md border transition-all ${form.matchMode === mode ? "border-primary bg-primary/10 text-primary font-medium" : "border-border text-muted-foreground hover:border-primary/50"}`}
                    onClick={() => setForm({ ...form, matchMode: mode })}
                  >
                    {MATCH_LABELS[mode]}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>Action</Label>
              <div className="grid grid-cols-3 gap-2 mt-1.5">
                {(["reply", "tag", "opt_out"] as const).map((action) => {
                  const Icon = ACTION_ICONS[action];
                  return (
                    <button
                      key={action}
                      type="button"
                      className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border transition-all ${form.actionType === action ? "border-primary bg-primary/10 text-primary font-medium" : "border-border text-muted-foreground hover:border-primary/50"}`}
                      onClick={() => setForm({ ...form, actionType: action })}
                    >
                      <Icon className="w-3.5 h-3.5" /> {ACTION_LABELS[action]}
                    </button>
                  );
                })}
              </div>
            </div>

            {form.actionType === "reply" && (
              <div>
                <Label>Reply Template *</Label>
                <Textarea
                  placeholder={
                    "Hi {{name}}! 👋 Thanks for reaching out.\n\nReply with:\n• MENU — see our products\n• ORDER — place an order\n• HELP — talk to a human"
                  }
                  value={form.replyTemplate}
                  onChange={(e) => setForm({ ...form, replyTemplate: e.target.value })}
                  className="mt-1.5 min-h-[120px]"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Supports <code className="bg-muted px-1 rounded">{"{{name}}"}</code> merge tag.
                </p>
              </div>
            )}

            {form.actionType === "tag" && (
              <div>
                <Label>
                  Tags to Add{" "}
                  <span className="text-muted-foreground font-normal text-xs">
                    (comma-separated)
                  </span>
                </Label>
                <Input
                  placeholder="interested, hot-lead"
                  value={form.addTags}
                  onChange={(e) => setForm({ ...form, addTags: e.target.value })}
                  className="mt-1.5"
                />
              </div>
            )}

            {form.actionType === "opt_out" && (
              <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md p-3 text-sm text-amber-800 dark:text-amber-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p>
                  Contact will be marked opted-out and will no longer receive campaign messages.
                </p>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setForm({ ...form, isActive: !form.isActive })}
              >
                {form.isActive ? (
                  <ToggleRight className="w-5 h-5 text-primary" />
                ) : (
                  <ToggleLeft className="w-5 h-5" />
                )}
              </button>
              <Label
                className="cursor-pointer"
                onClick={() => setForm({ ...form, isActive: !form.isActive })}
              >
                Rule is {form.isActive ? "active" : "disabled"}
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              {editingRule ? "Save Changes" : "Create Rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
