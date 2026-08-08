import { createFileRoute, Link } from "@tanstack/react-router";
import {
  MessageCircle,
  Sparkles,
  ShoppingBag,
  Wallet,
  Clock,
  ShieldCheck,
  ArrowRight,
  CheckCircle,
  Zap,
  Star,
  TrendingUp,
  Users,
  Bot,
  Building2,
  UtensilsCrossed,
  Stethoscope,
  Shirt,
  Package,
  ChevronRight,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Wabizz — Your Business Never Sleeps" },
      { name: "description", content: "AI-powered WhatsApp assistant for Nigerian businesses." },
    ],
  }),
  component: Landing,
});

const features = [
  {
    icon: MessageCircle,
    title: "Replies in seconds",
    desc: "Your AI answers WhatsApp messages 24/7 — even at 2am when you're asleep.",
    color: "#16a34a",
  },
  {
    icon: ShoppingBag,
    title: "Takes orders for you",
    desc: "Captures customer details, sizes, quantities and colours through natural chat.",
    color: "#2563eb",
  },
  {
    icon: Wallet,
    title: "Collects payments",
    desc: "Generates Paystack links instantly so customers pay on the spot. No follow-up.",
    color: "#7c3aed",
  },
  {
    icon: Clock,
    title: "Never misses a sale",
    desc: "While you sleep, eat, or hustle — Wabizz is qualifying leads and closing deals.",
    color: "#ea580c",
  },
  {
    icon: TrendingUp,
    title: "Tracks everything",
    desc: "See every conversation, order, and revenue figure in one clean dashboard.",
    color: "#db2777",
  },
  {
    icon: Users,
    title: "Manages your contacts",
    desc: "Auto-saves customer profiles so you can run campaigns and re-engage buyers.",
    color: "#0891b2",
  },
];

const niches = [
  { icon: Shirt, label: "Fashion & Clothing", active: true },
  { icon: UtensilsCrossed, label: "Food & Restaurants", active: true },
  { icon: Stethoscope, label: "Clinics & Hospitals", active: true },
  { icon: Package, label: "E-commerce", active: false },
  { icon: Building2, label: "Real Estate", active: false },
];

const stats = [
  { value: "2 mins", label: "Average setup time" },
  { value: "24 / 7", label: "Always responding" },
  { value: "₦0", label: "Cost per reply" },
  { value: "100%", label: "WhatsApp-native" },
];

const testimonials = [
  {
    quote: "My customers can't tell it's a bot. Sales went up 40% in the first month.",
    name: "Chioma A.",
    role: "Fashion vendor, Yaba Market",
    avatar: "C",
    color: "#16a34a",
  },
  {
    quote: "I used to miss orders while sleeping. Now Wabizz handles everything overnight.",
    name: "Emeka O.",
    role: "Food delivery, Port Harcourt",
    avatar: "E",
    color: "#2563eb",
  },
  {
    quote: "Setup took 3 minutes. The AI knew my business from day one.",
    name: "Amaka N.",
    role: "Skincare brand, Abuja",
    avatar: "A",
    color: "#7c3aed",
  },
];

const chatMessages = [
  { from: "customer", text: "Hi, do you still have the red ankara gown in size 14?" },
  {
    from: "bot",
    text: "Hi dear! 👋 Yes, the Red Ankara Maxi is available in size 14. It's ₦18,500. Want me to reserve yours?",
  },
  { from: "customer", text: "Yes please! Can I pay online?" },
  {
    from: "bot",
    text: "Of course! Here's your payment link:\n💳 pay.paystack.com/wabizz-red-14\n\nValid for 24hrs. Reply once paid and I'll confirm right away! 🛍️",
  },
  { from: "customer", text: "Done! Just paid now." },
  {
    from: "bot",
    text: "✅ Payment confirmed! Your order is locked.\n\n📦 Order #WBZ-2094\n👗 Red Ankara Maxi — Size 14\n📍 Delivery in 2–3 days\n\nWe'll send tracking soon. Thank you! 🙏",
  },
  { from: "customer", text: "Wow, that was fast! 😊" },
  { from: "bot", text: "Happy to help! Message anytime — we're always here. 🌿" },
];

const steps = [
  {
    n: "01",
    title: "Create your account",
    desc: "Sign up in under 2 minutes. No technical knowledge needed.",
  },
  {
    n: "02",
    title: "Train your AI",
    desc: "Paste your product list, pricing, and FAQs. The AI learns instantly.",
  },
  {
    n: "03",
    title: "Connect WhatsApp",
    desc: "Link your number and go live. Your AI starts responding immediately.",
  },
];

function Landing() {
  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        background: "#f0f7f1",
        minHeight: "100vh",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&display=swap');

        .wbz-bg {
          background: #f0f7f1;
          background-image:
            radial-gradient(ellipse 80% 60% at 5% 0%, rgba(34,197,94,0.14) 0%, transparent 60%),
            radial-gradient(ellipse 60% 50% at 95% 15%, rgba(16,185,129,0.09) 0%, transparent 60%),
            radial-gradient(ellipse 50% 40% at 50% 100%, rgba(20,184,166,0.07) 0%, transparent 70%);
        }
        .wbz-nav {
          position: sticky; top: 0; z-index: 50;
          backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          background: rgba(240,247,241,0.88);
          border-bottom: 1px solid rgba(34,197,94,0.12);
        }
        .wbz-inner { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
        .wbz-gtxt {
          background: linear-gradient(135deg, #16a34a 0%, #059669 45%, #0d9488 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .wbz-badge {
          display: inline-flex; align-items: center; gap: 6px;
          background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.28);
          color: #15803d; padding: 5px 14px; border-radius: 100px;
          font-size: 12.5px; font-weight: 600; font-family: 'Outfit',sans-serif;
          letter-spacing: 0.01em;
        }
        .wbz-section-label {
          display: inline-flex; align-items: center; gap: 5px;
          background: rgba(22,163,74,0.1); color: #15803d;
          padding: 4px 12px; border-radius: 100px;
          font-size: 11px; font-weight: 700; letter-spacing: 0.09em;
          text-transform: uppercase; margin-bottom: 14px;
          font-family: 'Outfit', sans-serif;
        }
        .wbz-btn-p {
          display: inline-flex; align-items: center; gap: 8px;
          background: linear-gradient(135deg, #16a34a, #059669);
          color: white; font-family: 'Outfit',sans-serif; font-weight: 700;
          font-size: 15px; padding: 14px 28px; border-radius: 14px; border: none;
          cursor: pointer; text-decoration: none;
          transition: all 0.22s cubic-bezier(0.34,1.56,0.64,1);
          box-shadow: 0 8px 24px rgba(22,163,74,0.35), 0 2px 6px rgba(22,163,74,0.2);
          letter-spacing: -0.01em;
        }
        .wbz-btn-p:hover { transform: translateY(-2px) scale(1.02); box-shadow: 0 14px 36px rgba(22,163,74,0.45); }
        .wbz-btn-o {
          display: inline-flex; align-items: center; gap: 8px;
          background: white; color: #1a3d27; font-family: 'Outfit',sans-serif; font-weight: 600;
          font-size: 15px; padding: 14px 28px; border-radius: 14px;
          border: 1.5px solid #d1e7d8; cursor: pointer; text-decoration: none;
          transition: all 0.2s ease; box-shadow: 0 2px 8px rgba(0,0,0,0.04);
        }
        .wbz-btn-o:hover { border-color: #16a34a; background: #f0fdf4; transform: translateY(-1px); }

        /* Phone */
        .wbz-phone {
          width: 270px; background: white; border-radius: 38px;
          border: 9px solid #1a1a1a;
          box-shadow: 0 50px 100px rgba(0,0,0,0.28), 0 20px 40px rgba(0,0,0,0.15),
                      inset 0 0 0 1px rgba(255,255,255,0.08);
          overflow: hidden; flex-shrink: 0;
        }
        .wbz-notch {
          background: #1a1a1a; height: 28px;
          display: flex; align-items: center; justify-content: center;
        }
        .wbz-notch::after {
          content: ''; width: 70px; height: 7px; background: #2a2a2a; border-radius: 100px;
        }
        .wbz-wa-header {
          background: linear-gradient(135deg, #075e54, #128c7e);
          padding: 11px 13px; display: flex; align-items: center; gap: 9px;
        }
        .wbz-wa-av {
          width: 36px; height: 36px; border-radius: 50%;
          background: linear-gradient(135deg, #25d366, #128c7e);
          display: flex; align-items: center; justify-content: center;
          font-size: 14px; font-weight: 900; color: white; font-family: 'Outfit',sans-serif;
          flex-shrink: 0;
        }
        .wbz-chat-body {
          background: #e5ddd5; padding: 10px 8px;
          display: flex; flex-direction: column; gap: 5px;
          height: 490px; overflow: hidden;
        }
        .wbz-bc {
          align-self: flex-start; background: white; color: #1a1a1a;
          padding: 7px 10px; border-radius: 11px 11px 11px 2px;
          font-size: 12px; max-width: 84%; line-height: 1.45;
          box-shadow: 0 1px 2px rgba(0,0,0,0.1); font-family: 'DM Sans', sans-serif;
          animation: wbz-pop 0.3s ease both;
        }
        .wbz-bb {
          align-self: flex-end; background: #dcf8c6; color: #1a1a1a;
          padding: 7px 10px; border-radius: 11px 11px 2px 11px;
          font-size: 12px; max-width: 90%; line-height: 1.45; white-space: pre-line;
          box-shadow: 0 1px 2px rgba(0,0,0,0.1); font-family: 'DM Sans', sans-serif;
          animation: wbz-pop 0.3s ease both;
        }
        .wbz-btime {
          font-size: 9.5px; color: #7a8e7e; text-align: right; margin-top: 2px;
        }
        @keyframes wbz-pop {
          from { opacity: 0; transform: translateY(7px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .wbz-typing span {
          display: inline-block; width: 6px; height: 6px; background: #90a4a0;
          border-radius: 50%; animation: wbz-td 1.2s infinite;
        }
        .wbz-typing span:nth-child(2) { animation-delay: 0.2s; }
        .wbz-typing span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes wbz-td {
          0%,60%,100% { transform: translateY(0); opacity: 0.5; }
          30%          { transform: translateY(-4px); opacity: 1; }
        }
        @keyframes wbz-float {
          0%,100% { transform: translateY(0); }
          50%      { transform: translateY(-12px); }
        }
        .wbz-float { animation: wbz-float 4s ease-in-out infinite; }
        @keyframes wbz-fu {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .wbz-fu   { animation: wbz-fu 0.6s ease both; }
        .wbz-d1   { animation-delay: 0.1s; }
        .wbz-d2   { animation-delay: 0.2s; }
        .wbz-d3   { animation-delay: 0.3s; }
        .wbz-d4   { animation-delay: 0.4s; }

        .wbz-feat {
          background: white; border: 1px solid #e4ede6; border-radius: 20px;
          padding: 24px; transition: all 0.25s ease;
          box-shadow: 0 2px 8px rgba(0,0,0,0.04);
        }
        .wbz-feat:hover {
          transform: translateY(-5px);
          box-shadow: 0 18px 44px rgba(22,163,74,0.13), 0 4px 12px rgba(0,0,0,0.06);
          border-color: #bbf7d0;
        }
        .wbz-testi {
          background: white; border: 1px solid #e4ede6; border-radius: 20px;
          padding: 24px; transition: transform 0.2s, box-shadow 0.2s;
          box-shadow: 0 2px 8px rgba(0,0,0,0.04);
        }
        .wbz-testi:hover { transform: translateY(-3px); box-shadow: 0 14px 36px rgba(22,163,74,0.1); }
        .wbz-stat {
          background: white; border: 1px solid #e4ede6; border-radius: 18px;
          padding: 22px 16px; text-align: center;
          box-shadow: 0 2px 6px rgba(0,0,0,0.04);
        }
        .wbz-cta {
          background: linear-gradient(135deg, #0f2d1a 0%, #166534 50%, #065f46 100%);
          border-radius: 28px; overflow: hidden; position: relative;
        }
        .wbz-cta::before {
          content: ''; position: absolute; inset: 0;
          background-image: radial-gradient(circle at 20% 50%, rgba(74,222,128,0.08) 0%, transparent 60%),
                            radial-gradient(circle at 80% 20%, rgba(52,211,153,0.06) 0%, transparent 50%);
        }
        .wbz-niche-tag {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 8px 16px; border-radius: 100px; font-size: 13px; font-weight: 500;
          border: 1.5px solid; transition: all 0.2s; font-family: 'DM Sans', sans-serif;
        }
        .wbz-step {
          text-align: center;
        }
        .wbz-step-num {
          width: 52px; height: 52px; border-radius: 16px;
          background: linear-gradient(135deg, #16a34a, #059669);
          color: white; font-family: 'Outfit',sans-serif; font-weight: 900; font-size: 22px;
          display: flex; align-items: center; justify-content: center;
          margin: 0 auto 16px;
          box-shadow: 0 8px 24px rgba(22,163,74,0.3);
        }
        .wbz-orb {
          position: absolute; border-radius: 50%;
          filter: blur(80px); pointer-events: none;
        }

        /* ── Mobile responsiveness ──────────────────────────────────────── */
        @media (max-width: 480px) {
          .wbz-inner { padding: 0 16px; }
          .wbz-nav-links { gap: 12px !important; }
          .wbz-nav-cta { padding: 9px 14px !important; font-size: 12.5px !important; }
          .wbz-phone { width: 230px; }
          .wbz-chat-body { height: 400px; }
        }
        @media (max-width: 360px) {
          .wbz-nav-wordmark { display: none; }
          .wbz-nav-pricing { display: none; }
        }
        /* Prevent any fixed-width decorative element from forcing horizontal scroll */
        .wbz-bg { overflow-x: hidden; }
      `}</style>

      <div className="wbz-bg" style={{ minHeight: "100vh" }}>
        {/* NAV */}
        <nav className="wbz-nav">
          <div
            className="wbz-inner"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "14px 24px",
            }}
          >
            <Link
              to="/"
              style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  background: "linear-gradient(135deg,#16a34a,#059669)",
                  borderRadius: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 4px 12px rgba(22,163,74,0.3)",
                }}
              >
                <span
                  style={{
                    color: "white",
                    fontFamily: "'Outfit',sans-serif",
                    fontWeight: 900,
                    fontSize: 17,
                  }}
                >
                  W
                </span>
              </div>
              <span
                className="wbz-nav-wordmark"
                style={{
                  fontFamily: "'Outfit',sans-serif",
                  fontWeight: 800,
                  fontSize: 18,
                  color: "#1a3d27",
                  letterSpacing: "-0.02em",
                }}
              >
                Wabizz
              </span>
            </Link>
            <div className="wbz-nav-links" style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <Link
                to="/pricing"
                className="wbz-nav-pricing"
                style={{
                  textDecoration: "none",
                  color: "#4a6741",
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: "'DM Sans',sans-serif",
                }}
              >
                Pricing
              </Link>
              <Link
                to="/auth"
                className="wbz-btn-p wbz-nav-cta"
                style={{ padding: "10px 20px", fontSize: 13, borderRadius: 10 }}
              >
                Get Started <ArrowRight size={15} />
              </Link>
            </div>
          </div>
        </nav>

        {/* HERO */}
        <section
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: "68px 24px 80px",
            display: "flex",
            alignItems: "center",
            gap: 56,
            flexWrap: "wrap",
            justifyContent: "center",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            className="wbz-orb"
            style={{
              width: 500,
              height: 500,
              background: "rgba(34,197,94,0.09)",
              top: -150,
              left: -150,
            }}
          />
          <div
            className="wbz-orb"
            style={{
              width: 350,
              height: 350,
              background: "rgba(16,185,129,0.07)",
              bottom: -100,
              right: -100,
            }}
          />

          {/* Copy */}
          <div style={{ flex: "1 1 400px", maxWidth: 540, position: "relative" }}>
            <div className="wbz-fu">
              <div className="wbz-badge">
                <Sparkles size={12} /> Built for Nigerian businesses
              </div>
            </div>

            <h1
              className="wbz-fu wbz-d1"
              style={{
                fontFamily: "'Outfit',sans-serif",
                fontWeight: 900,
                fontSize: "clamp(36px,5.2vw,60px)",
                lineHeight: 1.06,
                letterSpacing: "-0.03em",
                color: "#0f2d1a",
                marginTop: 18,
                marginBottom: 0,
              }}
            >
              Your Business
              <br />
              Never Sleeps
              <br />
              <span className="wbz-gtxt">With Wabizz</span>
            </h1>

            <p
              className="wbz-fu wbz-d2"
              style={{
                fontFamily: "'DM Sans',sans-serif",
                fontSize: 17,
                color: "#3d5c3f",
                lineHeight: 1.65,
                marginTop: 20,
                maxWidth: 450,
              }}
            >
              AI-powered WhatsApp assistant for Nigerian businesses. Handles customers, takes
              orders, collects payments —{" "}
              <strong style={{ color: "#15803d", fontWeight: 600 }}>automatically, 24/7</strong>.
            </p>

            <div
              className="wbz-fu wbz-d3"
              style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 30 }}
            >
              <Link to="/onboarding" className="wbz-btn-p">
                Start Free Trial <ArrowRight size={18} />
              </Link>
              <Link to="/pricing" className="wbz-btn-o">
                See pricing
              </Link>
            </div>

            <div
              className="wbz-fu wbz-d4"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 14,
                color: "#4a7a50",
                fontSize: 13,
              }}
            >
              <ShieldCheck size={14} color="#16a34a" />
              <span style={{ fontFamily: "'DM Sans',sans-serif" }}>
                No card needed · Setup in under 2 minutes
              </span>
            </div>

            {/* Social proof */}
            <div
              className="wbz-fu wbz-d4"
              style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 28 }}
            >
              <div style={{ display: "flex" }}>
                {["#16a34a", "#2563eb", "#7c3aed", "#dc2626", "#d97706"].map((c, i) => (
                  <div
                    key={i}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      background: c,
                      border: "2.5px solid white",
                      marginLeft: i > 0 ? -10 : 0,
                      boxShadow: "0 2px 5px rgba(0,0,0,0.14)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "white",
                      fontFamily: "'Outfit',sans-serif",
                      fontWeight: 800,
                      fontSize: 11,
                    }}
                  >
                    {["C", "E", "A", "B", "O"][i]}
                  </div>
                ))}
              </div>
              <div>
                <div style={{ display: "flex", gap: 2 }}>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Star key={i} size={11} fill="#f59e0b" color="#f59e0b" />
                  ))}
                </div>
                <p
                  style={{
                    fontFamily: "'DM Sans',sans-serif",
                    fontSize: 12,
                    color: "#4a6741",
                    marginTop: 2,
                  }}
                >
                  Trusted by 500+ Nigerian businesses
                </p>
              </div>
            </div>
          </div>

          {/* Phone */}
          <div className="wbz-float wbz-fu wbz-d2" style={{ position: "relative", flexShrink: 0 }}>
            <div className="wbz-phone">
              <div className="wbz-notch" />
              <div className="wbz-wa-header">
                <div className="wbz-wa-av">W</div>
                <div>
                  <p
                    style={{
                      color: "white",
                      fontSize: 13,
                      fontWeight: 700,
                      fontFamily: "'Outfit',sans-serif",
                      marginBottom: 2,
                    }}
                  >
                    Wabizz AI
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <div
                      style={{ width: 6, height: 6, borderRadius: "50%", background: "#25d366" }}
                    />
                    <p style={{ color: "rgba(255,255,255,0.72)", fontSize: 10.5 }}>online</p>
                  </div>
                </div>
              </div>

              <div className="wbz-chat-body">
                {chatMessages.map((msg, i) => (
                  <div
                    key={i}
                    className={msg.from === "customer" ? "wbz-bc" : "wbz-bb"}
                    style={{ animationDelay: `${i * 0.11}s` }}
                  >
                    {msg.text}
                    <div className="wbz-btime">
                      {`${8 + i}:${String(30 + i * 2).padStart(2, "0")} AM`} ✓✓
                    </div>
                  </div>
                ))}
                {/* typing */}
                <div style={{ alignSelf: "flex-end" }}>
                  <div
                    style={{
                      background: "#dcf8c6",
                      padding: "7px 11px",
                      borderRadius: "11px 11px 2px 11px",
                      display: "inline-flex",
                      gap: 3,
                      alignItems: "center",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.09)",
                    }}
                    className="wbz-typing"
                  >
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            </div>

            {/* Float badges */}
            <div
              style={{
                position: "absolute",
                top: 64,
                right: -34,
                background: "white",
                border: "1.5px solid #bbf7d0",
                borderRadius: 14,
                padding: "10px 13px",
                boxShadow: "0 8px 24px rgba(22,163,74,0.16)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  background: "linear-gradient(135deg,#16a34a,#059669)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Zap size={15} color="white" fill="white" />
              </div>
              <div>
                <p
                  style={{
                    fontFamily: "'Outfit',sans-serif",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#0f2d1a",
                  }}
                >
                  Order confirmed
                </p>
                <p
                  style={{
                    fontFamily: "'DM Sans',sans-serif",
                    fontSize: 11,
                    color: "#16a34a",
                    marginTop: 1,
                  }}
                >
                  ₦18,500 collected 💰
                </p>
              </div>
            </div>

            <div
              style={{
                position: "absolute",
                bottom: 90,
                left: -38,
                background: "white",
                border: "1.5px solid #ddd6fe",
                borderRadius: 14,
                padding: "10px 13px",
                boxShadow: "0 8px 24px rgba(124,58,237,0.12)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  background: "linear-gradient(135deg,#7c3aed,#6d28d9)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Bot size={15} color="white" />
              </div>
              <div>
                <p
                  style={{
                    fontFamily: "'Outfit',sans-serif",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#1e1b4b",
                  }}
                >
                  AI Reply
                </p>
                <p
                  style={{
                    fontFamily: "'DM Sans',sans-serif",
                    fontSize: 11,
                    color: "#7c3aed",
                    marginTop: 1,
                  }}
                >
                  Sent in 0.8s ⚡
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* STATS BAR */}
        <section
          style={{
            background: "linear-gradient(135deg,#0f2d1a,#166534,#065f46)",
            padding: "38px 24px",
          }}
        >
          <div
            style={{
              maxWidth: 900,
              margin: "0 auto",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
              gap: 4,
            }}
          >
            {stats.map((s) => (
              <div key={s.label} style={{ textAlign: "center", padding: "8px 0" }}>
                <p
                  style={{
                    fontFamily: "'Outfit',sans-serif",
                    fontSize: 36,
                    fontWeight: 900,
                    color: "#4ade80",
                    letterSpacing: "-0.03em",
                  }}
                >
                  {s.value}
                </p>
                <p
                  style={{
                    fontFamily: "'DM Sans',sans-serif",
                    fontSize: 13,
                    color: "rgba(255,255,255,0.58)",
                    marginTop: 2,
                  }}
                >
                  {s.label}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* NICHES */}
        <section
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: "72px 24px 40px",
            textAlign: "center",
          }}
        >
          <div className="wbz-section-label">
            <Building2 size={11} /> Industry Solutions
          </div>
          <h2
            style={{
              fontFamily: "'Outfit',sans-serif",
              fontWeight: 800,
              fontSize: "clamp(24px,4vw,40px)",
              color: "#0f2d1a",
              letterSpacing: "-0.025em",
              marginBottom: 10,
            }}
          >
            Built for every Nigerian business
          </h2>
          <p
            style={{
              fontFamily: "'DM Sans',sans-serif",
              color: "#3d5c3f",
              fontSize: 16,
              marginBottom: 32,
            }}
          >
            Wabizz adapts to your industry — not the other way around.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
            {niches.map((n) => (
              <div
                key={n.label}
                className="wbz-niche-tag"
                style={{
                  background: n.active ? "rgba(22,163,74,0.09)" : "rgba(0,0,0,0.04)",
                  borderColor: n.active ? "rgba(22,163,74,0.32)" : "#e5e7eb",
                  color: n.active ? "#15803d" : "#9ca3af",
                }}
              >
                <n.icon size={14} /> {n.label}
                {n.active ? (
                  <CheckCircle size={12} fill="#16a34a" color="white" />
                ) : (
                  <span
                    style={{
                      fontSize: 10,
                      background: "#f3f4f6",
                      color: "#9ca3af",
                      padding: "2px 7px",
                      borderRadius: 100,
                      fontWeight: 600,
                    }}
                  >
                    Soon
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* FEATURES */}
        <section style={{ maxWidth: 1100, margin: "0 auto", padding: "36px 24px 72px" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <div className="wbz-section-label">
              <Sparkles size={11} /> Core Features
            </div>
            <h2
              style={{
                fontFamily: "'Outfit',sans-serif",
                fontWeight: 800,
                fontSize: "clamp(24px,4vw,40px)",
                color: "#0f2d1a",
                letterSpacing: "-0.025em",
              }}
            >
              Everything you need, nothing you don't
            </h2>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(290px,1fr))",
              gap: 16,
            }}
          >
            {features.map((f) => (
              <div key={f.title} className="wbz-feat">
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 14,
                    background: f.color,
                    marginBottom: 16,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <f.icon size={20} color="white" />
                </div>
                <h3
                  style={{
                    fontFamily: "'Outfit',sans-serif",
                    fontWeight: 700,
                    fontSize: 17,
                    color: "#0f2d1a",
                    marginBottom: 6,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {f.title}
                </h3>
                <p
                  style={{
                    fontFamily: "'DM Sans',sans-serif",
                    fontSize: 14,
                    color: "#4a6741",
                    lineHeight: 1.65,
                  }}
                >
                  {f.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section
          style={{
            background: "white",
            borderTop: "1px solid #e4ede6",
            borderBottom: "1px solid #e4ede6",
            padding: "72px 24px",
          }}
        >
          <div style={{ maxWidth: 800, margin: "0 auto", textAlign: "center" }}>
            <div className="wbz-section-label">
              <Zap size={11} /> How It Works
            </div>
            <h2
              style={{
                fontFamily: "'Outfit',sans-serif",
                fontWeight: 800,
                fontSize: "clamp(24px,4vw,40px)",
                color: "#0f2d1a",
                letterSpacing: "-0.025em",
                marginBottom: 48,
              }}
            >
              Up and running in 3 steps
            </h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
                gap: 28,
              }}
            >
              {steps.map((s) => (
                <div key={s.n} className="wbz-step">
                  <div className="wbz-step-num">{s.n}</div>
                  <h3
                    style={{
                      fontFamily: "'Outfit',sans-serif",
                      fontWeight: 700,
                      fontSize: 16,
                      color: "#0f2d1a",
                      marginBottom: 8,
                    }}
                  >
                    {s.title}
                  </h3>
                  <p
                    style={{
                      fontFamily: "'DM Sans',sans-serif",
                      fontSize: 14,
                      color: "#4a6741",
                      lineHeight: 1.65,
                    }}
                  >
                    {s.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* TESTIMONIALS */}
        <section style={{ maxWidth: 1100, margin: "0 auto", padding: "72px 24px" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <div className="wbz-section-label">
              <Star size={11} /> Testimonials
            </div>
            <h2
              style={{
                fontFamily: "'Outfit',sans-serif",
                fontWeight: 800,
                fontSize: "clamp(24px,4vw,40px)",
                color: "#0f2d1a",
                letterSpacing: "-0.025em",
              }}
            >
              Real businesses, real results
            </h2>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(275px,1fr))",
              gap: 20,
            }}
          >
            {testimonials.map((t) => (
              <div key={t.name} className="wbz-testi">
                <div style={{ display: "flex", gap: 2, marginBottom: 14 }}>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Star key={i} size={14} fill="#f59e0b" color="#f59e0b" />
                  ))}
                </div>
                <p
                  style={{
                    fontFamily: "'DM Sans',sans-serif",
                    fontSize: 15,
                    color: "#1a3d27",
                    lineHeight: 1.68,
                    fontStyle: "italic",
                    marginBottom: 20,
                  }}
                >
                  &ldquo;{t.quote}&rdquo;
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: "50%",
                      background: t.color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "white",
                      fontFamily: "'Outfit',sans-serif",
                      fontWeight: 800,
                      fontSize: 15,
                    }}
                  >
                    {t.avatar}
                  </div>
                  <div>
                    <p
                      style={{
                        fontFamily: "'Outfit',sans-serif",
                        fontWeight: 700,
                        fontSize: 14,
                        color: "#0f2d1a",
                      }}
                    >
                      {t.name}
                    </p>
                    <p
                      style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: "#6b8c6f" }}
                    >
                      {t.role}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* FINAL CTA */}
        <section style={{ maxWidth: 1100, margin: "0 auto", padding: "0 24px 80px" }}>
          <div className="wbz-cta" style={{ padding: "60px 40px", textAlign: "center" }}>
            <div style={{ position: "relative", zIndex: 1 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "rgba(74,222,128,0.15)",
                  border: "1px solid rgba(74,222,128,0.3)",
                  color: "#4ade80",
                  padding: "5px 14px",
                  borderRadius: 100,
                  fontFamily: "'Outfit',sans-serif",
                  fontWeight: 600,
                  fontSize: 12.5,
                  marginBottom: 20,
                }}
              >
                <Zap size={11} /> Free for first 100 conversations
              </div>
              <h2
                style={{
                  fontFamily: "'Outfit',sans-serif",
                  fontWeight: 900,
                  fontSize: "clamp(28px,4.5vw,50px)",
                  color: "white",
                  letterSpacing: "-0.03em",
                  lineHeight: 1.08,
                  marginBottom: 14,
                }}
              >
                Ready to stop missing
                <br />
                customers?
              </h2>
              <p
                style={{
                  fontFamily: "'DM Sans',sans-serif",
                  color: "rgba(255,255,255,0.68)",
                  fontSize: 16,
                  marginBottom: 36,
                }}
              >
                Activate your AI in 2 minutes. No technical skills required.
              </p>
              <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
                <Link
                  to="/onboarding"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: "white",
                    color: "#0f2d1a",
                    fontFamily: "'Outfit',sans-serif",
                    fontWeight: 800,
                    fontSize: 15,
                    padding: "14px 28px",
                    borderRadius: 14,
                    textDecoration: "none",
                    boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
                    transition: "all 0.2s",
                    letterSpacing: "-0.01em",
                  }}
                >
                  Start Free Trial <ArrowRight size={18} />
                </Link>
                <Link
                  to="/pricing"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: "transparent",
                    color: "rgba(255,255,255,0.82)",
                    fontFamily: "'Outfit',sans-serif",
                    fontWeight: 600,
                    fontSize: 15,
                    padding: "14px 28px",
                    borderRadius: 14,
                    border: "1.5px solid rgba(255,255,255,0.22)",
                    textDecoration: "none",
                    transition: "all 0.2s",
                  }}
                >
                  View pricing <ChevronRight size={16} />
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* FOOTER */}
        <footer style={{ borderTop: "1px solid #d4e8d6", padding: "24px", textAlign: "center" }}>
          <p style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: "#6b8c6f" }}>
            © 2026 Wabizz · Built with ❤️ for Nigerian businesses
          </p>
        </footer>
      </div>
    </div>
  );
}
