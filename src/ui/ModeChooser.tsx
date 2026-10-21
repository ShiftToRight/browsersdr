import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  LayoutGrid,
  RadioTower,
  Plane,
  Ship,
  Radio,
  Cpu,
  CloudSun,
  Pin,
  PinOff,
  Check,
} from "lucide-react";
import type { ReceiverMode } from "../radio/receiverConfig";
import type { ModeSelectorProps } from "./ModeSelector";
import { AppIcon } from "./AppIcon";
import {
  MODE_CATEGORIES,
  MODE_DESCRIPTIONS,
  matchingModes,
  type ModeCategory,
} from "./modeCatalog";
import { DEFAULT_QUICK_MODES, QUICK_MODE_LIMIT } from "./modeQuickList";
import "./ModeChooser.css";

const categoryIcons = {
  "All modes": LayoutGrid,
  Broadcast: RadioTower,
  Paging: RadioTower,
  Aviation: Plane,
  Marine: Ship,
  Amateur: Radio,
  Sensors: Cpu,
  "Weather & satellite": CloudSun,
};

export function ModeChooser(
  props: ModeSelectorProps & {
    pins: ReceiverMode[];
    onPinsChange: (modes: ReceiverMode[]) => void;
    storageIssue: string;
    trigger: RefObject<HTMLButtonElement | null>;
    onDismiss: () => void;
  },
) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const backdropPressed = useRef(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ModeCategory>("All modes");
  const [selection, setSelection] = useState({
    mode: props.value,
    context: props.contextKey,
    chosen: false,
  });
  const [replacement, setReplacement] = useState<ReceiverMode>();
  const [replaceMode, setReplaceMode] = useState(props.pins[0] ?? "WBFM");
  const contextChanged = selection.context !== props.contextKey;
  const selectedMode = contextChanged ? props.value : selection.mode;
  const selected = MODE_DESCRIPTIONS[selectedMode];
  const blocked =
    props.blockedReason ??
    props.unavailableReason(selectedMode) ??
    (contextChanged
      ? "Receiver context changed. Select a mode again before applying."
      : undefined);
  const visible = matchingModes(query, category);

  useLayoutEffect(() => {
    const panel = dialog.current!;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.showModal();
    search.current?.focus({ preventScroll: true });
    return () => {
      panel.close();
      document.body.style.overflow = overflow;
      if (props.trigger.current?.isConnected)
        props.trigger.current.focus({ preventScroll: true });
    };
  }, [props.trigger]);

  const togglePin = (mode: ReceiverMode) => {
    setReplacement(undefined);
    if (props.pins.includes(mode))
      props.onPinsChange(props.pins.filter((pin) => pin !== mode));
    else if (props.pins.length < QUICK_MODE_LIMIT)
      props.onPinsChange([...props.pins, mode]);
    else {
      setReplaceMode(props.pins[0]!);
      setReplacement(mode);
    }
  };
  const outside = (event: {
    clientX: number;
    clientY: number;
    currentTarget: HTMLDialogElement;
  }) => {
    const box = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    );
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="mode-chooser"
      aria-labelledby={`${id}-heading`}
      aria-describedby={`${id}-summary`}
      onCancel={(event) => {
        event.preventDefault();
        props.onDismiss();
      }}
      onPointerDown={(event) => {
        backdropPressed.current =
          event.target === event.currentTarget && outside(event);
      }}
      onClick={(event) => {
        if (
          backdropPressed.current &&
          event.target === event.currentTarget &&
          outside(event)
        )
          props.onDismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onDismiss();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0],
          last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <header className="mode-chooser-header">
        <h2 id={`${id}-heading`}>Choose a decoder</h2>
        <button
          type="button"
          className="secondary mode-chooser-close"
          aria-label="Close decoder chooser"
          onClick={props.onDismiss}
        >
          <AppIcon name="close" />
        </button>
      </header>
      <div className="mode-chooser-search">
        <AppIcon name="search" />
        <input
          ref={search}
          type="search"
          aria-label="Search modes or decoders"
          placeholder="Search modes or decoders…"
          maxLength={100}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <div className="mode-chooser-body">
        <nav
          aria-label="Decoder categories"
          className="mode-chooser-categories"
        >
          {MODE_CATEGORIES.map((name) => {
            const Icon = categoryIcons[name];
            return (
              <button
                key={name}
                type="button"
                className="secondary"
                aria-pressed={category === name}
                onClick={() => setCategory(name)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{name}</span>
              </button>
            );
          })}
        </nav>
        <section className="mode-chooser-results" aria-label="Decoder modes">
          <div className="mode-chooser-results-heading">
            <span role="status">
              {visible.length} {visible.length === 1 ? "mode" : "modes"}
            </span>
            <span>
              Pin to quick list · {props.pins.length}/{QUICK_MODE_LIMIT}
            </span>
          </div>
          {visible.length === 0 && (
            <p className="mode-chooser-empty">
              No modes match. Try another search or category.
            </p>
          )}
          <div className="mode-chooser-grid">
            {visible.map((mode) => {
              const info = MODE_DESCRIPTIONS[mode];
              const Icon = categoryIcons[info.categories[0] ?? "All modes"];
              const unavailable = props.unavailableReason(mode);
              const pinned = props.pins.includes(mode);
              return (
                <article
                  key={mode}
                  className={`mode-chooser-card${selectedMode === mode ? " is-selected" : ""}`}
                >
                  <button
                    type="button"
                    className="secondary mode-chooser-card-select"
                    aria-label={`Select ${info.label}`}
                    aria-pressed={selectedMode === mode}
                    onClick={() =>
                      setSelection({
                        mode,
                        context: props.contextKey,
                        chosen: true,
                      })
                    }
                  >
                    <Icon size={28} strokeWidth={1.5} aria-hidden="true" />
                    <span className="mode-chooser-card-copy">
                      <strong>{info.label}</strong>
                      <span>{info.description}</span>
                      <small
                        className={
                          unavailable ? "is-unavailable" : "is-available"
                        }
                      >
                        {unavailable ?? "Available"}
                      </small>
                    </span>
                    {selectedMode === mode && (
                      <Check
                        className="mode-chooser-selected"
                        size={16}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    className="secondary mode-chooser-pin"
                    aria-label={`${pinned ? "Unpin" : "Pin"} ${info.label}${pinned ? "" : " to quick list"}`}
                    aria-pressed={pinned}
                    title={
                      pinned ? "Remove from quick list" : "Pin to quick list"
                    }
                    onClick={() => togglePin(mode)}
                  >
                    {pinned ? (
                      <PinOff size={17} aria-hidden="true" />
                    ) : (
                      <Pin size={17} aria-hidden="true" />
                    )}
                  </button>
                </article>
              );
            })}
          </div>
        </section>
      </div>
      <div className="mode-chooser-options">
        {replacement &&
          !props.pins.includes(replacement) &&
          props.pins.length === QUICK_MODE_LIMIT && (
            <div
              className="mode-chooser-replace"
              role="group"
              aria-label="Replace a quick mode"
            >
              <label>
                Pin {MODE_DESCRIPTIONS[replacement].label} instead of
                <select
                  aria-label="Quick mode to replace"
                  value={
                    props.pins.includes(replaceMode)
                      ? replaceMode
                      : props.pins[0]
                  }
                  onChange={(event) =>
                    setReplaceMode(event.currentTarget.value as ReceiverMode)
                  }
                >
                  {props.pins.map((mode) => (
                    <option key={mode} value={mode}>
                      {MODE_DESCRIPTIONS[mode].label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  const previous = props.pins.includes(replaceMode)
                    ? replaceMode
                    : props.pins[0];
                  props.onPinsChange(
                    props.pins.map((mode) =>
                      mode === previous ? replacement : mode,
                    ),
                  );
                  setReplacement(undefined);
                }}
              >
                Replace pin
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setReplacement(undefined)}
              >
                Cancel pin
              </button>
            </div>
          )}
        <div className="mode-chooser-pin-settings">
          <span>
            Pin adds a mode to the quick list; unpin removes it. Saved in this
            browser.
          </span>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              props.onPinsChange([...DEFAULT_QUICK_MODES]);
              setReplacement(undefined);
            }}
          >
            Reset quick list
          </button>
        </div>
        {props.storageIssue && <p role="status">{props.storageIssue}</p>}
      </div>
      <footer className="mode-chooser-footer">
        <div>
          <strong>
            {selection.chosen && !contextChanged
              ? `${selected.label} selected`
              : `Current mode: ${selected.label}`}
          </strong>
          <p id={`${id}-summary`}>{props.configurationPreview(selectedMode)}</p>
          {blocked && (
            <p role="status" className="mode-chooser-blocked">
              {blocked}
            </p>
          )}
        </div>
        <div className="mode-chooser-actions">
          <button type="button" className="secondary" onClick={props.onDismiss}>
            Cancel
          </button>
          <button
            type="button"
            disabled={Boolean(blocked)}
            onClick={() => {
              if (
                props.blockedReason ||
                props.unavailableReason(selectedMode) ||
                contextChanged
              )
                return;
              if (selectedMode !== props.value) props.onChange(selectedMode);
              props.onDismiss();
            }}
          >
            Use mode
          </button>
        </div>
      </footer>
    </dialog>,
    document.body,
  );
}
