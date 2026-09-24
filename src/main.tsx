import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { exposeBrowserTestUnmount } from "./testing/browserTestBridge";

const root = document.getElementById("root");
if (!root) throw new Error("Application root element is missing");

const appRoot = createRoot(root);
appRoot.render(
  <StrictMode>
    <App />
  </StrictMode>,
);

exposeBrowserTestUnmount(() => appRoot.unmount());
