import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Megaphone,
  Plus,
  ArrowLeft,
  Play,
  Pause,
  X,
  Trash2,
  Loader2,
  Clock,
  CheckCircle2,
  AlertCircle,
  BarChart3,
  Users,
  MessageSquare,
  Calendar,
  Zap,
  Edit,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
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
  createCampaign,
  listCampaigns,
  getCampaignStats,
  launchCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  deleteCampaign,
  updateCampaign,
} from "@/lib/campaign.functions";
import { getContactStats } from "@/lib/contacts.functions";

export const Route = createFileRoute("/campaigns")({
  head: () => ({
    meta: [
      { title: "Campaigns — Wabizz AI" },
      { name: "description", content: "Manage your WhatsApp broadcast campaigns." },
    ],
  }),
  component: CampaignsPage,
});

type Campaign = {
  id: string;
  name: string;
  status: string;
  message_template: string;
  scheduled_at: string | null;
  launched_at: string | null;
  completed_at: string | null;
  total_contacts: number;
  sent_count: number;
  failed_count: number;
  pending_count: number;
  created_at: string;
};

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  draft: { label: "Draft", color: "bg-muted text-muted-foreground", icon: Edit },
  scheduled: {
    label: "Scheduled",
    color: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    icon: Calendar,
  },
  running: {
    label: "Running",
    color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    icon: Zap,
  },
  paused: {
    label: "Paused",
    color: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    icon: Pause,
  },
  completed: {
    label: "Completed",
    color: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    icon: CheckCircle2,
  },
  failed: {
    label: "Failed",
    color: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    icon: AlertCircle,
  },
  cancelled: { label: "Cancelled", color: "bg-muted text-muted-foreground", icon: X },
};

function CampaignsPage() {
  const { session, loading: authLoading } = useRequireAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [contactCount, setContactCount] = useState(0);

  // Selected campaign for stats panel
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);

  // Create/edit dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);

  // Form state
  const [form, setForm] = useState({
    name: "",
    messageTemplate: "",
    scheduledAt: "",
    messagesPerMin: 60,
    batchSize: 100,
    targetTags: "",
  });

  const callList = useAuthedServerFn(listCampaigns);
  const callCreate = useAuthedServerFn(createCampaign);
  const callUpdate = useAuthedServerFn(updateCampaign);
  const callLaunch = useAuthedServerFn(launchCampaign);
  const callPause = useAuthedServerFn(pauseCampaign);
  const callResume = useAuthedServerFn(resumeCampaign);
  const callCancel = useAuthedServerFn(cancelCampaign);
  const callDelete = useAuthedServerFn(deleteCampaign);
  const callStats = useAuthedServerFn(getCampaignStats);
  const callContactStats = useAuthedServerFn(getContactStats);

  async function load() {
    setLoading(true);
    const [res, cStats] = await Promise.all([callList({}), callContactStats({})]);
    setCampaigns((res.campaigns ?? []) as Campaign[]);
    setContactCount(cStats.active ?? 0);
    setLoading(false);
  }

  useEffect(() => {
    if (!authLoading && session) load();
  }, [authLoading, session]);

  async function loadStats(id: string) {
    const res = await callStats({ id });
    setStats(res.stats ?? null);
  }

  function openStats(id: string) {
    setSelectedId(id);
    loadStats(id);
  }

  function resetForm() {
    setForm({
      name: "",
      messageTemplate: "",
      scheduledAt: "",
      messagesPerMin: 60,
      batchSize: 100,
      targetTags: "",
    });
    setEditingCampaign(null);
  }

  async function handleSave() {
    if (!form.name.trim()) return toast.error("Campaign name is required.");
    if (!form.messageTemplate.trim()) return toast.error("Message template is required.");

    setSaving(true);
    const payload = {
      name: form.name,
      messageTemplate: form.messageTemplate,
      scheduledAt: form.scheduledAt || undefined,
      messagesPerMin: form.messagesPerMin,
      batchSize: form.batchSize,
      targetTags: form.targetTags
        ? form.targetTags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
    };

    let res;
    if (editingCampaign) {
      res = await callUpdate({ id: editingCampaign.id, ...payload });
    } else {
      res = await callCreate(payload);
    }

    setSaving(false);
    if (!res.ok) return toast.error(res.error ?? "Failed.");
    toast.success(editingCampaign ? "Campaign updated." : "Campaign created.");
    setCreateOpen(false);
    resetForm();
    load();
  }

  async function handleLaunch(id: string) {
    setLaunching(id);
    const res = await callLaunch({ id });
    setLaunching(null);
    if (!res.ok) return toast.error(res.error ?? "Failed to launch.");
    toast.success(`Campaign launched! Sending to ${res.total} contacts.`);
    load();
  }

  async function handlePause(id: string) {
    const res = await callPause({ id });
    if (!res.ok) return toast.error(res.error ?? "Failed.");
    toast.success("Campaign paused.");
    load();
  }

  async function handleResume(id: string) {
    const res = await callResume({ id });
    if (!res.ok) return toast.error(res.error ?? "Failed.");
    toast.success("Campaign resumed.");
    load();
  }

  async function handleCancel(id: string) {
    if (!confirm("Cancel this campaign? Unsent messages will be skipped.")) return;
    const res = await callCancel({ id });
    if (!res.ok) return toast.error(res.error ?? "Failed.");
    toast.success("Campaign cancelled.");
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this campaign? This cannot be undone.")) return;
    const res = await callDelete({ id });
    if (!res.ok) return toast.error(res.error ?? "Failed.");
    toast.success("Campaign deleted.");
    if (selectedId === id) setSelectedId(null);
    load();
  }

  function openEdit(c: Campaign) {
    setEditingCampaign(c);
    setForm({
      name: c.name,
      messageTemplate: c.message_template,
      scheduledAt: c.scheduled_at ?? "",
      messagesPerMin: 60,
      batchSize: 100,
      targetTags: "",
    });
    setCreateOpen(true);
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  const selectedCampaign = selectedId ? campaigns.find((c) => c.id === selectedId) : null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/dashboard">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4 mr-1" /> Dashboard
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Megaphone className="w-5 h-5 text-primary" /> Campaigns
            </h1>
            <p className="text-sm text-muted-foreground">
              {contactCount} active contacts available
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => {
            resetForm();
            setCreateOpen(true);
          }}
        >
          <Plus className="w-4 h-4 mr-1" /> New Campaign
        </Button>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6 flex gap-6">
        {/* Campaign List */}
        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : campaigns.length === 0 ? (
            <div className="text-center py-20 text-muted-foreground border border-dashed border-border rounded-xl">
              <Megaphone className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No campaigns yet</p>
              <p className="text-sm mt-1 mb-4">
                Create your first broadcast campaign and start sending.
              </p>
              <Button
                size="sm"
                onClick={() => {
                  resetForm();
                  setCreateOpen(true);
                }}
              >
                <Plus className="w-4 h-4 mr-1" /> Create Campaign
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {campaigns.map((c) => {
                const cfg = STATUS_CONFIG[c.status] ?? STATUS_CONFIG.draft;
                const Icon = cfg.icon;
                const total = c.total_contacts || 1;
                const progress =
                  total > 0 ? Math.round(((c.sent_count + c.failed_count) / total) * 100) : 0;
                const isSelected = c.id === selectedId;

                return (
                  <div
                    key={c.id}
                    className={`border rounded-lg p-4 cursor-pointer transition-all ${isSelected ? "border-primary/50 bg-primary/5" : "border-border hover:border-border/80 bg-card"}`}
                    onClick={() => openStats(c.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${cfg.color}`}
                          >
                            <Icon className="w-3 h-3" /> {cfg.label}
                          </span>
                          <span className="text-sm font-medium truncate">{c.name}</span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {c.message_template.slice(0, 100)}
                          {c.message_template.length > 100 ? "…" : ""}
                        </p>

                        {["running", "paused", "completed", "failed"].includes(c.status) && (
                          <div className="mt-2">
                            <div className="flex justify-between text-xs text-muted-foreground mb-1">
                              <span>
                                {c.sent_count} sent · {c.failed_count} failed · {c.pending_count}{" "}
                                pending
                              </span>
                              <span>{progress}%</span>
                            </div>
                            <Progress value={progress} className="h-1.5" />
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div
                        className="flex items-center gap-1 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {c.status === "draft" && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                              <Edit className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              disabled={launching === c.id}
                              onClick={() => handleLaunch(c.id)}
                            >
                              {launching === c.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Play className="w-3.5 h-3.5 mr-1" />
                              )}
                              Launch
                            </Button>
                          </>
                        )}
                        {c.status === "scheduled" && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                              <Edit className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              disabled={launching === c.id}
                              onClick={() => handleLaunch(c.id)}
                            >
                              {launching === c.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Play className="w-3.5 h-3.5 mr-1" />
                              )}
                              Send Now
                            </Button>
                          </>
                        )}
                        {c.status === "running" && (
                          <Button variant="outline" size="sm" onClick={() => handlePause(c.id)}>
                            <Pause className="w-3.5 h-3.5 mr-1" /> Pause
                          </Button>
                        )}
                        {c.status === "paused" && (
                          <Button size="sm" onClick={() => handleResume(c.id)}>
                            <Play className="w-3.5 h-3.5 mr-1" /> Resume
                          </Button>
                        )}
                        {["running", "paused", "scheduled"].includes(c.status) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => handleCancel(c.id)}
                          >
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        {["draft", "completed", "cancelled", "failed"].includes(c.status) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => handleDelete(c.id)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Stats Panel */}
        {selectedCampaign && (
          <div className="w-72 shrink-0">
            <div className="border border-border rounded-lg p-4 bg-card sticky top-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-sm flex items-center gap-1.5">
                  <BarChart3 className="w-4 h-4 text-primary" /> Analytics
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => setSelectedId(null)}
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>

              <p className="text-xs font-medium truncate text-muted-foreground mb-3">
                {selectedCampaign.name}
              </p>

              {stats ? (
                <div className="space-y-3 text-sm">
                  {[
                    {
                      label: "Total Contacts",
                      value: (stats.total_contacts as number)?.toLocaleString() ?? "0",
                      icon: Users,
                    },
                    {
                      label: "Sent",
                      value: (stats.sent_count as number)?.toLocaleString() ?? "0",
                      icon: CheckCircle2,
                    },
                    {
                      label: "Failed",
                      value: (stats.failed_count as number)?.toLocaleString() ?? "0",
                      icon: AlertCircle,
                    },
                    {
                      label: "Pending",
                      value: (stats.pending_count as number)?.toLocaleString() ?? "0",
                      icon: Clock,
                    },
                  ].map(({ label, value, icon: Icon }) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <Icon className="w-3.5 h-3.5" /> {label}
                      </span>
                      <span className="font-medium">{value}</span>
                    </div>
                  ))}

                  <div className="border-t border-border pt-3">
                    <div className="flex justify-between mb-1 text-xs text-muted-foreground">
                      <span>Progress</span>
                      <span>{(stats.progressPct as number) ?? 0}%</span>
                    </div>
                    <Progress value={(stats.progressPct as number) ?? 0} className="h-2" />
                  </div>

                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Success Rate</span>
                    <span className="font-medium text-emerald-600">
                      {(stats.successRate as number) ?? 0}%
                    </span>
                  </div>

                  {(stats.estimatedMinutesRemaining as number) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Est. Remaining</span>
                      <span className="font-medium">
                        {stats.estimatedMinutesRemaining as number}m
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              )}

              <Button
                variant="outline"
                size="sm"
                className="w-full mt-3"
                onClick={() => loadStats(selectedId!)}
              >
                Refresh
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Create/Edit Campaign Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          if (!o) {
            setCreateOpen(false);
            resetForm();
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingCampaign ? "Edit Campaign" : "New Campaign"}</DialogTitle>
            <DialogDescription>
              Send a message to all (or a tagged subset) of your active contacts.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div>
              <Label>Campaign Name *</Label>
              <Input
                placeholder="May Promo Blast"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="mt-1.5"
              />
            </div>

            <div>
              <Label>Message Template *</Label>
              <Textarea
                placeholder={
                  "Hello {{name}},\n\nWe have a special offer just for you! 🎁\n\nReply YES to learn more."
                }
                value={form.messageTemplate}
                onChange={(e) => setForm({ ...form, messageTemplate: e.target.value })}
                className="mt-1.5 min-h-[120px]"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Supports merge tags: <code className="bg-muted px-1 rounded">{"{{name}}"}</code>{" "}
                <code className="bg-muted px-1 rounded">{"{{business_name}}"}</code>
              </p>
            </div>

            <div>
              <Label>Filter by Tags (optional, comma-separated)</Label>
              <Input
                placeholder="vip, customer"
                value={form.targetTags}
                onChange={(e) => setForm({ ...form, targetTags: e.target.value })}
                className="mt-1.5"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Leave blank to send to all active contacts.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Messages / Minute</Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={form.messagesPerMin}
                  onChange={(e) => setForm({ ...form, messagesPerMin: Number(e.target.value) })}
                  className="mt-1.5"
                />
                <p className="text-xs text-muted-foreground mt-1">Max 60 messages per minute</p>
              </div>
              <div>
                <Label>Batch Size</Label>
                <Input
                  type="number"
                  min={10}
                  max={500}
                  value={form.batchSize}
                  onChange={(e) => setForm({ ...form, batchSize: Number(e.target.value) })}
                  className="mt-1.5"
                />
                <p className="text-xs text-muted-foreground mt-1">Contacts per queue job</p>
              </div>
            </div>

            <div>
              <Label>Schedule (optional)</Label>
              <Input
                type="datetime-local"
                value={form.scheduledAt}
                onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
                className="mt-1.5"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Leave blank to save as draft and launch manually.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateOpen(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              {editingCampaign ? "Save Changes" : "Create Campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
