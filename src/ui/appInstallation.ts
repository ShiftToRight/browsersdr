export interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
export const installation: { prompt?: InstallPrompt; installed: boolean } = { installed: false };
export const INSTALLATION_CHANGED = "browsersdr-installation-changed";

// Capture browser events before the optional Settings UI is opened or loaded.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", event => {
    if (typeof (event as InstallPrompt).prompt !== "function") return;
    event.preventDefault(); installation.prompt = event as InstallPrompt;
    window.dispatchEvent(new Event(INSTALLATION_CHANGED));
  });
  window.addEventListener("appinstalled", () => {
    installation.installed = true; installation.prompt = undefined;
    window.dispatchEvent(new Event(INSTALLATION_CHANGED));
  });
}
