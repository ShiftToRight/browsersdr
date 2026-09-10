import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Keep the app, stylesheet and module worker relocatable as one static directory.
  base: "./",
  plugins: [react()],
});
