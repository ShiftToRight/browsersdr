import { useEffect, useRef, useState } from "react";
import { AtlasClient } from "../radio/atlasClient";
import { readAtlasReceipts, type AtlasRecoveryReceipt } from "../radio/atlasRecovery";
import { AtlasTransferController, type AtlasTransferSnapshot } from "../radio/atlasTransfer";
import { atlasWebPageUrl } from "../radio/atlasWebNavigation";
import { readUserToken } from "./AtlasSavePanel";

export function AtlasRecoveryPanel({transferActive=false}:{transferActive?:boolean}) {
  const [receipts, setReceipts] = useState(() => readAtlasReceipts().filter(value => !value.result));
  const [token, setToken] = useState(readUserToken);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AtlasTransferSnapshot>();
  const [message, setMessage] = useState("");
  const controller = useRef<AtlasTransferController | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current=true;
    const refresh=() => { setReceipts(readAtlasReceipts().filter(value => !value.result)); setToken(current => current || readUserToken()); };
    window.addEventListener("browsersdr-atlas-recovery",refresh);
    return () => { mounted.current=false; window.removeEventListener("browsersdr-atlas-recovery",refresh); controller.current?.pause(); };
  }, []);
  const resume = async (receipt: AtlasRecoveryReceipt) => {
    setBusy(true); setMessage("");
    const transfer = new AtlasTransferController(undefined,{client:new AtlasClient(),receipt});
    controller.current=transfer;
    const unsubscribe=transfer.subscribe(value => { if (mounted.current) setStatus(value); });
    try { await transfer.start({...receipt.request,userToken:token}); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { unsubscribe(); if (mounted.current) setBusy(false); }
  };
  if (!receipts.length && !status) return null;
  return <details className="atlas-save-panel" open><summary>Recover SigIntAtlas transfers</summary>
    <p>Receipts survive navigation and browser restart on this BrowserSDR origin. Closed uploads can finish verification and recording creation without the local files. Missing parts require preparing the exact original SigMF pair.</p>
    <label>Recovery user token<input aria-label="Recovery user token" type="password" autoComplete="off" value={token} disabled={busy} onChange={event=>setToken(event.currentTarget.value)} /></label>
    {receipts.map(receipt=><div key={receipt.pairId}><strong>{receipt.request.title}</strong> · {new Date(receipt.startedAt).toLocaleString()}<button type="button" disabled={busy || transferActive || token.length<32} onClick={()=>void resume(receipt)}>Continue verification for {receipt.request.title}</button></div>)}
    {status && <p aria-live="polite">{status.state === "saved" ? "Recording saved and verified." : status.state === "waiting" ? "Server verification pending; receipt retained." : `Recovery: ${status.state}`}{status.verificationStage ? ` · Verification ${status.verificationStage}` : ""}{status.waitSeconds != null ? ` · ${status.waitSeconds}s wait` : ""}</p>}
    {status?.recordingUrl && <a href={atlasWebPageUrl(status.recordingUrl)} target="_blank" rel="noreferrer">Open recovered recording</a>}
    {message && <p role="alert">{message}</p>}
    {busy && <button type="button" onClick={()=>controller.current?.pause()}>Pause monitoring</button>}
  </details>;
}
