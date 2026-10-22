import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ledgerCosts, readCourseCosts, validateLedger, approveRecovery } from '../api-ledger.mjs';

const ledger = requests => ({ courseId: '123', model: 'fixture-model', requests });
const known = { id: 'known', status: 'known', cost_nanos: 100000 };
const unknown = { id: 'unknown', status: 'unknown', reserved_nanos: 200000 };
const pending = { id: 'pending', status: 'pending', reserved_nanos: 300000 };

test('financial state and snapshot recovery permission remain independent in the shared summary', () => {
  const book = ledger([known, unknown, pending]), original = structuredClone(book.requests);
  assert.deepEqual(ledgerCosts(book), { spent: .0001, reserved: .0005, unknown: true, unknownRequests: 1, pending: 1, requests: 3, unresolvedRequests: 2, recoveryRequired: true, meteringBoundExceeded: false });
  approveRecovery(book, [unknown.id, pending.id], 'manual');
  assert.deepEqual(book.requests, original);
  assert.deepEqual(ledgerCosts(book), { spent: .0001, reserved: .0005, unknown: true, unknownRequests: 1, pending: 1, requests: 3, unresolvedRequests: 0, recoveryRequired: false, meteringBoundExceeded: false });
  assert.deepEqual(approveRecovery(book, [unknown.id], 'manual'), [], 'repeated Continue is idempotent for the same snapshot');
  book.requests.push({ ...unknown, id: 'later' });
  assert.equal(ledgerCosts(book).unresolvedRequests, 1);
  assert.equal(ledgerCosts(book).reserved, .0007);
});

test('the shared ledger rejects malformed identities, financial states, totals and recovery references', () => {
  const recovery = { id: 'recovery', at: new Date().toISOString(), mode: 'manual', request_ids: [unknown.id] };
  for (const invalid of [
    { ...ledger([]), courseId: 'different' }, { ...ledger([]), model: '' }, { ...ledger([]), unit: 'other' },
    ledger([{ ...unknown, status: 'other' }]), ledger([{ ...unknown, id: '' }]), ledger([unknown, unknown]),
    ledger([{ ...unknown, reserved_nanos: 0 }]), ledger([{ ...unknown, reserved_nanos: -1 }]),
    ledger([{ ...known, cost_nanos: NaN }]), ledger([{ ...known, reserved_nanos: 1 }]),
    ledger([{ ...known, cost_nanos: Number.MAX_SAFE_INTEGER }, unknown]),
    ledger([{ ...known, metering_bound_exceeded: 'true' }]),
    { ...ledger([unknown]), recoveries: {} }, { ...ledger([unknown]), recoveries: [{ ...recovery, request_ids: ['absent'] }] },
    { ...ledger([known]), recoveries: [{ ...recovery, request_ids: [known.id] }] },
    { ...ledger([unknown]), recoveries: [recovery, recovery] },
  ]) assert.throws(() => validateLedger(invalid, '123'), /账本/);
});

test('readCourseCosts distinguishes a missing ledger from a corrupt financial record', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-ledger-summary-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await readCourseCosts(dir, '123'), { spent: 0, reserved: 0, unknown: false, unknownRequests: 0, pending: 0, requests: 0, unresolvedRequests: 0, recoveryRequired: false, meteringBoundExceeded: false });
  await fs.writeFile(path.join(dir, 'course-123.json'), '{');
  await assert.rejects(readCourseCosts(dir, '123'), /账本不可读/);
  await fs.writeFile(path.join(dir, 'course-123.json'), JSON.stringify(ledger([{ ...unknown, reserved_nanos: null }])));
  await assert.rejects(readCourseCosts(dir, '123'), /账本金额无效/);
});
