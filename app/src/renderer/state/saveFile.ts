/**
 * Hand text to the user as a file: a download in a browser, a save dialog in
 * the desktop app. A Blob link rather than a request — nothing leaves the
 * page.
 */
export function saveFile(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoked late, not at once: Chromium starts the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
