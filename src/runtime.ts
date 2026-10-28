export async function waitUntilStopped(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    // Keep the foreground scaffold alive without polling the desktop or devices.
    const keepAlive = setInterval(() => {}, 2_147_483_647);
    signal.addEventListener('abort', () => {
      clearInterval(keepAlive);
      resolve();
    }, { once: true });
  });
}
