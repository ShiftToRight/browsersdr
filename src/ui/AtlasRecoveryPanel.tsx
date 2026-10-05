import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getAtlasConnection, type AtlasConnection } from "../radio/atlasConnection";
import { readAtlasReceipts, type AtlasRecoveryReceipt } from "../radio/atlasRecovery";
import { AtlasTransferController, type AtlasTransferSnapshot } from "../radio/atlasTransfer";
import { atlasWebPageUrl } from "../radio/atlasWebNavigation";

export function AtlasRecoveryPanel({transferActive=false, connection=getAtlasConnection(), onOpenSettings}:{transferActive?:boolean; connection?:AtlasConnection; onOpenSettings?:()=>void}) {
  const [receipts, setReceipts] = useState(() => readAtlasReceipts().filter(value => !value.result));
  const credential = useSyncExternalStore(connection.credentials.subscribe, connection.credentials.getSnapshot);
  const connectionState = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AtlasTransferSnapshot>();
  const [message, setMessage] = useState("");
  const controller = useRef<AtlasTransferController | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current=true;
    const refresh=() => { setReceipts(readAtlasReceipts().filter(value => !value.result)); };
    window.addEventListener("browsersdr-atlas-recovery",refresh);
    return () => { mounted.current=false; window.removeEventListener("browsersdr-atlas-recovery",refresh); controller.current?.pause(); };
  }, []);
  const resume = async (receipt: AtlasRecoveryReceipt) => {
    setBusy(true); setMessage("");
    const transfer = new AtlasTransferController(undefined,{client:connection.client,connection,receipt});
    controller.current=transfer;
    const unsubscribe=transfer.subscribe(value => { if (mounted.current) setStatus(value); });
    try { await transfer.start({...receipt.request,userToken:credential.token}); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { unsubscribe(); if (mounted.current) setBusy(false); }
  };
  if (!receipts.length && !status) return null;
  return <details className="atlas-save-panel" open><summary>Recover SigIntAtlas transfers</summary>
    <p>Receipts survive navigation and browser restart on this BrowserSDR origin. Closed uploads can finish verification and recording creation without the local files. Missing parts require preparing the exact original SigMF pair.</p>
    <p>{credential.token ? "Recovery uses the token configured in Settings. Sign in with the account that started this transfer." : "Configure a SigIntAtlas user token in Settings to recover a transfer."}</p>
    {onOpenSettings && <button type="button" className="secondary" onClick={onOpenSettings}>SigIntAtlas settings</button>}
    {connectionState.user?.role === "viewer" && <p>Viewer access cannot recover recording writes.</p>}
    {receipts.map(receipt=><div key={receipt.pairId}><strong>{receipt.request.title}</strong> · {new Date(receipt.startedAt).toLocaleString()}<button type="button" disabled={busy || transferActive || connectionState.transferActive || !credential.token || connectionState.user?.role === "viewer"} onClick={()=>void resume(receipt)}>Continue verification for {receipt.request.title}</button></div>)}
    {status && <p aria-live="polite">{status.state === "saved" ? "Recording saved and verified." : status.state === "waiting" ? "Server verification pending; receipt retained." : `Recovery: ${status.state}`}{status.verificationStage ? ` · Verification ${status.verificationStage}` : ""}{status.waitSeconds != null ? ` · ${status.waitSeconds}s wait` : ""}</p>}
    {status?.recordingUrl && <a href={atlasWebPageUrl(status.recordingUrl)} target="_blank" rel="noreferrer">Open recovered recording</a>}
    {message && <p role="alert">{message}</p>}
    {busy && <button type="button" onClick={()=>controller.current?.pause()}>Pause monitoring</button>}
  </details>;
}
