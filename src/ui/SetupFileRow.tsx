import { useId, type ChangeEvent } from "react";

/** A saved setup file is separate from the device's connection state. */
export function SetupFileRow({
  name,
  verified,
  checking = false,
  importing,
  disabled,
  accept,
  error,
  onChange,
}: {
  name: string;
  verified: boolean;
  checking?: boolean;
  importing: boolean;
  disabled: boolean;
  accept: string;
  error?: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const errorId = useId();
  return (
    <div className="setup-file">
      <div className="setup-file-row">
        <span
          className={verified && !importing ? "setup-file-verified" : ""}
          role="status"
        >
          {importing
            ? `Verifying ${name.toLowerCase()}…`
            : checking
              ? `Checking ${name.toLowerCase()}…`
              : verified
                ? `✓ ${name} verified`
                : name}
        </span>
        <label className={`setup-file-import ${verified ? "is-saved" : ""}`}>
          <input
            className="visually-hidden"
            type="file"
            accept={accept}
            aria-label={`${verified ? "Replace" : "Import"} ${name.toLowerCase()}`}
            aria-describedby={error ? errorId : undefined}
            disabled={disabled || importing || checking}
            onChange={onChange}
          />
          {verified ? "Replace" : "Import"}
        </label>
      </div>
      {error && (
        <p className="setup-file-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
