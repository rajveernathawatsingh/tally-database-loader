import { createHash } from 'node:crypto';
export function normalizeCoverageList(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    return values
        .map((value) => typeof value == 'string' ? value.trim() : '')
        .filter((value) => value !== '');
}
export function capturesCancelledVouchers(filters) {
    return !normalizeCoverageList(filters).some((filter) => /\$IsCancelled/i.test(filter));
}
export function capturesOptionalVouchers(filters) {
    return !normalizeCoverageList(filters).some((filter) => /\$IsOptional/i.test(filter));
}
export function buildCoverageDefinitionHash(definition) {
    let hashInput = [
        definition.tableName,
        definition.collectionName,
        definition.definitionPath,
        normalizeCoverageList(definition.fieldList).join(','),
        normalizeCoverageList(definition.fetchList).join(','),
        normalizeCoverageList(definition.filters).join(' && ')
    ].join('|');
    return createHash('md5').update(hashInput, 'utf8').digest('hex');
}
//# sourceMappingURL=source-completeness.mjs.map