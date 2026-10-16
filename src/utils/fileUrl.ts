/**
 * Convert an absolute filesystem path to a properly-encoded file:// URL.
 * Simply concatenating `"file://" + path` is wrong when the path contains
 * spaces or other characters that are not valid in a URL (e.g. macOS paths
 * that go through ~/Library/Application Support/…).
 */
export function fileUrl(absPath: string): string {
  // Split on "/" and encode each segment, then reassemble.
  // A leading "/" produces an empty first segment which is preserved,
  // giving the correct "file:///absolute/path" form.
  return 'file://' + absPath.split('/').map(encodeURIComponent).join('/')
}
