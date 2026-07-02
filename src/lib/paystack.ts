export type PaystackKeys = {
  publicKey: string;
  secretKey: string;
};

const KEY = "wabizz_paystack_keys";

export function getPaystackKeys(): PaystackKeys | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PaystackKeys;
    if (!parsed.publicKey || !parsed.secretKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePaystackKeys(keys: PaystackKeys) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(keys));
}

export function clearPaystackKeys() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
}

/**
 * Extract the largest naira amount mentioned in a conversation/text.
 * Looks for ₦12,000 / NGN 12000 / N12000 / "12,000 naira" patterns.
 */
export function extractAmount(text: string): number | null {
  const matches = [
    ...text.matchAll(/(?:₦|NGN\s*|N(?=\d))\s*([\d,]+(?:\.\d+)?)/gi),
    ...text.matchAll(/([\d,]+(?:\.\d+)?)\s*(?:naira|NGN)/gi),
  ];
  const values = matches
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => !isNaN(n) && n > 0);
  if (!values.length) return null;
  return Math.max(...values);
}

/**
 * Build a shareable Paystack-style payment link.
 * Without a backend transaction init, we use a deterministic reference
 * and the public key so it can be opened/handled client-side or shared.
 */
export function buildPaymentLink(opts: {
  publicKey: string;
  amountNaira: number;
  businessName: string;
}): string {
  const ref = `wabizz_${Date.now().toString(36)}`;
  const params = new URLSearchParams({
    key: opts.publicKey,
    amount: String(Math.round(opts.amountNaira * 100)), // kobo
    currency: "NGN",
    ref,
    business: opts.businessName,
  });
  return `https://paystack.com/pay/wabizz?${params.toString()}`;
}

/**
 * Returns true if the stored public key represents a bank transfer setup
 * rather than a Paystack integration.
 * Bank transfer keys are stored as "BANK:bankName|accountNumber|accountName".
 */
export function isBankTransfer(publicKey: string): boolean {
  return publicKey.startsWith("BANK:");
}

/**
 * Parse bank transfer details from the encoded public key.
 */
export function parseBankTransferKey(publicKey: string): {
  bankName: string;
  accountNumber: string;
  accountName: string;
} | null {
  if (!isBankTransfer(publicKey)) return null;
  const parts = publicKey.replace("BANK:", "").split("|");
  if (parts.length < 2) return null;
  return {
    bankName: parts[0] ?? "",
    accountNumber: parts[1] ?? "",
    accountName: parts[2] ?? "",
  };
}

/**
 * Build a bank transfer payment message for WhatsApp.
 * Used when the business has set up bank transfer instead of Paystack.
 */
export function buildBankTransferMessage(opts: {
  publicKey: string;
  amountNaira: number;
  businessName: string;
}): string {
  const bank = parseBankTransferKey(opts.publicKey);
  if (!bank) return "Please contact us for payment details.";
  return (
    `💳 *Payment details for your order (₦${opts.amountNaira.toLocaleString()}):*\n\n` +
    `🏦 Bank: *${bank.bankName}*\n` +
    `💰 Account Number: *${bank.accountNumber}*\n` +
    `👤 Account Name: *${bank.accountName}*\n\n` +
    `Please make the transfer and reply *PAID* once done. Thank you! 🙏`
  );
}
