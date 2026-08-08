import { Download, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "@/hooks/use-pwa-install";

interface InstallAppButtonProps {
  className?: string;
  /** "full" renders label + icon (nav drawer); "icon" renders icon-only (header). */
  variant?: "full" | "icon";
}

/**
 * Shows nothing once the app is already installed/running standalone, and
 * nothing on browsers that neither fire beforeinstallprompt nor are iOS
 * Safari (there's genuinely no install action to offer there) — the button
 * only ever appears when it can actually do something.
 */
export function InstallAppButton({ className, variant = "full" }: InstallAppButtonProps) {
  const { canInstall, isStandalone, isIOS, promptInstall } = usePwaInstall();

  if (isStandalone) return null;
  if (!canInstall && !isIOS) return null;

  const handleClick = async () => {
    if (isIOS) {
      toast.info("Install Wabizz on your iPhone", {
        description: 'Tap the Share icon, then "Add to Home Screen".',
        duration: 6000,
      });
      return;
    }
    const outcome = await promptInstall();
    if (outcome === "accepted") {
      toast.success("Wabizz installed! Find it on your home screen.");
    } else if (outcome === "unavailable") {
      toast.error("Install isn't available right now. Try again in a moment.");
    }
  };

  if (variant === "icon") {
    return (
      <button
        onClick={handleClick}
        className={className ?? "h-9 w-9 rounded-full flex items-center justify-center hover:bg-muted transition-smooth"}
        aria-label="Install Wabizz app"
        title="Install Wabizz app"
      >
        <Download className="h-4 w-4 text-muted-foreground" />
      </button>
    );
  }

  return (
    <Button onClick={handleClick} variant="outline" className={className}>
      <Download className="h-4 w-4" />
      Install App
    </Button>
  );
}

/** Small "Installed" badge — optional, for settings-style pages. */
export function InstalledBadge() {
  const { isStandalone } = usePwaInstall();
  if (!isStandalone) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-success font-medium">
      <CheckCircle2 className="h-3.5 w-3.5" />
      App installed
    </span>
  );
}
