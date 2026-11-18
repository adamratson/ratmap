/**
 * Hand a file to the OS share sheet where that exists, otherwise download it.
 *
 * Share first because on iOS a downloaded file is awkward to get at from an installed
 * Home Screen app, while the share sheet puts it straight into Files, Mail, a printer or
 * another app. `canShare` is checked with the actual file — Safari reports support for
 * sharing but not necessarily for sharing *files*.
 *
 * Call it straight from the tap: `navigator.share` needs the tap's user activation, which
 * runs out if slow work comes first.
 */
export async function shareOrDownload(
  file: File,
  title: string,
): Promise<'shared' | 'cancelled' | 'downloaded'> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (err) {
      // A user-cancelled share is not a failure worth reporting.
      if ((err as Error)?.name === 'AbortError') return 'cancelled';
      // Anything else: fall through to a download rather than leaving them with nothing.
    }
  }

  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return 'downloaded';
}
