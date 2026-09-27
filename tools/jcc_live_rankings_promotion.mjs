import { access, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const defaultOperations = { access, rename, rm, stat };

async function pathExists(file, operations) {
  try {
    await operations.access(file);
    return true;
  } catch {
    return false;
  }
}

function resolvePromotionPaths({ currentDir, previousDir, stagingDir }) {
  const current = path.resolve(currentDir);
  const previous = path.resolve(previousDir);
  const staging = path.resolve(stagingDir);
  const parent = path.dirname(current);
  if (new Set([current, previous, staging]).size !== 3) {
    throw new Error("rankings promotion paths must be distinct");
  }
  if (path.dirname(previous) !== parent || path.dirname(staging) !== parent) {
    throw new Error("rankings promotion paths must share one parent directory");
  }
  return { current, previous, staging, parent };
}

export async function promoteRankingsCandidate(options) {
  const operations = options.operations || defaultOperations;
  const paths = resolvePromotionPaths(options);
  const stagingInfo = await operations.stat(paths.staging).catch(() => null);
  if (!stagingInfo?.isDirectory?.()) {
    throw new Error(`rankings staging directory is unavailable: ${paths.staging}`);
  }

  const token = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const retiredCurrent = path.join(paths.parent, `.retired-current-${token}`);
  const previousBackup = path.join(paths.parent, `.previous-backup-${token}`);
  let currentDisplaced = false;
  let candidatePromoted = false;
  let previousBackedUp = false;
  let retiredPromotedToPrevious = false;
  let cleanupRecoveryDirs = true;

  try {
    if (await pathExists(paths.current, operations)) {
      await operations.rename(paths.current, retiredCurrent);
      currentDisplaced = true;
    }

    await operations.rename(paths.staging, paths.current);
    candidatePromoted = true;

    if (options.rotateCurrent && currentDisplaced) {
      if (await pathExists(paths.previous, operations)) {
        await operations.rename(paths.previous, previousBackup);
        previousBackedUp = true;
      }
      await operations.rename(retiredCurrent, paths.previous);
      retiredPromotedToPrevious = true;
      await operations.rm(previousBackup, { recursive: true, force: true }).catch(() => {});
    } else if (currentDisplaced) {
      await operations.rm(retiredCurrent, { recursive: true, force: true }).catch(() => {});
    }

    return {
      ok: true,
      current_dir: paths.current,
      previous_dir: paths.previous,
      rotated_current_to_previous: Boolean(options.rotateCurrent && currentDisplaced),
    };
  } catch (error) {
    const rollbackErrors = [];
    const rollback = async (operation) => {
      try {
        await operation();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError?.message || String(rollbackError));
      }
    };

    if (retiredPromotedToPrevious && await pathExists(paths.previous, operations)) {
      await rollback(() => operations.rename(paths.previous, retiredCurrent));
    }
    if (previousBackedUp && await pathExists(previousBackup, operations)) {
      await rollback(async () => {
        await operations.rm(paths.previous, { recursive: true, force: true });
        await operations.rename(previousBackup, paths.previous);
      });
    }
    if (candidatePromoted && await pathExists(paths.current, operations)) {
      await rollback(() => operations.rename(paths.current, paths.staging));
    }
    if (currentDisplaced && await pathExists(retiredCurrent, operations)) {
      await rollback(() => operations.rename(retiredCurrent, paths.current));
    }

    if (rollbackErrors.length) {
      cleanupRecoveryDirs = false;
      throw new Error(`${error?.message || String(error)}; rollback failed: ${rollbackErrors.join(" | ")}`);
    }
    throw error;
  } finally {
    if (cleanupRecoveryDirs) {
      await operations.rm(retiredCurrent, { recursive: true, force: true }).catch(() => {});
      await operations.rm(previousBackup, { recursive: true, force: true }).catch(() => {});
    }
  }
}
