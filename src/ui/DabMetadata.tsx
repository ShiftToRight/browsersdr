import { useEffect, useRef } from "react";
import type { DabProgrammeMetadata } from "../dab/dabPad";
import type { DabSlideshow } from "../dab/dabMot";

function BroadcastSlide({ slide }: { slide: DabSlideshow }) {
  const image = useRef<HTMLImageElement>(null);
  const failure = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const node = image.current;
    if (!node) return;
    const url = URL.createObjectURL(
      new Blob([slide.data], { type: slide.mimeType }),
    );
    node.hidden = false;
    if (failure.current) failure.current.hidden = true;
    node.src = url;
    return () => {
      node.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [slide]);
  return (
    <figure className="dab-slideshow">
      <img
        ref={image}
        alt="Slideshow image broadcast by the selected station"
        onError={() => {
          if (image.current) image.current.hidden = true;
          if (failure.current) failure.current.hidden = false;
        }}
      />
      <p ref={failure} hidden>
        The broadcast image could not be displayed.
      </p>
      <figcaption>{slide.category || "Broadcast slideshow"}</figcaption>
    </figure>
  );
}

export function DabMetadata({ metadata }: { metadata?: DabProgrammeMetadata }) {
  return (
    <section
      className="dab-metadata"
      aria-label="Station live text and slideshow"
    >
      <div>
        <h4>Live text</h4>
        <p className="dab-live-text" aria-live="polite" aria-atomic="true">
          {metadata?.text || "Waiting for broadcast text…"}
        </p>
      </div>
      {metadata?.slide ? (
        <BroadcastSlide slide={metadata.slide} />
      ) : (
        <p className="display-note">
          Waiting for a broadcast slideshow. Availability depends on the
          station.
        </p>
      )}
    </section>
  );
}
