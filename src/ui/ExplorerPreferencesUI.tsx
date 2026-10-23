import { useEffect, useState, type ComponentProps } from "react";
import {
  preferenceFailures,
  retryPreferences,
  PREFERENCE_EVENT,
  presentationValue,
  savePresentation,
} from "./explorerPreferences";

export function PreferenceStatus() {
  const [failed, setFailed] = useState(preferenceFailures);
  useEffect(() => {
    const update = () => setFailed(preferenceFailures());
    window.addEventListener(PREFERENCE_EVENT, update);
    update();
    return () => window.removeEventListener(PREFERENCE_EVENT, update);
  }, []);
  return (
    <div className="explorer-save-status" role="status">
      {failed ? (
        <>
          Settings not saved on this device{" "}
          <button
            type="button"
            className="secondary"
            onClick={retryPreferences}
          >
            Retry saving
          </button>
        </>
      ) : (
        "Settings saved locally · acquisition stays stopped after reload"
      )}
    </div>
  );
}
export function RememberedDetails({
  preference,
  ...props
}: ComponentProps<"details"> & { preference: string }) {
  const [open, setOpen] = useState(() =>
    presentationValue<boolean>(preference, false),
  );
  return (
    <details
      {...props}
      open={open}
      onToggle={(event) => {
        const value = event.currentTarget.open;
        if (value !== open) {
          setOpen(value);
          savePresentation(preference, value);
        }
      }}
    />
  );
}
