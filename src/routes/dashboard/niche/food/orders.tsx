/**
 * src/routes/dashboard/niche/food/orders.tsx
 *
 * Live food orders dashboard.
 * Shows all active orders grouped by status.  Business owners can drag
 * orders through the pipeline (paid → preparing → ready → delivered).
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import {
  ChevronRight,
  RefreshCw,
  Clock,
  CheckCircle2,
  ChefHat,
  Truck,
  Package,
} from "lucide-react";
import { useRequireAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/dashboard/niche/food/orders")({
  component: OrdersDashboard,
});

type OrderStatus = "pending" | "paid" | "preparing" | "ready" | "delivered" | "cancelled";

interface OrderRow {
  id: string;
  customer_phone: string;
  customer_name: string | null;
  items: Array<{ name: string; qty: number; unit_price: number }>;
  total_amount: number;
  status: OrderStatus;
  delivery_type: string | null;
  delivery_address: string | null;
  payment_status: string;
  created_at: string;
}

const COLUMNS: Array<{ status: OrderStatus; label: string; icon: React.ReactNode; color: string }> =
  [
    {
      status: "paid",
      label: "New Orders",
      icon: <Clock className="h-4 w-4" />,
      color: "border-yellow-400 bg-yellow-50 dark:bg-yellow-900/10",
    },
    {
      status: "preparing",
      label: "Preparing",
      icon: <ChefHat className="h-4 w-4" />,
      color: "border-blue-400 bg-blue-50 dark:bg-blue-900/10",
    },
    {
      status: "ready",
      label: "Ready",
      icon: <Package className="h-4 w-4" />,
      color: "border-green-400 bg-green-50 dark:bg-green-900/10",
    },
    {
      status: "delivered",
      label: "Delivered",
      icon: <Truck className="h-4 w-4" />,
      color: "border-gray-300 bg-gray-50 dark:bg-gray-900/10",
    },
  ];

const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  paid: "preparing",
  preparing: "ready",
  ready: "delivered",
};

const STATUS_BTN_LABEL: Partial<Record<OrderStatus, string>> = {
  paid: "Start Preparing",
  preparing: "Mark Ready",
  ready: "Mark Delivered",
};

function OrdersDashboard() {
  const { session } = useRequireAuth();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);

  const fetchOrders = useCallback(async (bizId: string) => {
    const { data } = await supabase
      .from("food_orders")
      .select(
        "id,customer_phone,customer_name,items,total_amount,status,delivery_type,delivery_address,payment_status,created_at",
      )
      .eq("business_id", bizId)
      .not("status", "in", '("cancelled","pending")')
      .order("created_at", { ascending: false })
      .limit(100);

    setOrders((data ?? []) as OrderRow[]);
  }, []);

  useEffect(() => {
    async function init() {
      if (!session?.user.id) return;
      const { data: biz } = await supabase
        .from("businesses")
        .select("id")
        .eq("user_id", session.user.id)
        .single();
      if (!biz) {
        setLoading(false);
        return;
      }
      setBusinessId(biz.id);
      await fetchOrders(biz.id);
      setLoading(false);
    }
    init();
  }, [session, fetchOrders]);

  async function refresh() {
    if (!businessId) return;
    setRefreshing(true);
    await fetchOrders(businessId);
    setRefreshing(false);
  }

  async function advanceOrder(orderId: string, currentStatus: OrderStatus) {
    const next = NEXT_STATUS[currentStatus];
    if (!next || !businessId) return;
    setMovingId(orderId);

    await supabase
      .from("food_orders")
      .update({ status: next })
      .eq("id", orderId)
      .eq("business_id", businessId);

    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: next } : o)));
    setMovingId(null);
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        Loading orders...
      </div>
    );
  }

  const byStatus = (status: OrderStatus) => orders.filter((o) => o.status === status);
  const pendingCount = orders.filter((o) => o.status === "paid").length;

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-muted-foreground text-sm mb-6 flex-wrap">
        <Link to="/dashboard/niche" className="hover:text-foreground">
          Niche Modules
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link to="/dashboard/niche/food" className="hover:text-foreground">
          Food Trader
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">Orders</span>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">
            Live Orders
            {pendingCount > 0 && (
              <span className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white font-bold">
                {pendingCount}
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {orders.length} active order{orders.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent transition"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Kanban columns */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {COLUMNS.map(({ status, label, icon, color }) => {
          const colOrders = byStatus(status);
          return (
            <div key={status} className="flex flex-col gap-2">
              {/* Column header */}
              <div className={`rounded-xl border-2 ${color} px-3 py-2 flex items-center gap-2`}>
                {icon}
                <span className="font-semibold text-sm">{label}</span>
                <span className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/70 dark:bg-black/20 text-xs font-bold">
                  {colOrders.length}
                </span>
              </div>

              {/* Order cards */}
              {colOrders.length === 0 ? (
                <div className="flex items-center justify-center rounded-xl border border-dashed border-border py-8 text-xs text-muted-foreground">
                  Empty
                </div>
              ) : (
                colOrders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    onAdvance={() => advanceOrder(order.id, order.status)}
                    advancing={movingId === order.id}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OrderCard({
  order,
  onAdvance,
  advancing,
}: {
  order: OrderRow;
  onAdvance: () => void;
  advancing: boolean;
}) {
  const nextLabel = STATUS_BTN_LABEL[order.status];
  const time = new Date(order.created_at).toLocaleTimeString("en-NG", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
  });

  const itemsSummary = (order.items ?? [])
    .slice(0, 3)
    .map((i) => `${i.qty}x ${i.name}`)
    .join(", ");

  const hasMore = (order.items ?? []).length > 3;

  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-sm flex flex-col gap-2">
      {/* Order ID + time */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono font-semibold text-muted-foreground">
          #{order.id.slice(0, 8).toUpperCase()}
        </span>
        <span className="text-xs text-muted-foreground">{time}</span>
      </div>

      {/* Customer */}
      <p className="text-sm font-semibold text-foreground truncate">
        {order.customer_name ?? order.customer_phone}
      </p>

      {/* Items */}
      <p className="text-xs text-muted-foreground line-clamp-2">
        {itemsSummary}
        {hasMore ? "…" : ""}
      </p>

      {/* Total + delivery */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-foreground">
          ₦{order.total_amount.toLocaleString()}
        </span>
        <span className="text-xs text-muted-foreground capitalize">
          {order.delivery_type ?? "—"}
        </span>
      </div>

      {/* Advance button */}
      {nextLabel && (
        <button
          onClick={onAdvance}
          disabled={advancing}
          className="w-full rounded-lg bg-primary text-primary-foreground py-1.5 text-xs font-semibold hover:opacity-90 transition disabled:opacity-50 flex items-center justify-center gap-1"
        >
          {advancing ? (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <>
              <CheckCircle2 className="h-3 w-3" />
              {nextLabel}
            </>
          )}
        </button>
      )}
    </div>
  );
}
