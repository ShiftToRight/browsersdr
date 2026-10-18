import { useEffect, useRef, useState } from "react";
import { ShareGuest, initialPeerStats } from "../sharing/peerSession";
import type { SharedState } from "../sharing/protocol";
import { validJoinKey, formatJoinKey } from "../sharing/roomClient";
import { GuestFrames, GuestSpectrum } from "../sharing/GuestSpectrum";
import "../sharing/liveSharing.css";

export default function LiveGuest() {
  const [sessionKey, setSessionKey] = useState(() => formatJoinKey(new URLSearchParams(location.hash.slice(1)).get("join") ?? ""));
  const guest = useRef<ShareGuest | undefined>(undefined);
  const audio = useRef<HTMLAudioElement>(null);
  const [frames] = useState(() => new GuestFrames());
  const [state, setState] = useState<SharedState>();
  const [stats, setStats] = useState(initialPeerStats);
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState("");
  const [hasAudio, setHasAudio] = useState(false);
  const [listening, setListening] = useState(false);
  const [volume, setVolume] = useState(.6);
  const lastFrameTime = useRef(0);
  const [stale, setStale] = useState(true);
  const [busy, setBusy] = useState(false);
  const clearMedia = () => {
    audio.current?.pause(); if (audio.current) audio.current.srcObject = null;
    setHasAudio(false); setListening(false); setState(undefined); frames.emit(); setStale(true);
  };
  useEffect(() => {
    // Guest entry never mounts receiver ownership or requests USB enumeration.
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    const pageHide = () => guest.current?.close();
    window.addEventListener("pagehide", pageHide);
    const timer = setInterval(() => setStale(performance.now() - lastFrameTime.current > 2000), 500);
    return () => { clearInterval(timer); guest.current?.close(); window.removeEventListener("pagehide", pageHide); };
  }, []);
  const connect = async () => {
    if (active || busy) return;
    setBusy(true); setMessage(""); setStats(initialPeerStats()); clearMedia();
    const peer = new ShareGuest("", setStats, reason => { setActive(false); setBusy(false); clearMedia(); setMessage(reason); },
      setState, frame => { frames.emit(frame); if (frame) { lastFrameTime.current = performance.now(); setStale(false); } },
      stream => { if (audio.current) audio.current.srcObject = stream; setHasAudio(true); }, () => {});
    guest.current = peer; setActive(true);
    try { await peer.joinKey(sessionKey); }
    catch (error) { peer.close(); if (guest.current === peer) { setActive(false); setMessage(error instanceof Error ? error.message : "Could not connect."); } }
    finally { if (guest.current === peer) setBusy(false); }
  };
  const leave = () => { guest.current?.close(); guest.current = undefined; setActive(false); setBusy(false); clearMedia(); setMessage("Disconnected. Ask the host for a new session key before joining again."); };
  const listen = async () => {
    try { if (!audio.current) return; audio.current.muted = false; audio.current.volume = volume; await audio.current.play(); setListening(true); setMessage(""); }
    catch { setMessage("Playback was blocked. Press Listen again."); }
  };
  return <main className="live-guest">
    <header className="live-share-heading"><div><p className="eyebrow">BrowserSDR · guest preview</p><h1>Listen along</h1><p>One shared channel. Your host keeps control.</p></div><span className="live-share-tag">{stats.serviceMode === "local" ? "Local preview" : "Private session"}</span></header>
    <section className="live-guest-card" aria-label="Guest connection">
      <form onSubmit={event => { event.preventDefault(); void connect(); }}>
        <label>Session key<input className="live-share-key" aria-label="Session key" autoComplete="off" spellCheck={false} maxLength={20} value={sessionKey} readOnly={active} onChange={event => setSessionKey(event.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX" /></label>
        <div className="live-share-actions">{!active ? <button type="submit" disabled={!validJoinKey(sessionKey) || busy || typeof RTCPeerConnection !== "function"}>Join host</button>
          : <button type="button" className="secondary" onClick={event => { event.preventDefault(); leave(); }}>Leave session</button>}
          <span role="status" className="live-share-status">{active ? stats.status : "Disconnected"}</span></div>
      </form>
      <p>Enter the key shown by the host. Connection details are exchanged automatically; you choose when to listen.</p>
      <p className="display-note">{stats.serviceMode === "local" ? "Local preview; public relay may be unavailable." : "Audio and spectrum connect directly when possible, with encrypted relay fallback."} No microphone, screen or USB access is needed.</p>
      <p role="status">{message}</p>
    </section>
    <section className="live-guest-card" aria-label="Shared receiver">
      <div className="live-share-heading"><h2>{state ? `${(state.frequencyHz / 1e6).toFixed(4)} MHz · ${state.mode}` : "Waiting for host"}</h2>
        <span>{state ? `${state.source === "replay" ? "I/Q replay" : state.source} · ${state.running ? "Receiving" : "Changing channel"}` : "No received state"}</span></div>
      <GuestSpectrum frames={frames} />
      <p className="display-note">{stale ? "Spectrum waiting or stale" : "Live RF spectrum"} · host CPU/WASM analysis · 1024 bins · up to 20 rows/s · relative power. Gaps are marked; network delivery is not RF continuity evidence.</p>
      <div className="live-share-actions"><button type="button" disabled={!hasAudio || listening} onClick={() => void listen()}>Listen</button>
        <button type="button" className="secondary" disabled={!listening} onClick={() => { audio.current?.pause(); setListening(false); }}>Mute</button>
        <label className="live-share-volume">Your volume<input type="range" aria-label="Guest volume" min="0" max="1" step=".01" value={volume} onChange={event => { const v = Number(event.target.value); setVolume(v); if (audio.current) audio.current.volume = v; }} /></label>
        <span>{listening ? "Listening" : "Audio off"}</span></div>
      <audio ref={audio} aria-label="Shared receiver audio" onPause={() => setListening(false)} />
      <dl className="live-share-stats"><div><dt>Spectrum rows received</dt><dd data-testid="share-received-frames">{stats.frames}</dd></div>
        <div><dt>Received spectrum rate</dt><dd data-testid="share-spectrum-fps">{stats.spectrumFps.toFixed(1)} rows/s</dd></div>
        <div><dt>Audio packets received</dt><dd data-testid="share-audio-packets">{stats.audioPackets}</dd></div>
        <div><dt>Audio received</dt><dd>{(stats.audioBytes / 1024).toFixed(1)} KiB</dd></div>
        <div><dt>Connection path</dt><dd data-testid="share-connection-path">{stats.connectionPath}</dd></div><div><dt>Network round trip</dt><dd>{stats.roundTripMs.toFixed(1)} ms</dd></div>
        <div><dt>Audio network jitter</dt><dd>{stats.jitterMs.toFixed(1)} ms</dd></div></dl>
      <p className="display-note">Processed host audio, not original I/Q. Local volume does not change the host. Host sleep, source changes or closing its tab interrupt this session.</p>
    </section>
  </main>;
}
