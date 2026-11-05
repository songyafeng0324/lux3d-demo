import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { groupExists, stopProcessGroups } from '../scripts/process-group.mjs';

async function startFixture(behavior) {
  const grandchild = `
    process.on('SIGTERM', () => { ${behavior === 'delay' ? 'setTimeout(() => process.exit(0), 180);' : ''} });
    setInterval(() => {}, 1000);
    console.log(JSON.stringify({ ready: true, pid: process.pid }));
  `;
  const leader = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    process.on('SIGTERM', () => process.exit(0));
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.pipe(process.stdout);
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  leader.stderr.setEncoding('utf8');
  leader.stderr.on('data', (part) => { stderr += part; });
  const exited = once(leader, 'exit');
  let readyTimer;
  const ready = new Promise((resolve, reject) => {
    let output = '';
    readyTimer = setTimeout(() => reject(new Error(`Fixture not ready: ${stderr}`)), 5000);
    leader.on('error', reject);
    leader.stdout.setEncoding('utf8');
    leader.stdout.on('data', (part) => {
      output += part;
      const line = output.split('\n')[0];
      if (output.includes('\n')) {
        clearTimeout(readyTimer);
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      }
    });
  });
  try { return { leader, exited, grandchild: await ready }; } catch (error) {
    clearTimeout(readyTimer);
    await stopProcessGroups([leader.pid], { graceMs: 50 }).catch(() => {});
    throw error;
  }
}

test('shutdown waits for a delayed grandchild after its wrapper exits', { timeout: 7000 }, async () => {
  const { leader, exited } = await startFixture('delay');
  const began = Date.now();
  try {
    await stopProcessGroups([leader.pid], { graceMs: 1500, killWaitMs: 1500, pollMs: 10 });
    await exited;
    assert.ok(Date.now() - began >= 150, 'must wait for the grandchild, not only its wrapper');
    assert.equal(groupExists(leader.pid), false);
  } finally {
    await stopProcessGroups([leader.pid], { graceMs: 20 }).catch(() => {});
  }
});

test('shutdown kills a TERM-ignoring grandchild after the grace period', { timeout: 7000 }, async () => {
  const { leader, exited } = await startFixture('ignore');
  const began = Date.now();
  try {
    await stopProcessGroups([leader.pid], { graceMs: 250, killWaitMs: 1500, pollMs: 10 });
    await exited;
    assert.ok(Date.now() - began >= 230, 'TERM grace must remain active after wrapper exit');
    assert.equal(groupExists(leader.pid), false);
  } finally {
    await stopProcessGroups([leader.pid], { graceMs: 20 }).catch(() => {});
  }
});
