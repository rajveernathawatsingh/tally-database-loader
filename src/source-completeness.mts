import { createHash } from 'node:crypto';

export interface sourceCoverageDefinition {
    tableName: string;
    collectionName: string;
    definitionPath: string;
    fieldList: string[];
    fetchList?: string[];
    filters?: string[];
}

export function normalizeCoverageList(values?: string[]): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return values
        .map((value) => typeof value == 'string' ? value.trim() : '')
        .filter((value) => value !== '');
}

export function capturesCancelledVouchers(filters?: string[]): boolean {
    return !normalizeCoverageList(filters).some((filter) => /\$IsCancelled/i.test(filter));
}

export function capturesOptionalVouchers(filters?: string[]): boolean {
    return !normalizeCoverageList(filters).some((filter) => /\$IsOptional/i.test(filter));
}

export function buildCoverageDefinitionHash(definition: sourceCoverageDefinition): string {
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
