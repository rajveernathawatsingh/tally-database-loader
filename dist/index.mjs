import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { tally } from './tally.mjs';
import { database } from './database.mjs';
import { logger } from './logger.mjs';
let isSyncRunning = false;
let lastMasterAlterId = 0;
let lastTransactionAlterId = 0;
let consecutiveFailures = 0;
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
async function checkStaleSyncEntries() {
    // Find any sync_log entries stuck in 'running' for > 30 minutes
    // Skip gracefully on first run before sync_log table exists
    let stuckCount;
    try {
        stuckCount = await database.executeScalar(`SELECT COUNT(*) FROM sync_log
             WHERE status = 'running'
             AND started_at < now() - INTERVAL '30 minutes'`) ?? 0;
    }
    catch {
        return; // sync_log table doesn't exist yet (fresh install) — nothing to check
    }
    if (stuckCount > 0) {
        console.log(`[startup] Found ${stuckCount} stuck sync_log entries — marking failed and forcing full sync`);
        await database.executeNonQuery(`UPDATE sync_log
             SET status = 'failed',
                 completed_at = now(),
                 error_message = 'Marked failed on startup — process crashed mid-sync'
             WHERE status = 'running'
             AND started_at < now() - INTERVAL '30 minutes'`);
        // Force full sync by overriding config
        tally.config.sync = 'full';
    }
}
async function checkAlterIdReset(lastStoredAlterId) {
    // Fetch current alter_id from Tally
    const currentAlterId = await tally.getCurrentTransactionAlterId();
    if (currentAlterId < lastStoredAlterId) {
        console.log(`[alter_id reset guard] Tally alter_id (${currentAlterId}) < stored (${lastStoredAlterId}) — Tally restarted. Forcing full sync.`);
        tally.config.sync = 'full';
        return true;
    }
    return false;
}
async function checkStaleData() {
    const maxDate = await database.executeScalar(`SELECT MAX(date) FROM trn_voucher`);
    if (!maxDate)
        return; // empty DB is fine on first run
    const daysSinceLastVoucher = (Date.now() - new Date(maxDate).getTime()) / (1000 * 60 * 60 * 24);
    // Allow 2 days gap (weekends), trigger full sync if more
    if (daysSinceLastVoucher > 2) {
        console.log(`[stale detection] Latest voucher is ${daysSinceLastVoucher.toFixed(1)} days old. Forcing full sync.`);
        tally.config.sync = 'full';
    }
}
function invokeImport() {
    return new Promise(async (resolve) => {
        let succeeded = false;
        try {
            isSyncRunning = true;
            await tally.importData();
            logger.logMessage('Import completed successfully [%s]', new Date().toLocaleString());
            consecutiveFailures = 0;
            succeeded = true;
        }
        catch (err) {
            logger.logMessage('Error in importing data\r\nPlease check error-log.txt file for detailed errors [%s]', new Date().toLocaleString());
            consecutiveFailures++;
            if (consecutiveFailures >= 3) {
                const msg = `[ALERT] ${consecutiveFailures} consecutive sync failures. Last error: ${err instanceof Error ? err.message : String(err)}\n`;
                fs.appendFileSync(path.join(process.cwd(), 'error-log.txt'), `${new Date().toISOString()} ${msg}`);
            }
        }
        finally {
            isSyncRunning = false;
            resolve(succeeded);
        }
    });
}
//Update commandline overrides to configuration options
let cmdConfig = parseCommandlineOptions();
database.updateCommandlineConfig(cmdConfig);
tally.updateCommandlineConfig(cmdConfig);
if (tally.config.frequency <= 0) { // on-demand sync
    // On startup: fix any crashed sync_log entries from previous run
    await database.openConnectionPool();
    await checkStaleSyncEntries();
    await invokeImport();
    logger.closeStreams();
}
else { // continuous sync
    const triggerImport = async () => {
        try {
            // skip if sync is already running (wait for next trigger)
            if (!isSyncRunning) {
                await tally.updateLastAlterId();
                let isDataChanged = !(lastMasterAlterId == tally.lastAlterIdMaster && lastTransactionAlterId == tally.lastAlterIdTransaction);
                if (isDataChanged) { // process only if data is changed
                    //update local variable copy of last alter ID
                    lastMasterAlterId = tally.lastAlterIdMaster;
                    lastTransactionAlterId = tally.lastAlterIdTransaction;
                    // Capture pre-sync alter_id before importData() overwrites it
                    const preSyncAlterIdStored = await database.executeScalar(`SELECT coalesce(max(cast(value as bigint)), 0) FROM config WHERE name = 'Last AlterID Transaction'`) ?? 0;
                    const syncSucceeded = await invokeImport();
                    // After incremental: check for Tally restart and stale data (only on success)
                    if (syncSucceeded && tally.config.sync === 'incremental') {
                        await checkAlterIdReset(preSyncAlterIdStored);
                        await checkStaleData();
                    }
                }
                else {
                    logger.logMessage('No change in Tally data found [%s]', new Date().toLocaleString());
                }
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
        // On startup: fix any crashed sync_log entries from previous run
        await database.openConnectionPool();
        await checkStaleSyncEntries();
        setInterval(async () => await triggerImport(), tally.config.frequency * 60000);
        await triggerImport();
    }
}
//# sourceMappingURL=index.mjs.map