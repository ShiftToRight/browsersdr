import { useTheme } from "./themes";

export function ThemeDecoration() {
  return useTheme() === "vice-afterglow" ? (
    <div className="theme-source-art" aria-hidden="true" />
  ) : null;
}
