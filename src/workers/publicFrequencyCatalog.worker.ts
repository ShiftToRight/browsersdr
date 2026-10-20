import profiles from "../radio/shared-frequency-guides.json";
import metadata from "../radio/shared-frequency-snapshot.json";
import {
  fetchFrequencyCatalog,
  readSavedFrequencyCatalog,
  saveFrequencyCatalog,
  type FrequencyCatalogUpdate,
  type FrequencySourceMode,
  type FrequencySnapshot,
  type SavedFrequencyCatalog,
} from "../radio/publicFrequencyCatalog";
const bundled: FrequencySnapshot = {
  ...metadata,
  schema_version: "public-frequency-catalog-v1",
  profiles,
};
self.onmessage = (event: MessageEvent<{ mode: FrequencySourceMode }>) => {
  void run(event.data.mode);
};
async function run(mode: FrequencySourceMode) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  let lastRevision = bundled.revision;
  let known = new Map(bundled.profiles.map((profile) => [profile.id, profile]));
  const equal = (
    a: (typeof bundled.profiles)[number],
    b: (typeof bundled.profiles)[number],
  ) =>
    Object.keys(a).every((key) => {
      const left = a[key as keyof typeof a],
        right = b[key as keyof typeof b];
      return Array.isArray(left)
        ? Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => value === right[index])
        : left === right;
    });
  const emit = async (
    source: FrequencyCatalogUpdate["source"],
    value: SavedFrequencyCatalog,
    saved?: boolean,
  ) => {
    const snapshot = value.snapshot;
    const update: FrequencyCatalogUpdate = {
      source,
      revision: snapshot.revision,
      published_at: snapshot.published_at,
      checkedAt: value.checkedAt,
      saved,
      complete: true,
    };
    if (snapshot.revision === lastRevision) {
      self.postMessage(update);
      return;
    }
    const changed = snapshot.profiles.filter(
      (profile) =>
        !known.has(profile.id) || !equal(known.get(profile.id)!, profile),
    );
    const order = snapshot.profiles.map((profile) => profile.id);
    // Bound foreground deserialization and let RF callbacks run between chunks.
    for (let offset = 0; offset < Math.max(1, changed.length); offset += 32) {
      self.postMessage({
        ...update,
        order: offset === 0 ? order : undefined,
        patch: changed.slice(offset, offset + 32),
        complete: offset + 32 >= changed.length,
      });
      if (offset + 32 < changed.length)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    known = new Map(snapshot.profiles.map((profile) => [profile.id, profile]));
    lastRevision = snapshot.revision;
  };
  const saved = (await readSavedFrequencyCatalog()) ?? {
    snapshot: bundled,
    checkedAt: null,
  };
  try {
    if (mode !== "live") await emit("saved", saved);
    if (mode === "saved") return;
    const live = await fetchFrequencyCatalog(saved, controller.signal);
    await emit("live", live, await saveFrequencyCatalog(live));
  } catch {
    await emit("unavailable", saved);
  } finally {
    clearTimeout(timeout);
  }
}
