/**
 * Advance CDC binlog checkpoint to current master position and clear CDC streams.
 * Use after a bulk migration that already ran without CDC shielding.
 *
 * Usage: npx tsx src/misc/scripts/advanceCdcBinlogCheckpoint.ts
 */
import { advanceCdcBinlogCheckpointToCurrent } from '@/externalServices/cdcService/advanceBinlogCheckpoint.js';

async function main(): Promise<void> {
  const cp = await advanceCdcBinlogCheckpointToCurrent({ resetStreams: true });
  if (!cp) {
    process.exitCode = 1;
    return;
  }
  console.log(`Checkpoint set to ${cp.filename}:${cp.position}; CDC streams reset.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
