import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { exposeBrowserTestUnmount } from "./testing/browserTestBridge";
import { defaultDiagnosticRecorder, installGlobalDiagnosticHandlers } from "./diagnostics/diagnosticRecorder";
import { ApplicationErrorBoundary } from "./ui/ApplicationErrorBoundary";

const root = document.getElementById("root");
if (!root) throw new Error("Application root element is missing");

installGlobalDiagnosticHandlers(defaultDiagnosticRecorder);
const appRoot = createRoot(root, {
  onUncaughtError: (error) => defaultDiagnosticRecorder.record({ area: "application", code: "REACT_UNCAUGHT_ERROR", severity: "fatal", operation: "render", error, autoSubmitEligible: true }),
  onRecoverableError: (error) => defaultDiagnosticRecorder.record({ area: "application", code: "REACT_RECOVERABLE_ERROR", severity: "warning", operation: "render", error }),
});
appRoot.render(
  <StrictMode>
    <ApplicationErrorBoundary><App /></ApplicationErrorBoundary>
  </StrictMode>,
);

exposeBrowserTestUnmount(() => appRoot.unmount());
