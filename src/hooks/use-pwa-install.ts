import * as React from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function isStandaloneNow(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari-specific flag — not in the standard Navigator type.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIOSNow(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !("MSStream" in window);
}

/**
 * Drives the "Install App" button. Chrome/Edge/Android fire
 * `beforeinstallprompt`, which we capture and replay on demand via
 * `promptInstall()`. iOS Safari never fires that event — there's no
 * programmatic install there, only the manual Share → "Add to Home Screen"
 * flow, so `isIOS` is exposed for the button to show instructions instead.
 */
export function usePwaInstall() {
  const deferredPrompt = React.useRef<BeforeInstallPromptEvent | null>(null);
  const [canInstall, setCanInstall] = React.useState(false);
  const [isStandalone, setIsStandalone] = React.useState(false);
  const [isIOS, setIsIOS] = React.useState(false);

  React.useEffect(() => {
    setIsStandalone(isStandaloneNow());
    setIsIOS(isIOSNow());

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredPrompt.current = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const onAppInstalled = () => {
      deferredPrompt.current = null;
      setCanInstall(false);
      setIsStandalone(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const promptInstall = React.useCallback(async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    const prompt = deferredPrompt.current;
    if (!prompt) return "unavailable";
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    deferredPrompt.current = null;
    setCanInstall(false);
    return outcome;
  }, []);

  return { canInstall, isStandalone, isIOS, promptInstall };
}
