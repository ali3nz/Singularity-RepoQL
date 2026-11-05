import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as S from './run-slots.mjs';
import { coordinatorStatus, renderCoordinatorLine, COORDINATOR_STATES } from './coordinator-status.mjs';
import { poolClockEvents } from './session-watch.mjs';
import { endOwnershipGuard } from './consult-liveness.mjs';

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'singularity-native-ownership-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive:true, force:true }); }
}

test('Windows coordinator status never claims stale, free, or running from Linux-only PID evidence', () => fixture(dir => {
  assert.equal(coordinatorStatus(dir, { platform: 'win32' }).state, COORDINATOR_STATES.UNVERIFIED);
  writeFileSync(join(dir, 'COORDINATOR.lock'), '1234');
  const read = coordinatorStatus(dir, { platform: 'win32', listDir: {'1234': 'node orchestrate.mjs start --go'}});
  assert.equal(read.state, COORDINATOR_STATES.UNVERIFIED);
  assert.match(renderCoordinatorLine(dir, { platform: 'win32' }), /UNVERIFIED/);
}));

test('Windows slot and seat acquisition refuse mutation instead of deleting old lock', () => fixture(dir => {
  const slot=join(dir,'COORDINATOR-1.lock'); writeFileSync(slot,'54321');
  assert.throws(()=>S.acquireSlot(dir,{platform:'win32',isAlive:()=>false}), /NATIVE_WINDOWS_AUTHORITY_REQUIRED/);
  assert.equal(readFileSync(slot,'utf8'),'54321');
  const seat=join(dir,'SEATS','1.slot'); mkdirSync(join(dir,'SEATS'));
  writeFileSync(seat,'54321 run-old seat-old');
  assert.throws(()=>S.tryAcquireSeatSlot(dir,{platform:'win32',isAlive:()=>false}), /NATIVE_WINDOWS_AUTHORITY_REQUIRED/);
  assert.equal(readFileSync(seat,'utf8'),'54321 run-old seat-old');
  assert.equal(existsSync(join(dir,'COORDINATOR-2.lock')),false);
}));

test('Windows read-only active registry inspection does not prune unverified entries', () => fixture(dir => {
  mkdirSync(join(dir,'ACTIVE'));
  const entry=join(dir,'ACTIVE','run-old'); writeFileSync(entry, JSON.stringify({runId:'run-old',pid:12345}));
  assert.throws(()=>S.listActive(dir,{platform:'win32',prune:true,isAlive:()=>false}), /NATIVE_WINDOWS_AUTHORITY_REQUIRED/);
  assert.throws(()=>S.listSlots(dir,{platform:'win32',isAlive:()=>false}), /NATIVE_WINDOWS_AUTHORITY_REQUIRED/);
  assert.throws(()=>S.seatSlotsInUse(dir,{platform:'win32',isAlive:()=>false}), /NATIVE_WINDOWS_AUTHORITY_REQUIRED/);
  assert.equal(existsSync(entry),true);
  assert.throws(()=>S.registerActive(dir,'run-new',{platform:'win32'}),/NATIVE_WINDOWS_AUTHORITY_REQUIRED/);
  assert.throws(()=>S.unregisterActive(dir,'run-old',{platform:'win32'}),/NATIVE_WINDOWS_AUTHORITY_REQUIRED/);
  assert.equal(existsSync(entry),true);
  assert.equal(S.resolveTargetRun(dir,{platform:'win32',mutating:true,explicit:'run-old'}).ok,false);
}));

test('Windows never suggests reusing a worker seat based on an absent /proc', () => fixture(dir => {
  const now=Date.now();
  writeFileSync(join(dir,'pool.json'), JSON.stringify({worker1:{spawnedAt:now-60_000,lastRunId:'r1'}}));
  const {events}=poolClockEvents(dir,{now,reuseMinutes:55,platform:'win32'});
  assert.equal(events.some(x=>x.event==='salvage-available'),false);
}));

test('Unverified consult ownership is never an implicit permission to close a session',()=>{
  for(const status of ['UNVERIFIED','UNKNOWN',null])
    assert.equal(endOwnershipGuard({openClass:status,explicitId:null}).action,'refuse');
});
