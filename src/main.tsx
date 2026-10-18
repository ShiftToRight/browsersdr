import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./ui/DecoderWorkspace.css";
import "./ui/themes.css";
import { initializeTheme } from "./ui/themes";
initializeTheme();
import { exposeBrowserTestUnmount } from "./testing/browserTestBridge";
import { defaultDiagnosticRecorder, installGlobalDiagnosticHandlers } from "./diagnostics/diagnosticRecorder";
import { ApplicationErrorBoundary } from "./ui/ApplicationErrorBoundary";
import { legacyAtlasPageRedirect } from "./radio/atlasWebNavigation";
const LiveGuest = lazy(() => import("./ui/LiveGuest"));
// A guest must not fetch/initialize the hardware/DSP application to receive media.
const App = lazy(() => import("./App"));
const guestEntry = new URLSearchParams(location.search).get("live-guest") === "1";

const atlasPage = legacyAtlasPageRedirect(location);
if (atlasPage) {
  location.replace(atlasPage);
} else {
  const root = document.getElementById("root");
  if (!root) throw new Error("Application root element is missing");

  installGlobalDiagnosticHandlers(defaultDiagnosticRecorder);
  const appRoot = createRoot(root, {
    onUncaughtError: (error) => defaultDiagnosticRecorder.record({ area: "application", code: "REACT_UNCAUGHT_ERROR", severity: "fatal", operation: "render", error, autoSubmitEligible: true }),
    onRecoverableError: (error) => defaultDiagnosticRecorder.record({ area: "application", code: "REACT_RECOVERABLE_ERROR", severity: "warning", operation: "render", error }),
  });
  appRoot.render(
    <StrictMode>
      <ApplicationErrorBoundary><Suspense fallback={<p role="status">{guestEntry ? "Opening guest preview…" : "Opening receiver…"}</p>}>{guestEntry ? <LiveGuest /> : <App />}</Suspense></ApplicationErrorBoundary>
    </StrictMode>,
  );

  exposeBrowserTestUnmount(() => appRoot.unmount());
}
