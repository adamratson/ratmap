// C1: request persistent storage at startup and verify it was actually granted.
// Region downloads must refuse to start if this is false — never let a user believe
// they have offline maps they don't.

export type StorageStatus =
  | { supported: false }
  | { supported: true; persisted: boolean };

export async function bootstrapStorage(): Promise<StorageStatus> {
  if (!navigator.storage?.persist || !navigator.storage?.persisted) {
    return { supported: false };
  }
  await navigator.storage.persist();
  const persisted = await navigator.storage.persisted();
  return { supported: true, persisted };
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's pre-standard property (C2: iOS has no beforeinstallprompt either)
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
