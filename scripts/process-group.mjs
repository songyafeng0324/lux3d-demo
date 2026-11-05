import { setTimeout as delay } from 'node:timers/promises';

function normalizeGroupIds(groupIds) {
  return [...new Set(groupIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
}

export function groupExists(groupId) {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new TypeError('Invalid process group ID');
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function signalGroup(groupId, signal) {
  try { process.kill(-groupId, signal); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function waitForGroupsToDisappear(groupIds, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = groupIds.filter(groupExists);
  while (remaining.length && Date.now() < deadline) {
    // Keep this timer referenced: leader exit must not terminate the supervisor
    // before orphaned descendants have gone through TERM/KILL cleanup.
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    remaining = remaining.filter(groupExists);
  }
  return remaining;
}

export async function stopProcessGroups(groupIds, { graceMs = 4000, killWaitMs = 2000, pollMs = 25 } = {}) {
  const groups = normalizeGroupIds(groupIds);
  for (const groupId of groups) signalGroup(groupId, 'SIGTERM');
  const remaining = await waitForGroupsToDisappear(groups, graceMs, pollMs);
  for (const groupId of remaining) signalGroup(groupId, 'SIGKILL');
  const survivors = await waitForGroupsToDisappear(remaining, killWaitMs, pollMs);
  if (survivors.length) throw new Error(`Process groups did not disappear: ${survivors.join(', ')}`);
}
