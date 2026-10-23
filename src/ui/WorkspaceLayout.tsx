import {
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";
import { AppIcon, type AppIconName } from "./AppIcon";
import { ThemePicker } from "./ThemePicker";
import "./appInstallation";
const InstallAppControl = lazy(() =>
  import("./InstallAppControl").then((module) => ({
    default: module.InstallAppControl,
  })),
);
export const WORKSPACE_KEY = "browsersdr.workspace.v1";
export interface WorkspaceLayout {
  compact: boolean;
  sourceCollapsed: boolean;
  channelCollapsed: boolean;
  dockExpanded: boolean;
  dockLarge: boolean;
}
export const DEFAULT_WORKSPACE: WorkspaceLayout = {
  compact: false,
  sourceCollapsed: false,
  channelCollapsed: false,
  dockExpanded: true,
  dockLarge: false,
};
export function readWorkspace(
  storage: Pick<Storage, "getItem">,
): WorkspaceLayout {
  try {
    const value = JSON.parse(
      storage.getItem(WORKSPACE_KEY) ?? "null",
    ) as Partial<WorkspaceLayout> | null;
    if (!value) return { ...DEFAULT_WORKSPACE };
    return Object.fromEntries(
      Object.entries(DEFAULT_WORKSPACE).map(([key, fallback]) => [
        key,
        typeof value[key as keyof WorkspaceLayout] === "boolean"
          ? value[key as keyof WorkspaceLayout]
          : fallback,
      ]),
    ) as unknown as WorkspaceLayout;
  } catch {
    return { ...DEFAULT_WORKSPACE };
  }
}
export function useWorkspaceLayout() {
  const [layout, setLayout] = useState(() => {
    try {
      return readWorkspace(localStorage);
    } catch {
      return { ...DEFAULT_WORKSPACE };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(layout));
    } catch {
      /* Optional appearance preference. */
    }
  }, [layout]);
  return [layout, setLayout] as const;
}
function HeaderMenu({
  label,
  icon,
  active,
  children,
  onOpen,
}: {
  label: string;
  icon: AppIconName;
  active: boolean;
  children: ReactNode;
  onOpen?: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target))
        menu.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  return (
    <details
      className={`header-utility-menu${active ? " is-active" : ""}`}
      ref={menu}
      onToggle={(event) => {
        if (event.currentTarget.open) onOpen?.();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          menu.current?.removeAttribute("open");
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          menu.current?.removeAttribute("open");
          menu.current?.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={label} title={label}>
        <AppIcon name={icon} />
      </summary>
      <div
        className="header-utility-content"
        aria-label={`${label} options`}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button"))
            menu.current?.removeAttribute("open");
        }}
      >
        <p className="eyebrow">{label}</p>
        {children}
      </div>
    </details>
  );
}

export function WorkspaceControls({
  layout,
  onChange,
  onSettings,
  onHelp,
  onAntenna,
  onCompatibility,
  onAbout,
  activeView,
}: {
  layout: WorkspaceLayout;
  onChange: Dispatch<SetStateAction<WorkspaceLayout>>;
  onSettings: () => void;
  onHelp: () => void;
  onAntenna?: () => void;
  onCompatibility: () => void;
  onAbout: () => void;
  activeView: string;
}) {
  const compactButton = useRef<HTMLButtonElement>(null);
  const [settingsOpened, setSettingsOpened] = useState(false);
  return (
    <div
      className="workspace-controls"
      aria-label="Layout and application options"
    >
      <button
        ref={compactButton}
        type="button"
        className="secondary"
        aria-pressed={layout.compact}
        title={
          layout.compact
            ? "Density: compact. Switch to comfortable spacing."
            : "Density: comfortable. Switch to compact spacing."
        }
        aria-describedby={!layout.compact ? "compact-layout-hint" : undefined}
        onClick={() => onChange((old) => ({ ...old, compact: !old.compact }))}
      >
        Compact
      </button>
      {!layout.compact && (
        <span id="compact-layout-hint" className="compact-layout-hint">
          Short screen? Try Compact.
        </span>
      )}
      <HeaderMenu
        label="Settings"
        icon="settings"
        active={activeView === "settings"}
        onOpen={() => setSettingsOpened(true)}
      >
        <ThemePicker />
        {settingsOpened && (
          <Suspense fallback={<span>Loading app options…</span>}>
            <InstallAppControl />
          </Suspense>
        )}
        <button
          type="button"
          className="secondary"
          aria-controls="settings-view"
          onClick={onSettings}
        >
          <AppIcon name="plug" />
          Integration settings
        </button>
        <button
          type="button"
          className="secondary"
          title="Reset panel layout and density; receiver settings stay unchanged"
          onClick={() => {
            onChange({ ...DEFAULT_WORKSPACE });
            compactButton.current?.focus();
          }}
        >
          <AppIcon name="retry" />
          Reset layout
        </button>
      </HeaderMenu>
      <HeaderMenu
        label="Help"
        icon="help"
        active={
          activeView === "help" ||
          activeView === "antenna" ||
          activeView === "compatibility" ||
          activeView === "about"
        }
      >
        {onAntenna && (
          <button
            id="antenna-help-trigger"
            type="button"
            className="secondary"
            onClick={onAntenna}
          >
            <AppIcon name="radio" />
            Antenna guide
          </button>
        )}
        <button
          type="button"
          className="secondary"
          aria-controls="compatibility-view"
          onClick={onCompatibility}
        >
          <AppIcon name="activity" />
          Compatibility &amp; tests
        </button>
        <button
          type="button"
          className="secondary"
          aria-controls="help-view"
          onClick={onHelp}
        >
          <AppIcon name="help" />
          Help &amp; setup
        </button>
        <button
          type="button"
          className="secondary"
          aria-controls="about-view"
          onClick={onAbout}
        >
          <AppIcon name="info" />
          About BrowserSDR
        </button>
      </HeaderMenu>
    </div>
  );
}
