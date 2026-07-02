export type Tone = "Professional" | "Friendly" | "Pidgin";

export type BusinessProfile = {
  businessName: string;
  businessType: string;
  email: string;
  whatsapp: string;
  openTime: string;
  closeTime: string;
  productsList: string;
  tone: Tone;
  customMessage?: string;
};

const KEY = "wabizz_business_profile";

const DEFAULT_PROFILE: BusinessProfile = {
  businessName: "Mama Nkechi Fashion",
  businessType: "Fashion",
  email: "owner@example.com",
  whatsapp: "+234 801 234 5678",
  openTime: "09:00",
  closeTime: "20:00",
  productsList: "Ankara gown – ₦15,000\nSenator wear – ₦25,000\nAso-ebi – ₦12,000",
  tone: "Friendly",
  customMessage: "",
};

export function getProfile(): BusinessProfile {
  if (typeof window === "undefined") return DEFAULT_PROFILE;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PROFILE;
    return { ...DEFAULT_PROFILE, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function saveProfile(profile: Partial<BusinessProfile>) {
  if (typeof window === "undefined") return;
  const merged = { ...getProfile(), ...profile };
  localStorage.setItem(KEY, JSON.stringify(merged));
}
