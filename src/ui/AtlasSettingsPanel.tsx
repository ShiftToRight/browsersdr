import { useState, useSyncExternalStore } from "react";
import {
  atlasConnectionMessage,
  getAtlasConnection,
  type AtlasConnection,
} from "../radio/atlasConnection";

export function AtlasSettingsPanel({
  connection = getAtlasConnection(),
}: {
  connection?: AtlasConnection;
}) {
  const credential = useSyncExternalStore(
    connection.credentials.subscribe,
    connection.credentials.getSnapshot,
  );
  const state = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
  );
  const [draft, setDraft] = useState({
    revision: credential.revision,
    token: credential.token,
    remember: credential.remember,
  });
  const [notice, setNotice] = useState("");
  const token =
    draft.revision === credential.revision ? draft.token : credential.token;
  const remember =
    draft.revision === credential.revision
      ? draft.remember
      : credential.remember;
  const busy =
    state.status === "connecting" || state.status === "disconnecting";
  const disabled = state.transferActive || busy;
  const action = (operation: () => void | Promise<void>, message: string) => {
    setNotice("");
    try {
      void Promise.resolve(operation()).then(
        () => setNotice(message),
        (error) => setNotice(atlasConnectionMessage(error)),
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not update Atlas settings.",
      );
    }
  };
  return (
    <section
      className="panel atlas-settings-panel"
      aria-labelledby="atlas-settings-heading"
    >
      <h2 id="atlas-settings-heading">SigIntAtlas</h2>
      <p>
        Configure one user token for recording saves, transfer recovery and
        Atlas features.
      </p>
      <p>
        Destination:{" "}
        <strong>
          {location.hostname === "browsersdr.com" ||
          location.hostname === "www.browsersdr.com"
            ? "sigintatlas.com · Production"
            : location.origin}
        </strong>
        . API requests use this BrowserSDR origin.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action(
            () => connection.saveToken(token, remember),
            "Token configured. Test connection to check access.",
          );
        }}
      >
        <label>
          SigIntAtlas user token
          <input
            aria-label="Settings SigIntAtlas user token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            minLength={32}
            maxLength={4096}
            required
            value={token}
            disabled={disabled}
            onChange={(event) =>
              setDraft({
                revision: credential.revision,
                token: event.currentTarget.value,
                remember,
              })
            }
          />
        </label>
        <label className="atlas-analysis-choice">
          <input
            type="checkbox"
            checked={remember}
            disabled={disabled}
            onChange={(event) =>
              setDraft({
                revision: credential.revision,
                token,
                remember: event.currentTarget.checked,
              })
            }
          />
          Remember on this browser
        </label>
        <div className="atlas-save-actions">
          <button type="submit" disabled={disabled}>
            Save token
          </button>
          <button
            type="button"
            className="secondary"
            disabled={disabled || !credential.token}
            onClick={() =>
              action(() => connection.testConnection(), "Connection checked.")
            }
          >
            Test connection
          </button>
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            onClick={() =>
              action(
                () => connection.disconnect(),
                "Disconnected locally. The configured token is retained.",
              )
            }
          >
            Disconnect
          </button>
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            onClick={() =>
              action(
                () => connection.forgetToken(),
                "Token cleared from this tab.",
              )
            }
          >
            Forget token
          </button>
        </div>
      </form>
      {state.transferActive && (
        <p role="status">
          Wait for the SigIntAtlas transfer to finish or cancel it before
          changing credentials.
        </p>
      )}
      <div role="status" className="atlas-settings-status">
        <p>
          Credential:{" "}
          {credential.token
            ? credential.persistence === "remembered"
              ? "Remembered in this browser"
              : "Available in this tab"
            : "No token configured"}
          .
        </p>
        <p>Session: {state.status}.</p>
        {state.user && (
          <p>
            Connected as {state.user.display_name} · {state.user.role}.
            {state.user.role === "viewer" &&
              " Viewer access is read-only; recording saves and recovery require write permission."}
          </p>
        )}
        {state.expiresAt && (
          <p>Session expires {new Date(state.expiresAt).toLocaleString()}.</p>
        )}
        {notice && <p>{notice}</p>}
        {credential.notice && <p>{credential.notice}</p>}
        {state.message && <p>{state.message}</p>}
      </div>
      <p className="display-note">
        Remembered tokens are stored on this browser origin and can be read by
        this app's scripts. This is not an encrypted vault. Uncheck Remember and
        save to use a token only in this tab. Disconnect and Forget do not
        revoke the token in SigIntAtlas.
      </p>
    </section>
  );
}
