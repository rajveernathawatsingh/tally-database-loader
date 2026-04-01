export function getFullDefinitionPath(definitionPath) {
    if (definitionPath.endsWith('-incremental.yaml')) {
        return definitionPath.replace(/-incremental\.yaml$/, '.yaml');
    }
    if (definitionPath.endsWith('-incremental.yml')) {
        return definitionPath.replace(/-incremental\.yml$/, '.yml');
    }
    return definitionPath;
}
export function shouldForceFullSyncOnAlterIdReset(currentAlterId, lastStoredAlterId) {
    return lastStoredAlterId > 0 && currentAlterId >= 0 && currentAlterId < lastStoredAlterId;
}
export function shouldForceFullSyncOnStaleVoucherDate(maxVoucherDate, now = new Date(), thresholdDays = 2) {
    if (!maxVoucherDate) {
        return false;
    }
    const ageInDays = (now.getTime() - maxVoucherDate.getTime()) / (1000 * 60 * 60 * 24);
    return ageInDays > thresholdDays;
}
export function countConsecutiveFailures(statuses) {
    let consecutiveFailures = 0;
    for (const status of statuses) {
        if (status !== 'failed') {
            break;
        }
        consecutiveFailures++;
    }
    return consecutiveFailures;
}
//# sourceMappingURL=reliability.mjs.map