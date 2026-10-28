import type { ReactNode } from "react";
import { sourceCapabilities } from "../radio/sourceCapabilities";

/** Common presentation only: each source retains its own samples and lifecycle. */
export function ReceiverWorkspace({
  id,
  hidden = false,
  children,
}: {
  id: string;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className="receiver-layout"
      role="tabpanel"
      aria-labelledby="receiver-tab"
      hidden={hidden}
    >
      {children}
    </div>
  );
}

export function ReceiverSourceOptions({
  remoteDisabled = false,
}: {
  remoteDisabled?: boolean;
}) {
  return (
    <>
      {(["rtl-sdr", "hackrf", "airspy", "bladerf", "usrp-b205"] as const).map(
        (source) => (
          <option key={source} value={source}>
            {sourceCapabilities(source).label} device
          </option>
        ),
      )}
      <option value="synthetic">Synthetic spectrum demo</option>
      <option value="replay">I/Q recording replay</option>
      <option value="remote" disabled={remoteDisabled}>
        Remote web receiver · OpenWebRX / KiwiSDR
      </option>
    </>
  );
}
