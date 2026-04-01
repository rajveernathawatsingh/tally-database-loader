import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { tally } from './tally.mjs';
import { database } from './database.mjs';
import { logger } from './logger.mjs';
import { getFullDefinitionPath, shouldForceFullSyncOnAlterIdReset, shouldForceFullSyncOnStaleVoucherDate } from './reliability.mjs';
let isSyncRunning = false;
let lastMasterAlterId = 0;
let lastTransactionAlterId = 0;
function parseCommandlineOptions() {
    let retval = new Map();
    try {
        let lstArgs = process.argv;
        if (lstArgs.length > 2 && lstArgs.length % 2 == 0)
            for (let i = 2; i < lstArgs.length; i += 2) {
                let argName = lstArgs[i];
                let argValue = lstArgs[i + 1];
                if (/^--\w+-\w+$/g.test(argName))
                    retval.set(argName.substr(2), argValue);
            }
    }
    catch (err) {
        logger.logError('index.substituteTDLParameters()', err);
    }
    return retval;
}
async function withDatabaseConnection(work) {
    await database.openConnectionPool();
    try {
        return await work();
    }
    finally {
        await database.closeConnectionPool();
    }
}
async function checkStaleSyncEntries() {
    if (!database.supportsSyncLog()) {
        return false;
    }
    return await withDatabaseConnection(async () => {
        let stuckCount;
        try {
            stuckCount = await database.executeScalar(`SELECT COUNT(*) FROM sync_log
                 WHERE status = 'running'
                   AND started_at < now() - INTERVAL '30 minutes'`) ?? 0;
        }
        catch {
            return false;
        }
        if (stuckCount > 0) {
            logger.logMessage('[startup] Found %d stuck sync_log entries. Marking them failed and forcing a full sync.', stuckCount);
            await database.executeNonQuery(`UPDATE sync_log
                 SET status = 'failed',
                     completed_at = now(),
                     error_message = 'Marked failed on startup — process crashed mid-sync'
                 WHERE status = 'running'
                   AND started_at < now() - INTERVAL '30 minutes'`);
            return true;
        }
        return false;
    });
}
async function getStoredTransactionAlterId() {
    if (tally.config.sync !== 'incremental') {
        return 0;
    }
    return await withDatabaseConnection(async () => {
        try {
            return await database.executeScalar(`SELECT coalesce(max(cast(value as bigint)), 0)
                 FROM config
                 WHERE name = 'Last AlterID Transaction'`) ?? 0;
        }
        catch {
            return 0;
        }
    });
}
async function shouldForceFullForAlterIdReset(lastStoredAlterId, currentAlterId) {
    if (tally.config.sync !== 'incremental' || lastStoredAlterId <= 0) {
        return false;
    }
    const observedAlterId = typeof currentAlterId == 'number'
        ? currentAlterId
        : await tally.getCurrentTransactionAlterId();
    if (shouldForceFullSyncOnAlterIdReset(observedAlterId, lastStoredAlterId)) {
        logger.logMessage('[alter_id reset guard] Tally alter_id (%d) is below stored cursor (%d). Running a full sync instead of incremental.', observedAlterId, lastStoredAlterId);
        return true;
    }
    return false;
}
async function shouldRecoverFromStaleVoucherData() {
    return await withDatabaseConnection(async () => {
        try {
            const maxDate = await database.executeScalar(`SELECT MAX(date) FROM trn_voucher`) ?? null;
            const shouldRecover = shouldForceFullSyncOnStaleVoucherDate(maxDate ? new Date(maxDate) : null);
            if (shouldRecover) {
                logger.logMessage('[stale detection] Latest voucher date is too old for a healthy incremental mirror. Running a full recovery sync.');
            }
            return shouldRecover;
        }
        catch {
            return false;
        }
    });
}
async function maybeWritePersistentFailureAlert() {
    if (!database.supportsSyncLog()) {
        return;
    }
    await withDatabaseConnection(async () => {
        try {
            const rows = await database.executeScalar(`WITH ordered AS (
                    SELECT status,
                           ROW_NUMBER() OVER (ORDER BY started_at DESC, id DESC) AS rn
                    FROM sync_log
                 ),
                 boundary AS (
                    SELECT MIN(rn) AS first_success_rn
                    FROM ordered
                    WHERE status = 'success'
                 )
                 SELECT COUNT(*)
                 FROM ordered
                 WHERE status = 'failed'
                   AND rn < COALESCE((SELECT first_success_rn FROM boundary), 2147483647)`) ?? 0;
            if (rows != 3) {
                return;
            }
            const latestError = await database.executeScalar(`SELECT COALESCE(error_message, 'Unknown error')
                 FROM sync_log
                 WHERE status = 'failed'
                 ORDER BY started_at DESC, id DESC
                 LIMIT 1`) ?? 'Unknown error';
            const alert = `[ALERT] ${rows} consecutive sync failures. Latest error: ${latestError}\n`;
            fs.appendFileSync(path.join(process.cwd(), 'error-log.txt'), `${new Date().toISOString()} ${alert}`);
        }
        catch (err) {
            logger.logMessage('Unable to write the persistent failure alert: %s', err instanceof Error ? err.message : String(err));
        }
    });
}
async function invokeImport() {
    let succeeded = false;
    try {
        isSyncRunning = true;
        await tally.importData();
        logger.logMessage('Import completed successfully [%s]', new Date().toLocaleString());
        succeeded = true;
    }
    catch (err) {
        logger.logMessage('Error in importing data\r\nPlease check error-log.txt file for detailed errors [%s]', new Date().toLocaleString());
    }
    finally {
        isSyncRunning = false;
    }
    return succeeded;
}
async function runSyncCycle(forceFullSync = false) {
    const requestedSync = tally.config.sync;
    const requestedDefinition = tally.config.definition;
    tally.config.sync = forceFullSync ? 'full' : requestedSync;
    tally.config.definition = forceFullSync
        ? getFullDefinitionPath(requestedDefinition)
        : requestedDefinition;
    try {
        const syncSucceeded = await invokeImport();
        if (!syncSucceeded) {
            await maybeWritePersistentFailureAlert();
            return false;
        }
        if (tally.config.sync == 'incremental' && await shouldRecoverFromStaleVoucherData()) {
            return await runSyncCycle(true);
        }
        return true;
    }
    finally {
        tally.config.sync = requestedSync;
        tally.config.definition = requestedDefinition;
    }
}
async function runOneShotSync(forceFullOnStartup) {
    let forceFullThisRun = forceFullOnStartup;
    if (!forceFullThisRun && tally.config.sync == 'incremental') {
        const lastStoredAlterId = await getStoredTransactionAlterId();
        forceFullThisRun = await shouldForceFullForAlterIdReset(lastStoredAlterId);
    }
    return await runSyncCycle(forceFullThisRun);
}
//Update commandline overrides to configuration options
let cmdConfig = parseCommandlineOptions();
database.updateCommandlineConfig(cmdConfig);
tally.updateCommandlineConfig(cmdConfig);
if (tally.config.frequency <= 0) { // on-demand sync
    const forceFullOnStartup = await checkStaleSyncEntries();
    const syncSucceeded = await runOneShotSync(forceFullOnStartup);
    if (!syncSucceeded) {
        process.exitCode = 1;
    }
    logger.closeStreams();
}
else { // continuous sync
    let forceFullOnNextRun = await checkStaleSyncEntries();
    const triggerImport = async () => {
        try {
            if (isSyncRunning) {
                return;
            }
            await tally.updateLastAlterId();
            const currentMasterAlterId = tally.lastAlterIdMaster;
            const currentTransactionAlterId = tally.lastAlterIdTransaction;
            let isDataChanged = !(lastMasterAlterId == currentMasterAlterId && lastTransactionAlterId == currentTransactionAlterId);
            if (forceFullOnNextRun || isDataChanged) {
                let forceFullThisRun = forceFullOnNextRun;
                if (!forceFullThisRun && tally.config.sync == 'incremental') {
                    const lastStoredAlterId = await getStoredTransactionAlterId();
                    forceFullThisRun = await shouldForceFullForAlterIdReset(lastStoredAlterId, currentTransactionAlterId);
                }
                const syncSucceeded = await runSyncCycle(forceFullThisRun);
                if (syncSucceeded) {
                    lastMasterAlterId = currentMasterAlterId;
                    lastTransactionAlterId = currentTransactionAlterId;
                    forceFullOnNextRun = false;
                }
                else if (forceFullThisRun) {
                    forceFullOnNextRun = true;
                }
            }
            else {
                logger.logMessage('No change in Tally data found [%s]', new Date().toLocaleString());
            }
        }
        catch (err) {
            if (typeof err == 'string' && err.endsWith('is closed in Tally')) {
                logger.logMessage(err + ' [%s]', new Date().toLocaleString());
            }
            else {
                throw err;
            }
        }
    };
    if (!tally.config.company) { // do not process continuous sync for blank company
        logger.logMessage('Continuous sync requires Tally company name to be specified in config.json');
    }
    else { // go ahead with continuous sync
        setInterval(async () => await triggerImport(), tally.config.frequency * 60000);
        await triggerImport();
    }
}
//# sourceMappingURL=index.mjs.map