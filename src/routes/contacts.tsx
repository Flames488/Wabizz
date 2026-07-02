import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Users,
  Plus,
  Upload,
  Search,
  Tag,
  UserMinus,
  Trash2,
  ArrowLeft,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Download,
  Filter,
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
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useRequireAuth } from "@/hooks/use-auth";
import { useAuthedServerFn } from "@/lib/authed-fn";
import {
  createContact,
  bulkImportContacts,
  listContacts,
  updateContact,
  optOutContact,
  deleteContact,
  getContactStats,
} from "@/lib/contacts.functions";

export const Route = createFileRoute("/contacts")({
  head: () => ({
    meta: [
      { title: "Contacts — Wabizz AI" },
      { name: "description", content: "Manage your WhatsApp contact list." },
    ],
  }),
  component: ContactsPage,
});

type Contact = {
  id: string;
  phone: string;
  name: string | null;
  tags: string[];
  opted_out: boolean;
  source: string;
  last_messaged_at: string | null;
  created_at: string;
};

type Stats = {
  total: number;
  active: number;
  optedOut: number;
  tags: string[];
};

function ContactsPage() {
  const { session, loading: authLoading } = useRequireAuth();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, active: 0, optedOut: 0, tags: [] });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [showOptedOut, setShowOptedOut] = useState(false);
  const [loading, setLoading] = useState(true);

  // Dialogs
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [saving, setSaving] = useState(false);

  // Form
  const [addPhone, setAddPhone] = useState("");
  const [addName, setAddName] = useState("");
  const [addTags, setAddTags] = useState("");
  const [importText, setImportText] = useState("");

  const callList = useAuthedServerFn(listContacts);
  const callStats = useAuthedServerFn(getContactStats);
  const callCreate = useAuthedServerFn(createContact);
  const callImport = useAuthedServerFn(bulkImportContacts);
  const callUpdate = useAuthedServerFn(updateContact);
  const callOptOut = useAuthedServerFn(optOutContact);
  const callDelete = useAuthedServerFn(deleteContact);

  const PAGE_SIZE = 50;

  async function loadContacts(p = page) {
    setLoading(true);
    try {
      const [res, statsRes] = await Promise.all([
        callList({
          page: p,
          pageSize: PAGE_SIZE,
          search: search || undefined,
          tag: tagFilter || undefined,
          includedOptedOut: showOptedOut,
        }),
        callStats({}),
      ]);
      setContacts((res.contacts ?? []) as Contact[]);
      setTotal(res.total ?? 0);
      setStats(statsRes as Stats);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!authLoading && session) loadContacts(1);
  }, [authLoading, session, search, tagFilter, showOptedOut]);

  async function handleCreate() {
    if (!addPhone.trim()) return toast.error("Phone number is required.");
    setSaving(true);
    const res = await callCreate({
      phone: addPhone.trim(),
      name: addName.trim() || undefined,
      tags: addTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setSaving(false);
    if (!res.ok) return toast.error(res.error ?? "Failed to add contact.");
    toast.success("Contact added.");
    setAddOpen(false);
    setAddPhone("");
    setAddName("");
    setAddTags("");
    loadContacts(1);
  }

  async function handleBulkImport() {
    if (!importText.trim()) return toast.error("Paste at least one phone number.");
    setSaving(true);

    // Parse CSV-style input: "phone,name,tag1 tag2" per line
    const lines = importText.trim().split("\n").filter(Boolean);
    const contacts = lines.map((line) => {
      const parts = line.split(",");
      return {
        phone: parts[0]?.trim() ?? "",
        name: parts[1]?.trim() || undefined,
        tags: parts[2] ? parts[2].trim().split(" ").filter(Boolean) : [],
        source: "import" as const,
        metadata: {},
      };
    });

    const res = await callImport({ contacts });
    setSaving(false);
    if (!res.ok) return toast.error(res.error ?? "Import failed.");
    toast.success(`Imported ${res.imported} contacts. Skipped ${res.skipped}.`);
    setImportOpen(false);
    setImportText("");
    loadContacts(1);
  }

  async function handleOptOut(id: string) {
    const res = await callOptOut({ id });
    if (!res.ok) return toast.error(res.error ?? "Failed.");
    toast.success("Contact opted out.");
    loadContacts(page);
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this contact? This cannot be undone.")) return;
    const res = await callDelete({ id });
    if (!res.ok) return toast.error(res.error ?? "Failed.");
    toast.success("Contact deleted.");
    loadContacts(page);
  }

  async function handleUpdateContact() {
    if (!editContact) return;
    setSaving(true);
    const res = await callUpdate({
      id: editContact.id,
      name: editContact.name ?? undefined,
      tags: editContact.tags,
    });
    setSaving(false);
    if (!res.ok) return toast.error(res.error ?? "Failed.");
    toast.success("Contact updated.");
    setEditContact(null);
    loadContacts(page);
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
              <Users className="w-5 h-5 text-primary" /> Contacts
            </h1>
            <p className="text-sm text-muted-foreground">
              {stats.active} active · {stats.optedOut} opted out · {stats.total} total
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="w-4 h-4 mr-1" /> Import
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Add Contact
          </Button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[
            { label: "Total", value: stats.total, icon: Users },
            { label: "Active", value: stats.active, icon: CheckCircle2 },
            { label: "Opted Out", value: stats.optedOut, icon: UserMinus },
            { label: "Tags", value: stats.tags.length, icon: Tag },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="border border-border rounded-lg p-4 bg-card">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                <Icon className="w-4 h-4" /> {label}
              </div>
              <div className="text-2xl font-bold">{value.toLocaleString()}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search phone or name..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <select
            className="border border-border rounded-md px-3 py-2 bg-background text-sm"
            value={tagFilter}
            onChange={(e) => {
              setTagFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All tags</option>
            {stats.tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <Button
            variant={showOptedOut ? "default" : "outline"}
            size="sm"
            onClick={() => setShowOptedOut(!showOptedOut)}
          >
            <Filter className="w-4 h-4 mr-1" />
            {showOptedOut ? "Showing All" : "Hide Opted Out"}
          </Button>
        </div>

        {/* Contact Table */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : contacts.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No contacts yet</p>
            <p className="text-sm mt-1">Add contacts manually or import a CSV list.</p>
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Phone</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Tags</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c, i) => (
                  <tr
                    key={c.id}
                    className={`border-t border-border ${i % 2 === 0 ? "" : "bg-muted/20"}`}
                  >
                    <td className="px-4 py-3 font-mono">+{c.phone}</td>
                    <td className="px-4 py-3">
                      {c.name ?? <span className="text-muted-foreground text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(c.tags ?? []).map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {c.opted_out ? (
                        <Badge variant="destructive" className="text-xs">
                          Opted Out
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-xs text-emerald-600 border-emerald-200"
                        >
                          Active
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 justify-end">
                        <Button variant="ghost" size="sm" onClick={() => setEditContact(c)}>
                          Edit
                        </Button>
                        {!c.opted_out && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-amber-600"
                            onClick={() => handleOptOut(c.id)}
                          >
                            <UserMinus className="w-3 h-3" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => handleDelete(c.id)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/20">
                <span className="text-sm text-muted-foreground">
                  {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === 1}
                    onClick={() => {
                      const p = page - 1;
                      setPage(p);
                      loadContacts(p);
                    }}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page * PAGE_SIZE >= total}
                    onClick={() => {
                      const p = page + 1;
                      setPage(p);
                      loadContacts(p);
                    }}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add Contact Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Contact</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Phone Number *</Label>
              <Input
                placeholder="2348012345678"
                value={addPhone}
                onChange={(e) => setAddPhone(e.target.value)}
                className="mt-1.5"
              />
              <p className="text-xs text-muted-foreground mt-1">
                E.164 format without '+'. Example: 2348012345678
              </p>
            </div>
            <div>
              <Label>Name (optional)</Label>
              <Input
                placeholder="John Doe"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label>Tags (comma-separated, optional)</Label>
              <Input
                placeholder="customer, vip"
                value={addTags}
                onChange={(e) => setAddTags(e.target.value)}
                className="mt-1.5"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              Add Contact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Import Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Bulk Import Contacts</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-sm text-muted-foreground">
              Paste one contact per line. Format:{" "}
              <code className="bg-muted px-1 rounded text-xs">phone, name, tag1 tag2</code>
            </p>
            <textarea
              className="w-full border border-border rounded-md p-3 text-sm font-mono bg-background min-h-[180px] resize-y"
              placeholder={
                "2348012345678, John Doe, customer vip\n2348098765432, Jane Smith, customer"
              }
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Up to 10,000 contacts per import. Duplicates are silently skipped.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleBulkImport} disabled={saving}>
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
              ) : (
                <Upload className="w-4 h-4 mr-1" />
              )}
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Contact Dialog */}
      <Dialog
        open={!!editContact}
        onOpenChange={(o) => {
          if (!o) setEditContact(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Contact</DialogTitle>
          </DialogHeader>
          {editContact && (
            <div className="space-y-4 py-2">
              <div>
                <Label>Phone</Label>
                <Input value={`+${editContact.phone}`} disabled className="mt-1.5 opacity-60" />
              </div>
              <div>
                <Label>Name</Label>
                <Input
                  value={editContact.name ?? ""}
                  onChange={(e) => setEditContact({ ...editContact, name: e.target.value })}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label>Tags (comma-separated)</Label>
                <Input
                  value={(editContact.tags ?? []).join(", ")}
                  onChange={(e) =>
                    setEditContact({
                      ...editContact,
                      tags: e.target.value
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean),
                    })
                  }
                  className="mt-1.5"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditContact(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdateContact} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
