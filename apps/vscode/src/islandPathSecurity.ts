export type IslandPathStats = {
  mode: number;
  uid?: number;
};

export function getSecureSystemPathIssue(
  stats: IslandPathStats,
  label: string
): string | undefined {
  if (typeof stats.uid === 'number' && stats.uid !== 0) {
    return `${label}: expected root ownership.`;
  }

  if ((stats.mode & 0o022) !== 0) {
    return `${label}: path is group/world writable.`;
  }

  return undefined;
}

export function getSecureUnlockTargetIssue(
  stats: IslandPathStats,
  callerUid: number,
  label: string
): string | undefined {
  if (typeof stats.uid === 'number' && stats.uid !== 0 && stats.uid !== callerUid) {
    return `${label}: expected root or caller ownership.`;
  }

  if ((stats.mode & 0o022) !== 0) {
    return `${label}: path is group/world writable.`;
  }

  return undefined;
}

export function getUserRegistryHomeIssue(
  stats: IslandPathStats,
  callerUid: number
): string | undefined {
  if (typeof stats.uid === 'number' && stats.uid !== callerUid) {
    return 'registry home: expected caller ownership.';
  }

  if ((stats.mode & 0o002) !== 0) {
    return 'registry home: path is world writable.';
  }

  return undefined;
}

export function formatBrokerPathRejection(issue: string): string {
  return `Tyrian Night broker rejected ${issue}`;
}
