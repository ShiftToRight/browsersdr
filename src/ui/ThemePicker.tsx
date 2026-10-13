import { THEMES, parseTheme, setTheme, useTheme } from "./themes";

export function ThemePicker() {
  const theme = useTheme();
  return (
    <label className="theme-picker">
      <span>Theme</span>
      <select aria-label="Theme" value={theme} onChange={(event) => setTheme(parseTheme(event.target.value))}>
        {THEMES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <span className="theme-picker-swatches" data-preview={theme} aria-hidden="true"><i /><i /><i /><i /></span>
    </label>
  );
}
