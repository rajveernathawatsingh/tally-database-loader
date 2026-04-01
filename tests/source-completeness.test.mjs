import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCoverageDefinitionHash,
    capturesCancelledVouchers,
    capturesOptionalVouchers,
    normalizeCoverageList
} from '../dist/source-completeness.mjs';

test('normalizeCoverageList trims empty values away', () => {
    assert.deepEqual(
        normalizeCoverageList(['  AlterId  ', '', '  ', 'Narration']),
        ['AlterId', 'Narration']
    );
    assert.deepEqual(normalizeCoverageList(undefined), []);
});

test('voucher coverage flags reflect whether IsCancelled and IsOptional are filtered out', () => {
    const filters = ['NOT $IsCancelled', 'NOT $IsOptional', '$AlterID > 10'];
    assert.equal(capturesCancelledVouchers(filters), false);
    assert.equal(capturesOptionalVouchers(filters), false);

    const unfiltered = ['$AlterID > 10'];
    assert.equal(capturesCancelledVouchers(unfiltered), true);
    assert.equal(capturesOptionalVouchers(unfiltered), true);
});

test('buildCoverageDefinitionHash changes when fetch or filter scope changes', () => {
    const base = {
        tableName: 'trn_voucher',
        collectionName: 'Voucher',
        definitionPath: 'tally-export-config-incremental.yaml',
        fieldList: ['guid', 'alterid', 'voucher_number'],
        fetchList: ['AlterId', 'Narration'],
        filters: ['NOT $IsCancelled']
    };

    const sameHash = buildCoverageDefinitionHash(base);
    assert.equal(sameHash, buildCoverageDefinitionHash({ ...base }));
    assert.notEqual(
        sameHash,
        buildCoverageDefinitionHash({ ...base, filters: ['NOT $IsCancelled', 'NOT $IsOptional'] })
    );
    assert.notEqual(
        sameHash,
        buildCoverageDefinitionHash({ ...base, fetchList: ['AlterId', 'ReferenceDate'] })
    );
});
