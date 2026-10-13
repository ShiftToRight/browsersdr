/** Decorative silhouettes identify receiver families without replacing their names. */
export function CommunityHardwareIcon({ source }: { source: string }) {
  return (
    <svg
      className={`community-device-icon device-${source}`}
      viewBox="0 0 64 40"
      aria-hidden="true"
      focusable="false"
    >
      {source === "rtl-sdr" ? (
        <>
          <rect
            className="device-body"
            x="16"
            y="9"
            width="34"
            height="22"
            rx="5"
          />
          <path d="M16 14H7v12h9M50 20h7M11 17v6M23 15h17M23 25h11" />
          <circle className="device-light" cx="43" cy="20" r="2" />
        </>
      ) : source === "hackrf" ? (
        <>
          <rect
            className="device-body"
            x="9"
            y="7"
            width="46"
            height="27"
            rx="4"
          />
          <path d="M19 7V3m26 4V3M9 18H4v9h5M23 15h17v12H23zM15 12v17m34-17v17" />
          <circle className="device-light" cx="44" cy="20" r="2" />
        </>
      ) : source === "bladerf" ? (
        <>
          <rect
            className="device-body"
            x="8"
            y="8"
            width="48"
            height="26"
            rx="3"
          />
          <path d="M19 8V3m25 5V3M8 18H3v9h5M36 14h12v13H36z" />
          <circle cx="23" cy="21" r="8" />
          <path d="M23 16v10m-5-5h10" />
        </>
      ) : source === "usrp-b205" ? (
        <>
          <rect
            className="device-body"
            x="7"
            y="9"
            width="50"
            height="24"
            rx="4"
          />
          <path d="M15 9V4m10 5V4m32 13h4v9h-4M34 16h14m-14 5h14m-14 5h14" />
          <circle cx="16" cy="21" r="3" />
          <circle cx="25" cy="21" r="3" />
        </>
      ) : source === "replay" ? (
        <>
          <path className="device-body" d="M18 4h20l9 9v23H18z" />
          <path d="M38 4v9h9M27 18l10 6-10 6z" />
        </>
      ) : (
        <>
          <rect
            className="device-body"
            x="7"
            y="7"
            width="50"
            height="28"
            rx="5"
          />
          <path d="M12 22h7l4-9 7 17 6-17 5 9h11" />
        </>
      )}
    </svg>
  );
}
