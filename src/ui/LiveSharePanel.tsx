import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReceiverController } from "../radio/receiverController";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { ShareHost, initialPeerStats } from "../sharing/peerSession";
import { formatJoinKey } from "../sharing/roomClient";
import "../sharing/liveSharing.css";

export function LiveSharePanel({ controller, analysis, open, onClose }: {
  controller: ReceiverController; analysis: AnalysisPipeline; open: boolean; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), keyInput = useRef<HTMLInputElement>(null);
  const host = useRef<ShareHost | undefined>(undefined);
  const [active, setActive] = useState(false), [busy, setBusy] = useState(false);
  const [key, setKey] = useState(""), [guestUrl, setGuestUrl] = useState("");
  const [message, setMessage] = useState(""), [stats, setStats] = useState(initialPeerStats);
  const [receiver, setReceiver] = useState(controller.getSnapshot);
  const activeRef = useRef(false);
  useEffect(() => controller.subscribe(setReceiver), [controller]);
  useEffect(() => () => { host.current?.close(); }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (activeRef.current) { event.preventDefault(); event.returnValue = ""; } };
    const pageHide = () => host.current?.close();
    window.addEventListener("beforeunload", beforeUnload); window.addEventListener("pagehide", pageHide);
    return () => { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("pagehide", pageHide); };
  }, []);
  useEffect(() => {
    if (open) { dialog.current?.showModal(); dialog.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
    else { dialog.current?.close(); document.getElementById("live-share-trigger")?.focus(); }
  }, [open]);
  const finish = (reason: string) => { activeRef.current = false; setActive(false); setBusy(false); setKey(""); setGuestUrl(""); setMessage(reason); };
  const start = async () => {
    if (controller.getSnapshot().lifecycle !== "running" || activeRef.current) return;
    setBusy(true); setMessage(""); setStats(initialPeerStats());
    let peer: ShareHost | undefined;
    try {
      peer = new ShareHost(controller, analysis, setStats, reason => {
        if (host.current === peer) finish(reason);
      });
      host.current = peer; activeRef.current = true; setActive(true);
      await peer.prepare();
      const joinKey = await peer.createKey();
      if (host.current !== peer || !activeRef.current) return;
      setKey(formatJoinKey(joinKey));
      const url = new URL(location.href); url.search = "?live-guest=1"; url.hash = `join=${joinKey}`; url.username = ""; url.password = "";
      setGuestUrl(url.toString());
    } catch (error) {
      if (host.current === peer) { peer?.close(); finish(error instanceof Error ? error.message : "Sharing could not start."); }
    } finally { if (host.current === peer) setBusy(false); }
  };
  const stop = () => { host.current?.close(); host.current = undefined; finish("Sharing stopped. Local reception continues."); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(key); setMessage("Session key copied."); }
    catch { keyInput.current?.select(); setMessage("Select and copy the session key."); }
  };
  return <>
    {active && !open && createPortal(<button className="live-share-indicator" type="button" onClick={() => document.getElementById("live-share-trigger")?.click()}>Sharing live · {stats.status}</button>, document.body)}
    {createPortal(<dialog ref={dialog} className="live-share-dialog" aria-labelledby="live-share-heading" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input")).filter(element => element.getClientRects().length);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="live-share-heading"><div><p className="eyebrow">One host · one guest · local prototype</p><h2 id="live-share-heading">Share live audio &amp; spectrum</h2></div>
        <button className="secondary" type="button" aria-label="Close live sharing panel" onClick={onClose}>Close</button></div>
      <p>Your guest follows the selected channel. Only receiver audio and RF spectrum are shared. You keep control.</p>
      {!active ? <><button type="button" disabled={receiver.lifecycle !== "running" || busy || typeof RTCPeerConnection !== "function"} onClick={() => void start()}>Start sharing</button>
        {receiver.lifecycle !== "running" && <p>Start a local receiver or I/Q replay first. The synthetic source supplies spectrum only.</p>}</> : <>
        {key ? <><label>Session key<input className="live-share-key" ref={keyInput} aria-label="Host session key" readOnly value={key} onFocus={event => event.currentTarget.select()} /></label>
          <div className="live-share-actions"><button type="button" onClick={() => void copy()}>Copy session key</button><a className="live-share-link" href={guestUrl} target="_blank" rel="noopener noreferrer">Open guest preview ↗</a></div>
          <p className="display-note">Give this key to your guest. It is valid for one join within 10 minutes. Both sides must open this local preview; no connection settings need copying.</p></> : <p role="status">Preparing session key…</p>}
        <div className="live-share-actions"><p role="status" className="live-share-status">{stats.status}</p><button type="button" className="secondary" onClick={stop}>Stop sharing</button></div>
        <dl className="live-share-stats"><div><dt>Spectrum rows sent</dt><dd data-testid="share-sent-frames">{stats.frames}</dd></div><div><dt>Spectrum rate</dt><dd>{stats.spectrumFps.toFixed(1)} rows/s</dd></div>
          <div><dt>Audio published</dt><dd>{stats.audioSeconds.toFixed(1)} s</dd></div><div><dt>Display rows skipped</dt><dd>{stats.skipped}</dd></div><div><dt>Network round trip</dt><dd>{stats.roundTripMs.toFixed(1)} ms</dd></div></dl>
        <p className="display-note">Close keeps sharing active. Stop sharing disconnects the guest and leaves your receiver running.</p>
      </>}
      <p role="status">{message}</p>
      <p className="display-note">The local service exchanges connection details only. Audio and spectrum travel directly. Internet relay and guest control are not enabled.</p>
    </dialog>, document.body)}
  </>;
}
