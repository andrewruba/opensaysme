import { readConfig, type Config } from './config.js';
import { setup } from './setup.js';

/** First launch owns interactive setup; installing a package never starts capture. */
export async function prepareStartup(signal?: AbortSignal): Promise<Config> {
  signal?.throwIfAborted();
  let config = await readConfig();
  if (config) return config;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run osm in an interactive terminal to finish setup, or run osm setup first.');
  }
  await setup(signal);
  signal?.throwIfAborted();
  config = await readConfig();
  if (!config) throw new Error('Setup did not finish. Run osm again to complete it.');
  return config;
}
