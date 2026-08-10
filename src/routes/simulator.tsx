import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Send, Copy, Check, Bot, Link as LinkIcon, Loader2 } from "lucide-react";
import { chatWithAI } from "@/lib/chat.functions";
import { extractAmount } from "@/lib/paystack";
import { toast } from "sonner";
import { useRequireAuth } from "@/hooks/use-auth";
import { useAuthedServerFn } from "@/lib/authed-fn";
import { getMyBusiness } from "@/lib/business.functions";
import { generateOrderPaymentLink } from "@/lib/payment-link.functions";

export const Route = createFileRoute("/simulator")({
  head: () => ({
    meta: [
      { title: "AI Simulator — Wabizz AI" },
      { name: "description", content: "Test how your AI assistant replies to customers." },
    ],
  }),
  component: Simulator,
});

type Msg = {
  role: "user" | "assistant";
  content: string;
  id: number;
  paymentLink?: string; // Paystack URL
  bankTransferMessage?: string; // bank transfer details message
};

function Simulator() {
  const { session, loading: authLoading } = useRequireAuth();
  const callBiz = useAuthedServerFn(getMyBusiness);
  const callLink = useAuthedServerFn(generateOrderPaymentLink);
  const callChat = useAuthedServerFn(chatWithAI);

  const [profile, setProfile] = useState<{
    name: string;
    type: string;
    products_list: string;
    open_time: string;
    close_time: string;
    tone: "Professional" | "Friendly" | "Pidgin";
    custom_message: string | null;
  } | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session) return;
    callBiz().then((res) => {
      if (res.business) {
        setProfile({
          name: res.business.name,
          type: res.business.type,
          products_list: res.business.products_list,
          open_time: res.business.open_time,
          close_time: res.business.close_time,
          tone: res.business.tone as "Professional" | "Friendly" | "Pidgin",
          custom_message: res.business.custom_message,
        });
      }
    });
  }, [session, callBiz]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const send = async () => {
    if (!input.trim() || !profile || loading) return;
    const userMsg: Msg = { role: "user", content: input.trim(), id: Date.now() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);

    try {
      const res = await callChat({
        data: {
          businessName: profile.name,
          businessType: profile.type,
          productsList: profile.products_list,
          businessHours: `${profile.open_time} – ${profile.close_time}`,
          tone: profile.tone,
          customMessage: profile.custom_message ?? undefined,
          messages: newMessages.map(({ role, content }) => ({ role, content })),
        },
      });

      if (res.error || !res.reply) {
        toast.error(res.error ?? "Something went wrong");
      } else {
        setMessages((m) => [...m, { role: "assistant", content: res.reply!, id: Date.now() + 1 }]);
      }
    } catch (e) {
      // Client-side network error — surface to user via toast only
      toast.error("Failed to reach AI. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const copy = async (id: number, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };
  const copyLink = async (id: number, url: string) => {
    await navigator.clipboard.writeText(url);
    setCopiedLinkId(id);
    setTimeout(() => setCopiedLinkId(null), 1500);
  };

  const generateLink = async (msg: Msg, idx: number) => {
    // Scan the whole conversation up to this message, not just the message
    // itself and the one before it — the price is often quoted several turns
    // earlier than where the customer actually asks for payment details.
    const amounts = messages
      .slice(0, idx + 1)
      .map((m) => extractAmount(m.content))
      .filter((n): n is number => n !== null);
    const amount = amounts.length ? Math.max(...amounts) : null;
    if (!amount) return toast.error("No amount found in this conversation yet.");

    const res = await callLink({ data: { amountNaira: amount } });
    if (!res.ok) {
      toast.error(res.error ?? "Couldn't generate payment details");
      return;
    }

    // Bank transfer: server returns a WhatsApp message with account details
    if ((res as { bankTransferMessage?: string }).bankTransferMessage) {
      const msg2 = (res as { bankTransferMessage: string }).bankTransferMessage;
      setMessages((all) =>
        all.map((m) => (m.id === msg.id ? { ...m, bankTransferMessage: msg2 } : m)),
      );
      toast.success(`Bank transfer details ready — ₦${amount.toLocaleString()}`);
      return;
    }

    // Paystack: server returns a checkout URL
    if (res.url) {
      setMessages((all) => all.map((m) => (m.id === msg.id ? { ...m, paymentLink: res.url! } : m)));
      toast.success(`Payment link ready — ₦${amount.toLocaleString()}`);
    }
  };

  if (authLoading || !profile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[oklch(0.95_0.015_140)]">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[oklch(0.95_0.015_140)]">
      <header className="bg-primary text-primary-foreground sticky top-0 z-10 shadow-md">
        <div className="mx-auto max-w-2xl px-4 py-3 flex items-center gap-3">
          <Link
            to="/dashboard"
            className="h-9 w-9 rounded-full flex items-center justify-center hover:bg-white/10 transition-smooth -ml-2"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="h-10 w-10 rounded-full bg-white/15 flex items-center justify-center">
            <Bot className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-semibold text-sm truncate">{profile.name} AI</h1>
            <p className="text-xs opacity-80 flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-soft" />
              online · simulator mode
            </p>
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-5"
        style={{
          backgroundImage: "radial-gradient(oklch(0.88 0.02 140) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      >
        <div className="mx-auto max-w-2xl space-y-3">
          {messages.length === 0 && (
            <div className="text-center py-12 animate-fade-in">
              <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-card shadow-sm mb-3">
                <Bot className="h-7 w-7 text-primary" />
              </div>
              <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                Pretend you're a customer. Ask about prices, delivery, or place an order — see how
                your AI replies.
              </p>
            </div>
          )}

          {messages.map((m, idx) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} animate-slide-up`}
            >
              <div
                className={`max-w-[85%] ${m.role === "user" ? "items-end" : "items-start"} flex flex-col`}
              >
                <div
                  className={`px-3.5 py-2.5 rounded-2xl shadow-sm whitespace-pre-wrap text-sm leading-relaxed ${m.role === "user" ? "bg-[oklch(0.85_0.08_140)] text-foreground rounded-br-sm" : "bg-card text-card-foreground rounded-bl-sm"}`}
                >
                  {m.content}
                </div>
                {m.role === "assistant" && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => copy(m.id, m.content)}
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-smooth px-2 py-0.5"
                    >
                      {copiedId === m.id ? (
                        <>
                          <Check className="h-3 w-3" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" /> Copy response
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => generateLink(m, idx)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:text-primary-foreground hover:bg-primary transition-smooth px-2 py-0.5 rounded-md border border-primary/30"
                    >
                      <LinkIcon className="h-3 w-3" />
                      Send Payment Details
                    </button>
                  </div>
                )}
                {m.role === "assistant" && m.bankTransferMessage && (
                  <div className="mt-2 w-full bg-card border border-success/30 rounded-xl p-3 shadow-sm animate-slide-up">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-success" />
                      <span className="text-[11px] font-semibold text-success uppercase tracking-wide">
                        Bank Transfer Details
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground whitespace-pre-wrap mb-2">{m.bankTransferMessage}</p>
                    <button
                      onClick={() => copyLink(m.id, m.bankTransferMessage!)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:opacity-80 transition-smooth"
                    >
                      {copiedLinkId === m.id ? (
                        <><Check className="h-3 w-3" /> Copied</>
                      ) : (
                        <><Copy className="h-3 w-3" /> Copy message</>
                      )}
                    </button>
                  </div>
                )}
                {m.role === "assistant" && m.paymentLink && (
                  <div className="mt-2 w-full bg-card border border-success/30 rounded-xl p-2.5 shadow-sm animate-slide-up">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-success" />
                      <span className="text-[11px] font-semibold text-success uppercase tracking-wide">
                        Paystack Link
                      </span>
                    </div>
                    <div className="flex gap-1.5 items-stretch">
                      <input
                        readOnly
                        value={m.paymentLink}
                        onFocus={(e) => e.currentTarget.select()}
                        className="flex-1 min-w-0 text-[11px] bg-muted rounded-md px-2 py-1.5 font-mono text-foreground/80 outline-none"
                      />
                      <button
                        onClick={() => copyLink(m.id, m.paymentLink!)}
                        className="shrink-0 px-2.5 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:opacity-90 transition-smooth flex items-center gap-1"
                      >
                        {copiedLinkId === m.id ? (
                          <>
                            <Check className="h-3 w-3" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" /> Copy
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start animate-fade-in">
              <div className="bg-card rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
                <div className="flex gap-1">
                  <span
                    className="h-2 w-2 bg-muted-foreground/50 rounded-full animate-bounce"
                    style={{ animationDelay: "0ms" }}
                  />
                  <span
                    className="h-2 w-2 bg-muted-foreground/50 rounded-full animate-bounce"
                    style={{ animationDelay: "150ms" }}
                  />
                  <span
                    className="h-2 w-2 bg-muted-foreground/50 rounded-full animate-bounce"
                    style={{ animationDelay: "300ms" }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="bg-card border-t border-border/60 p-3 sticky bottom-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="mx-auto max-w-2xl flex gap-2 items-center"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a customer message..."
            className="rounded-full bg-muted border-0 focus-visible:ring-1 focus-visible:ring-primary h-11 px-4"
            disabled={loading}
          />
          <Button
            type="submit"
            size="icon"
            className="h-11 w-11 rounded-full bg-gradient-primary shadow-glow shrink-0"
            disabled={!input.trim() || loading}
          >
            <Send className="h-5 w-5" />
          </Button>
        </form>
      </div>
    </div>
  );
}
