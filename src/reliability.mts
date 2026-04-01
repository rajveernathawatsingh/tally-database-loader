export function getFullDefinitionPath(definitionPath: string): string {
    if (definitionPath.endsWith('-incremental.yaml')) {
        return definitionPath.replace(/-incremental\.yaml$/, '.yaml');
    }
    if (definitionPath.endsWith('-incremental.yml')) {
        return definitionPath.replace(/-incremental\.yml$/, '.yml');
    }
    return definitionPath;
}

export function shouldForceFullSyncOnAlterIdReset(currentAlterId: number, lastStoredAlterId: number): boolean {
    return lastStoredAlterId > 0 && currentAlterId >= 0 && currentAlterId < lastStoredAlterId;
}

export function shouldForceFullSyncOnStaleVoucherDate(maxVoucherDate: Date | null, now: Date = new Date(), thresholdDays: number = 2): boolean {
    if (!maxVoucherDate) {
        return false;
    }

    const ageInDays = (now.getTime() - maxVoucherDate.getTime()) / (1000 * 60 * 60 * 24);
    return ageInDays > thresholdDays;
}

export function countConsecutiveFailures(statuses: string[]): number {
    let consecutiveFailures = 0;
    for (const status of statuses) {
        if (status !== 'failed') {
            break;
        }
        consecutiveFailures++;
    }
    return consecutiveFailures;
}
