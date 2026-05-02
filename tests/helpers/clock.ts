import * as anchor from "@coral-xyz/anchor";

/**
 * Wait for a specified number of seconds.
 * Uses real time - for local validator tests where clock advances with wall time.
 */
export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Wait until the on-chain clock passes a target timestamp.
 * Polls every 400ms.
 */
export async function waitUntilTimestamp(
  provider: anchor.AnchorProvider,
  targetTimestamp: number,
  timeoutMs: number = 60_000
): Promise<void> {
  const start = Date.now();
  while (true) {
    const slot = await provider.connection.getSlot();
    const blockTime = await provider.connection.getBlockTime(slot);
    if (blockTime && blockTime >= targetTimestamp) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timeout waiting for clock to reach ${targetTimestamp}. Current: ${blockTime}`
      );
    }
    await sleep(0.4);
  }
}

/**
 * Get the current on-chain unix timestamp.
 */
export async function getCurrentTimestamp(
  provider: anchor.AnchorProvider
): Promise<number> {
  const slot = await provider.connection.getSlot();
  const blockTime = await provider.connection.getBlockTime(slot);
  if (!blockTime) throw new Error("Could not get block time");
  return blockTime;
}
