import { InstrumentButton } from "./InstrumentButton";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReceiverMode } from "../radio/receiverConfig";
import { AppIcon } from "./AppIcon";
import { MODE_DESCRIPTIONS } from "./modeCatalog";
import {
  DEFAULT_QUICK_MODES,
  QUICK_MODES_KEY,
  quickModesWithCurrent,
  readQuickModes,
} from "./modeQuickList";
import "./ModeSelector.css";

const ModeChooser = lazy(() =>
  import("./ModeChooser").then((module) => ({ default: module.ModeChooser })),
);

export interface ModeSelectorProps {
  value: ReceiverMode;
  contextKey: string;
  blockedReason?: string;
  unavailableReason: (mode: ReceiverMode) => string | undefined;
  configurationPreview: (mode: ReceiverMode) => string;
  onChange: (mode: ReceiverMode) => void;
  status?: ReactNode;
}

export function ModeSelector(props: ModeSelectorProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pins, setPins] = useState<ReceiverMode[]>(() => {
    try {
      return readQuickModes(localStorage);
    } catch {
      return [...DEFAULT_QUICK_MODES];
    }
  });
  const [storageIssue, setStorageIssue] = useState("");
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === QUICK_MODES_KEY || event.key === null) {
        try {
          setPins(readQuickModes(localStorage));
        } catch {
          /* Keep this tab's preference. */
        }
      }
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  const changePins = (next: ReceiverMode[]) => {
    setPins(next);
    try {
      localStorage.setItem(QUICK_MODES_KEY, JSON.stringify(next));
      setStorageIssue("");
    } catch {
      setStorageIssue(
        "Quick modes are saved for this tab only; browser storage is unavailable.",
      );
    }
  };
  return (
    <div className="mode-selector">
      <label htmlFor={id}>Mode</label>
      <div className="mode-selector-controls">
        <select
          id={id}
          value={props.value}
          disabled={Boolean(props.blockedReason)}
          aria-describedby={props.blockedReason ? `${id}-blocked` : undefined}
          onChange={(event) => {
            const mode = event.currentTarget.value as ReceiverMode;
            if (!props.blockedReason && !props.unavailableReason(mode))
              props.onChange(mode);
          }}
        >
          {quickModesWithCurrent(pins, props.value).map((mode) => (
            <option
              key={mode}
              value={mode}
              disabled={Boolean(props.unavailableReason(mode))}
              title={props.unavailableReason(mode)}
            >
              {MODE_DESCRIPTIONS[mode].label}
              {!pins.includes(mode) ? " · current" : ""}
            </option>
          ))}
        </select>
        <InstrumentButton
          ref={trigger}
          type="button"
          className="secondary mode-selector-more"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <AppIcon name="sliders" />
          More modes…
        </InstrumentButton>
      </div>
      {props.status}
      {props.blockedReason && (
        <small id={`${id}-blocked`} className="mode-selector-blocked">
          {props.blockedReason}
        </small>
      )}
      {open && (
        <Suspense
          fallback={<small role="status">Opening decoder chooser…</small>}
        >
          <ModeChooser
            {...props}
            pins={pins}
            onPinsChange={changePins}
            storageIssue={storageIssue}
            trigger={trigger}
            onDismiss={() => setOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
