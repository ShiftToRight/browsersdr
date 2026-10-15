import { useEffect, useState } from "react";
import { installation, INSTALLATION_CHANGED } from "./appInstallation";

export function InstallAppControl() {
  const [prompt, setPrompt] = useState(installation.prompt);
  const [installed, setInstalled] = useState(() => installation.installed || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const capture = () => { setPrompt(installation.prompt); if (installation.installed) setInstalled(true); setMessage(""); };
    const display = typeof window.matchMedia === "function" ? window.matchMedia("(display-mode: standalone)") : undefined;
    const changed = () => { if (display?.matches) setInstalled(true); };
    window.addEventListener(INSTALLATION_CHANGED, capture);
    display?.addEventListener?.("change", changed);
    return () => {
      window.removeEventListener(INSTALLATION_CHANGED, capture);
      display?.removeEventListener?.("change", changed);
    };
  }, []);
  return <div className="install-app-control">
    {installed ? <p>BrowserSDR app installed</p> : prompt ? <button type="button" className="secondary" disabled={pending} onClick={async () => {
      const request = prompt; setPending(true); installation.prompt = undefined; setPrompt(undefined);
      try {
        await request.prompt();
        const choice = await request.userChoice;
        setMessage(choice.outcome === "accepted" ? "Installation requested. Open BrowserSDR from your apps when ready." : "Installation dismissed. You can keep using this browser tab.");
      } catch { setMessage("Installation could not start. Try your browser’s app menu."); }
      finally { setPending(false); }
    }}>Install BrowserSDR app</button> : <p>Install from your browser’s app menu when offered.</p>}
    <small>Launch in its own window. Internet access is needed to open the app; receiver permissions still apply.</small>
    {message && <p role="status">{message}</p>}
  </div>;
}
