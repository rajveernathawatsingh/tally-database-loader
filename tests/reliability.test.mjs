import test from 'node:test';
import assert from 'node:assert/strict';

import {
    countConsecutiveFailures,
    getFullDefinitionPath,
    shouldForceFullSyncOnAlterIdReset,
    shouldForceFullSyncOnStaleVoucherDate
} from '../dist/reliability.mjs';

test('getFullDefinitionPath swaps the incremental YAML for the full YAML', () => {
    assert.equal(
        getFullDefinitionPath('tally-export-config-incremental.yaml'),
        'tally-export-config.yaml'
    );
    assert.equal(
        getFullDefinitionPath('nested/config-incremental.yml'),
        'nested/config.yml'
    );
    assert.equal(
        getFullDefinitionPath('tally-export-config.yaml'),
        'tally-export-config.yaml'
    );
});

test('shouldForceFullSyncOnAlterIdReset only trips when alter_id drops below the stored cursor', () => {
    assert.equal(shouldForceFullSyncOnAlterIdReset(5, 10), true);
    assert.equal(shouldForceFullSyncOnAlterIdReset(10, 10), false);
    assert.equal(shouldForceFullSyncOnAlterIdReset(12, 10), false);
    assert.equal(shouldForceFullSyncOnAlterIdReset(0, 0), false);
});

test('shouldForceFullSyncOnStaleVoucherDate respects the threshold', () => {
    const now = new Date('2026-04-01T12:00:00Z');
    assert.equal(
        shouldForceFullSyncOnStaleVoucherDate(new Date('2026-03-30T11:00:00Z'), now),
        true
    );
    assert.equal(
        shouldForceFullSyncOnStaleVoucherDate(new Date('2026-03-30T13:00:00Z'), now),
        false
    );
    assert.equal(
        shouldForceFullSyncOnStaleVoucherDate(null, now),
        false
    );
});

test('countConsecutiveFailures stops at the first non-failed status', () => {
    assert.equal(countConsecutiveFailures(['failed', 'failed', 'success', 'failed']), 2);
    assert.equal(countConsecutiveFailures(['success', 'failed']), 0);
    assert.equal(countConsecutiveFailures(['failed', 'failed', 'failed']), 3);
});
