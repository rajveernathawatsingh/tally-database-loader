import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import mysql from 'mysql2/promise';
import mssql from 'tedious';
import postgres from 'pg';
import { BigQuery } from '@google-cloud/bigquery';
import { from as pgLoadInto } from 'pg-copy-streams';
import { logger } from './logger.mjs';
let connectionPoolMysql;
class _database {
    config;
    maxQuerySize = 65535; //maximum size of SQL query to be executed
    bigquery = new BigQuery();
    connectionPoolPostgres = null; // initialized lazily in openConnectionPool()
    pgTransactionClient = null;
    pgTransactionRowCounts = {};
    constructor() {
        try {
            this.config = JSON.parse(fs.readFileSync('./config.json', 'utf8'))['database'];
        }
        catch (err) {
            logger.logError('database()', err);
            throw err;
        }
    }
    updateCommandlineConfig(lstConfigs) {
        try {
            if (lstConfigs.has('database-technology'))
                this.config.technology = lstConfigs.get('database-technology') || '';
            if (lstConfigs.has('database-server'))
                this.config.server = lstConfigs.get('database-server') || '';
            if (lstConfigs.has('database-port'))
                this.config.port = parseInt(lstConfigs.get('database-port') || '0');
            if (lstConfigs.has('database-schema'))
                this.config.schema = lstConfigs.get('database-schema') || '';
            if (lstConfigs.has('database-username'))
                this.config.username = lstConfigs.get('database-username') || '';
            if (lstConfigs.has('database-password'))
                this.config.password = lstConfigs.get('database-password') || '';
            if (lstConfigs.has('database-loadmethod'))
                this.config.loadmethod = lstConfigs.get('database-loadmethod') || 'insert';
            if (lstConfigs.has('database-ssl'))
                this.config.ssl = lstConfigs.get('database-ssl') == 'true';
            this.config.technology = this.config.technology.toLowerCase(); //convert technology to lowercase
            //port = 0 [load default port for]
            if (this.config.port == 0) {
                if (this.config.technology == 'mssql')
                    this.config.port = 1433;
                else if (this.config.technology == 'mysql')
                    this.config.port = 3306;
                else if (this.config.technology == 'postgres')
                    this.config.port = 5432;
                else
                    ;
            }
            // initialize Google BigQuery connection
            if (this.config.technology.toLowerCase() == 'bigquery') {
                this.bigquery = new BigQuery({ keyFilename: './bigquery-credentials.json' });
            }
            // modify max query size for different database technology
            if (this.config.technology == 'mysql') {
                this.maxQuerySize = 4194303; //4 MB for MySQL
            }
            else if (this.config.technology == 'postgres') {
                this.maxQuerySize = 16777215; //16 MB for PostgreSQL
            }
        }
        catch (err) {
            logger.logError('database.updateCommandlineConfig()', err);
            throw err;
        }
    }
    async openConnectionPool() {
        return new Promise(async (resolve, reject) => {
            try {
                if (this.config.technology == 'postgres') {
                    if (this.connectionPoolPostgres) {
                        resolve();
                        return;
                    } // already initialized
                    this.connectionPoolPostgres = new postgres.Pool({
                        host: this.config.server,
                        port: this.config.port,
                        database: this.config.schema,
                        user: this.config.username,
                        password: this.config.password,
                        ssl: !this.config.ssl ? false : {
                            rejectUnauthorized: false
                        },
                    });
                    //validate the credentials by making a connection
                    try {
                        let connection = await this.connectionPoolPostgres.connect();
                        connection.release();
                    }
                    catch (err) {
                        let errorMessage = '';
                        let errSystemMessage = typeof err['message'] == 'string' ? err['message'] : '';
                        if (errSystemMessage.startsWith('getaddrinfo ENOTFOUND'))
                            errorMessage = 'Unable to make PostgreSQL connection to servername or IP address';
                        else if (errSystemMessage.startsWith('connect ECONNREFUSED'))
                            errorMessage = 'Unable to make PostgreSQL connection on specified port';
                        else if (errSystemMessage.startsWith('database') && errSystemMessage.endsWith('does not exist'))
                            errorMessage = 'Invalid PostgreSQL database';
                        else if (errSystemMessage.startsWith('password authentication failed for user') || errSystemMessage.includes('There is no user'))
                            errorMessage = 'Invalid PostgreSQL username or password';
                        else if (errSystemMessage == 'The server does not support SSL connections')
                            errorMessage = 'Specified PostgreSQL Database Server does not support secure connection';
                        else if (errSystemMessage.includes('connection is insecure (try using'))
                            errorMessage = 'Database Server does not accept insecure connection. Please set "ssl" as true in config.json';
                        else
                            ;
                        throw (errorMessage || err);
                    }
                }
                else if (this.config.technology == 'mysql') {
                    connectionPoolMysql = mysql.createPool({
                        host: this.config.server,
                        port: this.config.port,
                        database: this.config.schema,
                        user: this.config.username,
                        password: this.config.password,
                        ssl: !this.config.ssl ? undefined : {
                            rejectUnauthorized: false
                        }
                    });
                    try {
                        let connection = await connectionPoolMysql.getConnection();
                        connection.release();
                    }
                    catch (connErr) {
                        let errorMessage = '';
                        if (connErr.code == 'ECONNREFUSED')
                            errorMessage = 'Unable to make MySQL connection on specified port';
                        else if (connErr.code == 'ENOTFOUND')
                            errorMessage = 'Unable to make MySQL connection to servername or IP address';
                        else if (connErr.code == 'ER_BAD_DB_ERROR')
                            errorMessage = 'Invalid MySQL database name';
                        else if (connErr.code == 'ER_ACCESS_DENIED_ERROR')
                            errorMessage = 'Invalid MySQL password';
                        else if (connErr.code == 'ER_NOT_SUPPORTED_AUTH_MODE')
                            errorMessage = 'Invalid MySQL username/password/Authentication';
                        else
                            ;
                        throw errorMessage || connErr;
                    }
                }
                else
                    ;
                resolve();
            }
            catch (err) {
                reject(err);
                logger.logError('database.openConnectionPool()', err);
            }
        });
    }
    ;
    async closeConnectionPool() {
        return new Promise(async (resolve, reject) => {
            try {
                if (this.config.technology == 'postgres') {
                    if (this.connectionPoolPostgres) {
                        await this.connectionPoolPostgres.end();
                        this.connectionPoolPostgres = null;
                    }
                }
                else if (this.config.technology == 'mysql') {
                    if (connectionPoolMysql) {
                        await connectionPoolMysql.end();
                    }
                }
                else
                    ;
                resolve();
            }
            catch (err) {
                reject(err);
                logger.logError('database.closeConnectionPool()', err);
            }
        });
    }
    supportsTransactionalSync() {
        return this.config.technology == 'postgres';
    }
    supportsSyncLog() {
        return this.config.technology == 'postgres';
    }
    supportsMirrorAuditTables() {
        return this.config.technology == 'postgres';
    }
    async ensureSyncLogTable() {
        if (!this.supportsSyncLog()) {
            return;
        }
        await this.executeNonQuery(`CREATE TABLE IF NOT EXISTS sync_log (
                id            SERIAL PRIMARY KEY,
                sync_type     TEXT NOT NULL,
                started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
                completed_at  TIMESTAMPTZ,
                status        TEXT NOT NULL DEFAULT 'running',
                alter_id_from BIGINT,
                alter_id_to   BIGINT,
                rows_upserted JSONB,
                error_message TEXT
            )`);
    }
    async ensureMirrorOrderTables() {
        if (!/^(mssql|mysql|postgres)$/g.test(this.config.technology)) {
            return;
        }
        const postgresQueries = [
            `CREATE TABLE IF NOT EXISTS trn_purchase_order (
                guid            varchar(64) NOT NULL,
                voucher_key     bigint,
                voucher_guid    varchar(64),
                voucher_alter_id bigint,
                voucher_date    date,
                voucher_number  varchar(64),
                party_name      varchar(256),
                party_guid      varchar(64),
                narration       text,
                line_no         int,
                item            varchar(256),
                item_guid       varchar(64),
                quantity        numeric(15,4),
                unit            varchar(32),
                rate            numeric(15,4),
                amount          numeric(17,2),
                order_duedate   date,
                godown          varchar(256),
                godown_guid     varchar(64),
                tracking_number varchar(256)
            )`,
            `CREATE TABLE IF NOT EXISTS trn_sales_order (
                guid            varchar(64) NOT NULL,
                voucher_key     bigint,
                voucher_guid    varchar(64),
                voucher_alter_id bigint,
                voucher_date    date,
                voucher_number  varchar(64),
                party_name      varchar(256),
                party_guid      varchar(64),
                narration       text,
                line_no         int,
                item            varchar(256),
                item_guid       varchar(64),
                quantity        numeric(15,4),
                unit            varchar(32),
                rate            numeric(15,4),
                amount          numeric(17,2),
                order_duedate   date,
                godown          varchar(256),
                godown_guid     varchar(64),
                tracking_number varchar(256)
            )`
        ];
        const mysqlQueries = [
            `CREATE TABLE IF NOT EXISTS trn_purchase_order (
                guid             varchar(64) NOT NULL,
                voucher_key      bigint,
                voucher_guid     varchar(64),
                voucher_alter_id bigint,
                voucher_date     date,
                voucher_number   varchar(64),
                party_name       varchar(256),
                party_guid       varchar(64),
                narration        text,
                line_no          int,
                item             varchar(256),
                item_guid        varchar(64),
                quantity         decimal(15,4),
                unit             varchar(32),
                rate             decimal(15,4),
                amount           decimal(17,2),
                order_duedate    date,
                godown           varchar(256),
                godown_guid      varchar(64),
                tracking_number  varchar(256)
            )`,
            `CREATE TABLE IF NOT EXISTS trn_sales_order (
                guid             varchar(64) NOT NULL,
                voucher_key      bigint,
                voucher_guid     varchar(64),
                voucher_alter_id bigint,
                voucher_date     date,
                voucher_number   varchar(64),
                party_name       varchar(256),
                party_guid       varchar(64),
                narration        text,
                line_no          int,
                item             varchar(256),
                item_guid        varchar(64),
                quantity         decimal(15,4),
                unit             varchar(32),
                rate             decimal(15,4),
                amount           decimal(17,2),
                order_duedate    date,
                godown           varchar(256),
                godown_guid      varchar(64),
                tracking_number  varchar(256)
            )`
        ];
        const mssqlQueries = [
            `IF OBJECT_ID('trn_purchase_order', 'U') IS NULL
             BEGIN
                CREATE TABLE trn_purchase_order (
                    guid             varchar(64) NOT NULL,
                    voucher_key      bigint,
                    voucher_guid     varchar(64),
                    voucher_alter_id bigint,
                    voucher_date     date,
                    voucher_number   varchar(64),
                    party_name       varchar(256),
                    party_guid       varchar(64),
                    narration        varchar(4000),
                    line_no          int,
                    item             varchar(256),
                    item_guid        varchar(64),
                    quantity         decimal(15,4),
                    unit             varchar(32),
                    rate             decimal(15,4),
                    amount           decimal(17,2),
                    order_duedate    date,
                    godown           varchar(256),
                    godown_guid      varchar(64),
                    tracking_number  varchar(256)
                )
             END`,
            `IF OBJECT_ID('trn_sales_order', 'U') IS NULL
             BEGIN
                CREATE TABLE trn_sales_order (
                    guid             varchar(64) NOT NULL,
                    voucher_key      bigint,
                    voucher_guid     varchar(64),
                    voucher_alter_id bigint,
                    voucher_date     date,
                    voucher_number   varchar(64),
                    party_name       varchar(256),
                    party_guid       varchar(64),
                    narration        varchar(4000),
                    line_no          int,
                    item             varchar(256),
                    item_guid        varchar(64),
                    quantity         decimal(15,4),
                    unit             varchar(32),
                    rate             decimal(15,4),
                    amount           decimal(17,2),
                    order_duedate    date,
                    godown           varchar(256),
                    godown_guid      varchar(64),
                    tracking_number  varchar(256)
                )
             END`
        ];
        if (this.config.technology == 'postgres') {
            await this.executeNonQuery(postgresQueries);
        }
        else if (this.config.technology == 'mysql') {
            await this.executeNonQuery(mysqlQueries);
        }
        else if (this.config.technology == 'mssql') {
            await this.executeNonQuery(mssqlQueries);
        }
    }
    async ensureMirrorAuditTables() {
        if (!this.supportsMirrorAuditTables()) {
            return;
        }
        const queries = [
            `CREATE TABLE IF NOT EXISTS _diff (
                guid varchar(64) NOT NULL,
                alterid int
            )`,
            `CREATE TABLE IF NOT EXISTS _delete (
                guid varchar(64) NOT NULL
            )`,
            `CREATE TABLE IF NOT EXISTS _vchnumber (
                guid varchar(64) NOT NULL,
                voucher_number varchar(256)
            )`,
            `ALTER TABLE mst_group ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_group ADD COLUMN IF NOT EXISTS _parent varchar(64)`,
            `ALTER TABLE mst_ledger ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_ledger ADD COLUMN IF NOT EXISTS _parent varchar(64)`,
            `ALTER TABLE mst_vouchertype ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_vouchertype ADD COLUMN IF NOT EXISTS _parent varchar(64)`,
            `ALTER TABLE mst_uom ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_godown ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_godown ADD COLUMN IF NOT EXISTS _parent varchar(64)`,
            `ALTER TABLE mst_stock_category ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_stock_category ADD COLUMN IF NOT EXISTS _parent varchar(64)`,
            `ALTER TABLE mst_stock_group ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_stock_group ADD COLUMN IF NOT EXISTS _parent varchar(64)`,
            `ALTER TABLE mst_stock_item ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_stock_item ADD COLUMN IF NOT EXISTS _parent varchar(64)`,
            `ALTER TABLE mst_stock_item ADD COLUMN IF NOT EXISTS _category varchar(64)`,
            `ALTER TABLE mst_stock_item ADD COLUMN IF NOT EXISTS _uom varchar(64)`,
            `ALTER TABLE mst_stock_item ADD COLUMN IF NOT EXISTS _alternate_uom varchar(64)`,
            `ALTER TABLE mst_cost_category ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_cost_centre ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_cost_centre ADD COLUMN IF NOT EXISTS _parent varchar(64)`,
            `ALTER TABLE mst_attendance_type ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_attendance_type ADD COLUMN IF NOT EXISTS _parent varchar(64)`,
            `ALTER TABLE mst_attendance_type ADD COLUMN IF NOT EXISTS _uom varchar(64)`,
            `ALTER TABLE mst_employee ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_employee ADD COLUMN IF NOT EXISTS _parent varchar(64)`,
            `ALTER TABLE mst_payhead ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE mst_payhead ADD COLUMN IF NOT EXISTS _parent varchar(64)`,
            `ALTER TABLE mst_gst_effective_rate ADD COLUMN IF NOT EXISTS _item varchar(64)`,
            `ALTER TABLE mst_opening_batch_allocation ADD COLUMN IF NOT EXISTS _item varchar(64)`,
            `ALTER TABLE mst_opening_batch_allocation ADD COLUMN IF NOT EXISTS _godown varchar(64)`,
            `ALTER TABLE mst_opening_bill_allocation ADD COLUMN IF NOT EXISTS _ledger varchar(64)`,
            `ALTER TABLE trn_closingstock_ledger ADD COLUMN IF NOT EXISTS _ledger varchar(64)`,
            `ALTER TABLE mst_stockitem_standard_cost ADD COLUMN IF NOT EXISTS _item varchar(64)`,
            `ALTER TABLE mst_stockitem_standard_price ADD COLUMN IF NOT EXISTS _item varchar(64)`,
            `ALTER TABLE trn_voucher ADD COLUMN IF NOT EXISTS alterid int`,
            `ALTER TABLE trn_voucher ADD COLUMN IF NOT EXISTS _voucher_type varchar(64)`,
            `ALTER TABLE trn_voucher ADD COLUMN IF NOT EXISTS _party_name varchar(64)`,
            `ALTER TABLE trn_accounting ADD COLUMN IF NOT EXISTS _ledger varchar(64)`,
            `ALTER TABLE trn_inventory ADD COLUMN IF NOT EXISTS _item varchar(64)`,
            `ALTER TABLE trn_inventory ADD COLUMN IF NOT EXISTS _godown varchar(64)`,
            `ALTER TABLE trn_cost_centre ADD COLUMN IF NOT EXISTS _ledger varchar(64)`,
            `ALTER TABLE trn_cost_centre ADD COLUMN IF NOT EXISTS _costcentre varchar(64)`,
            `ALTER TABLE trn_cost_category_centre ADD COLUMN IF NOT EXISTS _ledger varchar(64)`,
            `ALTER TABLE trn_cost_category_centre ADD COLUMN IF NOT EXISTS _costcategory varchar(64)`,
            `ALTER TABLE trn_cost_category_centre ADD COLUMN IF NOT EXISTS _costcentre varchar(64)`,
            `ALTER TABLE trn_cost_inventory_category_centre ADD COLUMN IF NOT EXISTS _ledger varchar(64)`,
            `ALTER TABLE trn_cost_inventory_category_centre ADD COLUMN IF NOT EXISTS _item varchar(64)`,
            `ALTER TABLE trn_cost_inventory_category_centre ADD COLUMN IF NOT EXISTS _costcategory varchar(64)`,
            `ALTER TABLE trn_cost_inventory_category_centre ADD COLUMN IF NOT EXISTS _costcentre varchar(64)`,
            `ALTER TABLE trn_bill ADD COLUMN IF NOT EXISTS _ledger varchar(64)`,
            `ALTER TABLE trn_bank ADD COLUMN IF NOT EXISTS _ledger varchar(64)`,
            `ALTER TABLE trn_batch ADD COLUMN IF NOT EXISTS _item varchar(64)`,
            `ALTER TABLE trn_batch ADD COLUMN IF NOT EXISTS _godown varchar(64)`,
            `ALTER TABLE trn_batch ADD COLUMN IF NOT EXISTS _destination_godown varchar(64)`,
            `ALTER TABLE trn_inventory_additional_cost ADD COLUMN IF NOT EXISTS _ledger varchar(64)`,
            `ALTER TABLE trn_employee ADD COLUMN IF NOT EXISTS _category varchar(64)`,
            `ALTER TABLE trn_employee ADD COLUMN IF NOT EXISTS _employee_name varchar(64)`,
            `ALTER TABLE trn_payhead ADD COLUMN IF NOT EXISTS _category varchar(64)`,
            `ALTER TABLE trn_payhead ADD COLUMN IF NOT EXISTS _employee_name varchar(64)`,
            `ALTER TABLE trn_payhead ADD COLUMN IF NOT EXISTS _payhead_name varchar(64)`,
            `ALTER TABLE trn_attendance ADD COLUMN IF NOT EXISTS _employee_name varchar(64)`,
            `ALTER TABLE trn_attendance ADD COLUMN IF NOT EXISTS _attendancetype_name varchar(64)`,
            `CREATE TABLE IF NOT EXISTS mst_company (
                company_guid varchar(64) PRIMARY KEY,
                company_name varchar(1024) NOT NULL,
                books_from date,
                period_from date,
                period_to date,
                last_voucher_date date,
                mailing_address text,
                state_name varchar(256),
                country_name varchar(256),
                pincode varchar(32),
                email varchar(256),
                vat_tin varchar(64),
                last_alter_id_master bigint,
                last_alter_id_transaction bigint,
                synced_at timestamptz NOT NULL DEFAULT now()
            )`,
            `ALTER TABLE mst_company ADD COLUMN IF NOT EXISTS mailing_address text`,
            `ALTER TABLE mst_company ADD COLUMN IF NOT EXISTS state_name varchar(256)`,
            `ALTER TABLE mst_company ADD COLUMN IF NOT EXISTS country_name varchar(256)`,
            `ALTER TABLE mst_company ADD COLUMN IF NOT EXISTS pincode varchar(32)`,
            `ALTER TABLE mst_company ADD COLUMN IF NOT EXISTS email varchar(256)`,
            `ALTER TABLE mst_company ADD COLUMN IF NOT EXISTS vat_tin varchar(64)`,
            `CREATE TABLE IF NOT EXISTS trn_voucher_state (
                guid varchar(64) PRIMARY KEY,
                voucher_key varchar(64),
                alterid bigint,
                date date,
                voucher_type varchar(1024),
                _voucher_type varchar(64),
                voucher_number varchar(64),
                reference_number varchar(64),
                reference_date date,
                narration text,
                party_name varchar(256),
                _party_name varchar(64),
                place_of_supply varchar(256),
                is_invoice smallint,
                is_accounting_voucher smallint,
                is_inventory_voucher smallint,
                is_order_voucher smallint,
                is_optional smallint,
                is_cancelled smallint,
                source_sync_log_id bigint,
                last_synced_at timestamptz NOT NULL DEFAULT now()
            )`,
            `CREATE TABLE IF NOT EXISTS trn_voucher_history (
                id bigserial PRIMARY KEY,
                guid varchar(64) NOT NULL,
                alterid bigint,
                voucher_date date,
                voucher_number varchar(64),
                action_type text NOT NULL,
                sync_type text NOT NULL,
                sync_log_id bigint,
                recorded_at timestamptz NOT NULL DEFAULT now(),
                row_hash varchar(32) NOT NULL,
                row_json jsonb NOT NULL
            )`,
            `CREATE TABLE IF NOT EXISTS mst_ledger_history (
                id bigserial PRIMARY KEY,
                guid varchar(64) NOT NULL,
                name varchar(1024),
                alterid bigint,
                action_type text NOT NULL,
                sync_type text NOT NULL,
                sync_log_id bigint,
                recorded_at timestamptz NOT NULL DEFAULT now(),
                row_hash varchar(32) NOT NULL,
                row_json jsonb NOT NULL
            )`,
            `CREATE TABLE IF NOT EXISTS mst_stock_item_history (
                id bigserial PRIMARY KEY,
                guid varchar(64) NOT NULL,
                name varchar(1024),
                alterid bigint,
                action_type text NOT NULL,
                sync_type text NOT NULL,
                sync_log_id bigint,
                recorded_at timestamptz NOT NULL DEFAULT now(),
                row_hash varchar(32) NOT NULL,
                row_json jsonb NOT NULL
            )`,
            `CREATE TABLE IF NOT EXISTS trn_voucher_deleted (
                id bigserial PRIMARY KEY,
                guid varchar(64) NOT NULL,
                alterid bigint,
                voucher_date date,
                voucher_number varchar(64),
                sync_type text NOT NULL,
                sync_log_id bigint,
                deleted_at timestamptz NOT NULL DEFAULT now(),
                row_json jsonb NOT NULL
            )`,
            `CREATE TABLE IF NOT EXISTS mst_deleted (
                id bigserial PRIMARY KEY,
                source_table text NOT NULL,
                guid varchar(64) NOT NULL,
                name varchar(1024),
                alterid bigint,
                sync_type text NOT NULL,
                sync_log_id bigint,
                deleted_at timestamptz NOT NULL DEFAULT now(),
                row_json jsonb NOT NULL
            )`,
            `CREATE TABLE IF NOT EXISTS trn_bill_status_snapshot (
                id bigserial PRIMARY KEY,
                bill_name varchar(1024),
                ledger varchar(1024),
                origin_guid varchar(64),
                origin_voucher_type varchar(1024),
                origin_voucher_number varchar(64),
                bill_date date,
                party_name varchar(256),
                bill_type varchar(256),
                bill_amount decimal(17,2),
                adjusted_amount decimal(17,2),
                pending_amount decimal(17,2),
                source_sync_log_id bigint,
                snapshot_at timestamptz NOT NULL DEFAULT now()
            )`,
            `CREATE TABLE IF NOT EXISTS trn_workflow_link (
                id bigserial PRIMARY KEY,
                link_type text NOT NULL,
                source_voucher_guid varchar(64) NOT NULL,
                target_voucher_guid varchar(64) NOT NULL,
                source_voucher_type varchar(1024),
                target_voucher_type varchar(1024),
                source_date date,
                target_date date,
                party_name varchar(256),
                item varchar(1024),
                tracking_number varchar(256),
                order_number varchar(256),
                source_sync_log_id bigint,
                snapshot_at timestamptz NOT NULL DEFAULT now()
            )`,
            `CREATE TABLE IF NOT EXISTS trn_gst_component (
                id bigserial PRIMARY KEY,
                guid varchar(64) NOT NULL,
                voucher_date date,
                voucher_type varchar(1024),
                voucher_number varchar(64),
                party_name varchar(256),
                ledger varchar(1024),
                duty_head varchar(64),
                component_type varchar(64),
                amount decimal(17,2),
                source_sync_log_id bigint,
                snapshot_at timestamptz NOT NULL DEFAULT now()
            )`,
            `CREATE TABLE IF NOT EXISTS mst_currency (
                currency_code varchar(16) PRIMARY KEY,
                first_voucher_date date,
                last_voucher_date date,
                transaction_count bigint NOT NULL DEFAULT 0,
                forex_row_count bigint NOT NULL DEFAULT 0,
                last_synced_at timestamptz NOT NULL DEFAULT now()
            )`,
            `CREATE TABLE IF NOT EXISTS fx_rate_snapshot (
                id bigserial PRIMARY KEY,
                currency_code varchar(16) NOT NULL,
                voucher_date date NOT NULL,
                sample_count bigint NOT NULL DEFAULT 0,
                avg_rate numeric(18,8),
                min_rate numeric(18,8),
                max_rate numeric(18,8),
                rate_source text NOT NULL DEFAULT 'IMPLIED_FROM_VOUCHER',
                source_sync_log_id bigint,
                snapshot_at timestamptz NOT NULL DEFAULT now()
            )`,
            `CREATE TABLE IF NOT EXISTS sync_table_coverage (
                id bigserial PRIMARY KEY,
                sync_log_id bigint,
                sync_type text NOT NULL,
                table_name varchar(128) NOT NULL,
                collection_name varchar(256),
                table_nature varchar(32),
                is_master smallint NOT NULL DEFAULT 0,
                rows_loaded bigint NOT NULL DEFAULT 0,
                row_count_after bigint NOT NULL DEFAULT 0,
                definition_path text,
                definition_hash varchar(32),
                field_list text,
                fetch_list text,
                filter_text text,
                captures_cancelled smallint NOT NULL DEFAULT 0,
                captures_optional smallint NOT NULL DEFAULT 0,
                recorded_at timestamptz NOT NULL DEFAULT now()
            )`,
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_mst_company_name ON mst_company(company_name)`,
            `CREATE INDEX IF NOT EXISTS idx_trn_voucher_state_flags ON trn_voucher_state(is_cancelled, is_optional, date)`,
            `CREATE INDEX IF NOT EXISTS idx_trn_voucher_state_party ON trn_voucher_state(_party_name, date)`,
            `CREATE INDEX IF NOT EXISTS idx_trn_voucher_history_guid ON trn_voucher_history(guid, id DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_trn_voucher_history_sync ON trn_voucher_history(sync_log_id)`,
            `CREATE INDEX IF NOT EXISTS idx_mst_ledger_history_guid ON mst_ledger_history(guid, id DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_mst_stock_item_history_guid ON mst_stock_item_history(guid, id DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_trn_voucher_deleted_guid ON trn_voucher_deleted(guid, deleted_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_mst_deleted_lookup ON mst_deleted(source_table, guid, deleted_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_trn_bill_status_snapshot_bill ON trn_bill_status_snapshot(ledger, bill_name)`,
            `CREATE INDEX IF NOT EXISTS idx_trn_workflow_link_lookup ON trn_workflow_link(link_type, source_voucher_guid, target_voucher_guid)`,
            `CREATE INDEX IF NOT EXISTS idx_trn_workflow_link_tracking ON trn_workflow_link(tracking_number)`,
            `CREATE INDEX IF NOT EXISTS idx_trn_workflow_link_order_no ON trn_workflow_link(order_number)`,
            `CREATE INDEX IF NOT EXISTS idx_trn_gst_component_guid ON trn_gst_component(guid)`,
            `CREATE INDEX IF NOT EXISTS idx_trn_gst_component_type ON trn_gst_component(component_type, voucher_date)`,
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_fx_rate_snapshot_unique ON fx_rate_snapshot(currency_code, voucher_date, rate_source)`,
            `CREATE INDEX IF NOT EXISTS idx_sync_table_coverage_run ON sync_table_coverage(sync_log_id, table_name)`,
            `CREATE INDEX IF NOT EXISTS idx_sync_table_coverage_table ON sync_table_coverage(table_name, recorded_at DESC)`
        ];
        await this.executeNonQuery(queries);
    }
    convertCSV(content, lstFieldType, doubleQuote = false) {
        let lstLines = content.split(/\r\n/g);
        for (let r = 0; r < lstLines.length; r++) {
            let line = lstLines[r];
            line = line.replace(/ñ/g, ''); //replace blank date with empty text
            line = line.replace(/\"/g, '""'); //escape double quotes with 2 instance of double quotes (as per ISO)
            let lstValues = line.split('\t');
            for (let c = 0; c < lstValues.length; c++) {
                let targetFieldType = lstFieldType[c];
                let targetFieldValue = lstValues[c];
                if (doubleQuote)
                    lstValues[c] = `"${targetFieldValue}"`;
                else if (targetFieldType == 'text' || targetFieldType == 'date')
                    lstValues[c] = `"${targetFieldValue}"`;
            }
            lstLines[r] = lstValues.join(',');
        }
        return lstLines.join('\r\n');
    }
    csvToJsonArray(content, targetTable, lstFieldType) {
        let retval = [];
        try {
            let lstLines = content.split(/\r\n/g);
            let fieldList = lstLines.shift() || ''; //extract header
            let lstFields = fieldList.split(/\t/g);
            for (const line of lstLines) {
                if (line == '')
                    continue;
                let objRow = {};
                let lstValues = line.split(/\t/g);
                for (let f = 0; f < lstFields.length; f++) {
                    const fieldName = lstFields[f];
                    const fieldType = lstFieldType[f];
                    let fieldRawValue = lstValues[f];
                    let fieldValue = undefined;
                    if (fieldRawValue == 'ñ') { //NULL
                        fieldValue = null;
                    }
                    else if (fieldType == 'text') { //Text
                        fieldValue = fieldRawValue;
                    }
                    else if (fieldType == 'number' || fieldType == 'logical' || fieldType == 'amount' || fieldType == 'quantity' || fieldType == 'rate') { //Numeric
                        fieldValue = parseFloat(fieldRawValue);
                        if (isNaN(fieldValue)) {
                            fieldValue = null;
                        }
                    }
                    else if (fieldType == 'date') {
                        fieldValue = fieldRawValue == '' ? null : new Date(fieldRawValue);
                    }
                    Object.defineProperty(objRow, fieldName.trim(), { enumerable: true, value: fieldValue });
                }
                retval.push(objRow);
            }
        }
        catch (err) {
            logger.logError('database.csvToJsonArray()', err);
        }
        return retval;
    }
    jsonToCsv(filePath, tableConfig, lstTableData, emitBOM = false) {
        return new Promise((resolve, reject) => {
            try {
                let writeStream = fs.createWriteStream(filePath, { encoding: 'utf-8' });
                writeStream.on('error', (err) => {
                    reject(err);
                });
                writeStream.on('finish', () => {
                    resolve();
                });
                if (emitBOM) {
                    writeStream.write('\ufeff'); //write BOM for UTF-8
                }
                //write header
                let headerLine = tableConfig.fields.map(p => p.name).join(',');
                writeStream.write(headerLine);
                //write data rows
                for (const row of lstTableData) {
                    let rowLine = '\n';
                    let lstRowValues = [];
                    for (const targetField of tableConfig.fields) {
                        let fieldValue = row[targetField.name];
                        if (fieldValue === null || fieldValue === undefined) {
                            lstRowValues.push('');
                        }
                        else if (typeof fieldValue === 'string') {
                            if (fieldValue.includes('\n') || fieldValue.includes('\r') || fieldValue.includes('\t')) { //strip off new line, carriage return, tab characters
                                fieldValue = fieldValue.replace(/\r/g, '').replace(/\n/g, ' ').replace(/\t/g, ' ');
                            }
                            if (fieldValue.includes('"')) {
                                fieldValue = fieldValue.replace(/"/g, '""'); //escape double quotes with 2 instance of double quotes (as per ISO)
                            }
                            lstRowValues.push(`"${fieldValue}"`);
                        }
                        else if (typeof fieldValue === 'number') {
                            lstRowValues.push(fieldValue.toString());
                        }
                        else if (typeof fieldValue === 'boolean') {
                            lstRowValues.push(fieldValue ? '1' : '0');
                        }
                        else if (fieldValue instanceof Date) {
                            let v = fieldValue.toISOString().split('T')[0];
                            lstRowValues.push(`"${v}"`);
                        }
                    }
                    rowLine += lstRowValues.join(',');
                    writeStream.write(rowLine);
                }
                writeStream.end();
            }
            catch (err) {
                logger.logError(`database.jsonToCsvTsv(${tableConfig.name})`, err);
                reject(err);
            }
        });
    }
    bulkLoad(csvFile, targetTable, lstFieldType, fieldNames) {
        return new Promise(async (resolve, reject) => {
            let sqlQuery = '';
            try {
                sqlQuery = '';
                let rowCount = 0;
                if (this.config.loadmethod == 'insert') { //INSERT query based loading
                    let txtCSV = fs.readFileSync(csvFile, 'utf-8');
                    let lstLines = txtCSV.split(/\r\n/g);
                    let fieldList = lstLines.shift() || ''; //extract header
                    fieldList = fieldList.replace(/\t/g, ','); //replace tab with comma for header
                    while (lstLines.length) { //loop until row is found
                        sqlQuery = `insert into ${targetTable} (${fieldList}) values`;
                        let countBatch = 0; //number of rows in batch
                        //run a loop to keep on appending row to SQL Query values until max allowable size of query is exhausted
                        while (lstLines.length && (sqlQuery.length + lstLines[0].length + 3 < this.maxQuerySize) && ++countBatch <= 1000) {
                            let activeLine = lstLines.shift() || '';
                            let lstValues = activeLine.split('\t');
                            for (let i = 0; i < lstValues.length; i++) {
                                let targetFieldType = lstFieldType[i];
                                let targetFieldValue = lstValues[i];
                                if (targetFieldType == 'text') {
                                    let hasUnicodeText = /[^\u0000-\u007f]/g.test(targetFieldValue);
                                    targetFieldValue = targetFieldValue.replace(/'/g, '\'\''); //escape single quote
                                    if (this.config.technology == 'mysql')
                                        targetFieldValue = targetFieldValue.replace(/\\/g, '\\\\'); //MySQL requires escaping of backslash
                                    targetFieldValue = `'${targetFieldValue}'`; //enclose value in single quotes for SQL query
                                    if (hasUnicodeText && this.config.technology == 'mssql')
                                        targetFieldValue = 'N' + targetFieldValue; //SQL Server requires prefixing quoted text with N if any Unicode character exists in string
                                    lstValues[i] = targetFieldValue;
                                }
                                else if (targetFieldType == 'date') {
                                    lstValues[i] = targetFieldValue == 'ñ' ? 'NULL' : `'${targetFieldValue}'`;
                                }
                                else
                                    ;
                            }
                            activeLine = lstValues.join(','); //prepare SQL statement with values separated by comma
                            sqlQuery += `(${activeLine}),`; //enclose row values into round braces
                        }
                        sqlQuery = sqlQuery.slice(0, -1) + ';'; //remove last trailing comma and append colon
                        rowCount += await this.executeNonQuery(sqlQuery);
                    }
                }
                else { //File based loading
                    //modify file to handle null values for date field
                    if (this.config.technology == 'postgres') {
                        let fileContent = fs.readFileSync(csvFile, 'utf-8');
                        fileContent = fileContent.replace(/ñ/g, 'ø'); //substitute NULL with placeholder
                        fileContent = this.convertCSV(fileContent, lstFieldType);
                        fileContent = fileContent.replace(/\"ø\"/g, ''); //replace placeholder with nothing along with enclosing double quotes
                        fs.writeFileSync(csvFile, '\ufeff' + fileContent);
                    }
                    else if (this.config.technology == 'mysql') {
                        let fileContent = fs.readFileSync(csvFile, 'utf-8');
                        fileContent = fileContent.replace(/ñ/g, 'ø'); //substitute NULL with placeholder
                        fileContent = this.convertCSV(fileContent, lstFieldType, true);
                        fileContent = fileContent.replace(/\"ø\"/g, 'NULL'); //replace placeholder with nothing along with enclosing double quotes
                        fs.writeFileSync(csvFile, '\ufeff' + fileContent); //write desired changes to file
                    }
                    else if (this.config.technology == 'mssql') { //SQL Server
                        let fileContent = fs.readFileSync(csvFile, 'utf-8');
                        fileContent = fileContent.replace(/ñ/g, ''); //substitute NULL with placeholder
                        //fileContent = fileContent.replace(/\"/g, '""'); //escape double quotes
                        fs.writeFileSync(csvFile, '\ufeff' + fileContent + '\r\n'); //write desired changes to file
                    }
                    else
                        ;
                    if (this.config.technology == 'mysql') {
                        rowCount = await this.dumpDataMysql(targetTable, lstFieldType);
                    }
                    else if (this.config.technology == 'mssql') {
                        rowCount = await this.dumpDataMssql(targetTable, lstFieldType);
                    }
                    else if (this.config.technology == 'postgres') {
                        rowCount = await this.dumpDataPostges(targetTable, fieldNames);
                    }
                    else
                        ;
                }
                if (this.pgTransactionClient && this.config.technology == 'postgres' && !targetTable.startsWith('_')) {
                    this.pgTransactionRowCounts[targetTable] = rowCount;
                }
                resolve(rowCount);
            }
            catch (err) {
                // if (typeof err == 'object')
                //     err['targetQuery'] = sqlQuery;
                logger.logError(`database.bulkLoad(${targetTable})`, err);
                reject(err);
            }
        });
    }
    bulkLoadTableJson(targetTable, lstTableData) {
        return new Promise(async (resolve, reject) => {
            let retval = 0;
            try {
                // convert all the boolean fields from true/false to 1/0
                for (const field of targetTable.fields.filter(f => f.datatype == 'logical')) { //iterate only logical fields
                    for (let i = 0; i < lstTableData.length; i++) {
                        lstTableData[i][field.name] = lstTableData[i][field.name] ? 1 : 0;
                    }
                }
                if (this.config.technology == 'mssql') {
                    retval = await this.dumpDataMssqlJson(targetTable, lstTableData);
                }
                else if (this.config.technology == 'postgres') {
                    await this.jsonToCsv(`./csv/${targetTable.name}.data`, targetTable, lstTableData);
                    retval = await this.dumpDataPostges(targetTable.name, targetTable.fields.map((field) => field.name));
                    fs.unlinkSync(`./csv/${targetTable.name}.data`);
                }
                else if (this.config.technology == 'mysql') {
                    retval = await this.dumpDataMysqlJson(targetTable, lstTableData);
                }
                ;
                if (this.pgTransactionClient && this.config.technology == 'postgres' && !targetTable.name.startsWith('_')) {
                    this.pgTransactionRowCounts[targetTable.name] = retval;
                }
                resolve(retval);
            }
            catch (err) {
                logger.logError(`database.bulkLoadTableJson(${targetTable.name})`, err);
                if (this.config.technology == 'postgres') {
                    fs.renameSync(`./csv/${targetTable.name}.data`, `./csv/${targetTable.name}.csv`); //keep the CSV file for debugging
                }
                reject(err);
            }
        });
    }
    async beginTransaction() {
        if (!this.supportsTransactionalSync()) {
            return;
        }
        if (this.pgTransactionClient) {
            throw new Error('Transaction already in progress');
        }
        this.pgTransactionClient = await this.connectionPoolPostgres.connect();
        this.pgTransactionRowCounts = {};
        await this.pgTransactionClient.query('BEGIN');
    }
    async commitTransaction() {
        if (!this.supportsTransactionalSync()) {
            return {};
        }
        if (!this.pgTransactionClient) {
            throw new Error('No transaction in progress');
        }
        try {
            await this.pgTransactionClient.query('COMMIT');
        }
        finally {
            this.pgTransactionClient.release();
            this.pgTransactionClient = null;
        }
        const counts = { ...this.pgTransactionRowCounts };
        this.pgTransactionRowCounts = {};
        return counts;
    }
    async rollbackTransaction() {
        if (!this.supportsTransactionalSync()) {
            return;
        }
        if (!this.pgTransactionClient)
            return;
        try {
            await this.pgTransactionClient.query('ROLLBACK');
        }
        finally {
            this.pgTransactionClient.release();
            this.pgTransactionClient = null;
            this.pgTransactionRowCounts = {};
        }
    }
    executeNonQuery(sqlQuery, values) {
        return new Promise(async (resolve, reject) => {
            try {
                let retval = 0;
                if (this.config.technology.toLowerCase() == 'mysql') {
                    retval = (await this.executeMysql(sqlQuery)).rowCount;
                }
                else if (this.config.technology.toLowerCase() == 'mssql') {
                    retval = (await this.executeMssql(sqlQuery)).rowCount;
                }
                else if (this.config.technology.toLowerCase() == 'postgres') {
                    retval = (await this.executePostgres(sqlQuery)).rowCount;
                }
                else
                    ;
                resolve(retval);
            }
            catch (err) {
                reject(err);
            }
        });
    }
    executeScalar(sqlQuery) {
        return new Promise(async (resolve, reject) => {
            try {
                let retval = undefined;
                if (this.config.technology.toLowerCase() == 'mysql') {
                    let result = await this.executeMysql(sqlQuery);
                    if (Array.isArray(result.data) && result.data.length == 1) {
                        let lstProps = Object.keys(result.data[0]);
                        retval = result.data[0][lstProps[0]];
                    }
                }
                else if (this.config.technology.toLowerCase() == 'mssql') {
                    let result = await this.executeMssql(sqlQuery);
                    if (Array.isArray(result.data) && result.data.length == 1)
                        retval = result.data[0][0].value;
                }
                else if (this.config.technology.toLowerCase() == 'postgres') {
                    let result = await this.executePostgres(sqlQuery);
                    if (Array.isArray(result.data) && result.data.length == 1)
                        retval = result.data[0][0];
                }
                else
                    ;
                resolve(retval);
            }
            catch (err) {
                reject(err);
            }
        });
    }
    truncateTables(lstTables) {
        return new Promise(async (resolve, reject) => {
            try {
                let lstTruncateSQL = [];
                for (let i = 0; i < lstTables.length; i++) {
                    let sqlQuery = `truncate table ${lstTables[i]}`;
                    sqlQuery += ';';
                    lstTruncateSQL.push(sqlQuery);
                }
                await this.executeNonQuery(lstTruncateSQL); //fire all truncate table SQL queries in one go
                resolve();
            }
            catch (err) {
                reject(err);
                logger.logError('database.truncateTables()', err);
            }
        });
    }
    uploadGoogleBigQuery(targetTable) {
        return new Promise(async (resolve, reject) => {
            try {
                const [job] = await this.bigquery.dataset(this.config.schema).table(targetTable).load(`./csv/${targetTable}.csv`, {
                    sourceFormat: 'CSV',
                    skipLeadingRows: 1,
                    writeDisposition: 'WRITE_TRUNCATE'
                });
                let retval = parseInt(job.statistics?.load?.outputRows || '0');
                resolve(retval);
            }
            catch (err) {
                reject(err);
                logger.logError('database.dumpDataBigQuery()', err);
            }
        });
    }
    listDatabaseTables() {
        let retval = [];
        return new Promise(async (resolve, reject) => {
            try {
                if (this.config.technology == 'mssql') {
                    let sqlQuery = `select TABLE_NAME from INFORMATION_SCHEMA.TABLES where TABLE_CATALOG = '${this.config.schema}' and TABLE_TYPE = 'BASE TABLE' order by TABLE_NAME`;
                    let result = await this.readMssql(sqlQuery);
                    for (const row of result) {
                        retval.push(row[0].value);
                    }
                }
                else if (this.config.technology == 'mysql') {
                    let sqlQuery = `select TABLE_NAME from INFORMATION_SCHEMA.TABLES where TABLE_SCHEMA = '${this.config.schema}' order by TABLE_NAME`;
                    let result = await this.executeMysql(sqlQuery);
                    for (const row of result.data) {
                        retval.push(row['TABLE_NAME']);
                    }
                }
                else if (this.config.technology == 'postgres') {
                    let sqlQuery = `select TABLE_NAME from INFORMATION_SCHEMA.TABLES where TABLE_CATALOG = '${this.config.schema}' and TABLE_TYPE = 'BASE TABLE' order by TABLE_NAME`;
                    let result = await this.executePostgres(sqlQuery);
                    for (const row of result.data) {
                        retval.push(row[0]);
                    }
                }
                else
                    ;
                resolve(retval);
            }
            catch (err) {
                reject(err);
                logger.logError('database.listDatabaseTables()', err);
            }
        });
    }
    createDatabaseTables(syncMode) {
        return new Promise(async (resolve, reject) => {
            let scriptFileName = './database-structure.sql';
            if (syncMode == 'incremental')
                scriptFileName = './database-structure-incremental.sql';
            let sqlQuery = fs.readFileSync(scriptFileName, 'utf-8');
            try {
                if (this.config.technology == 'mssql') {
                    await this.executeMssql(sqlQuery);
                }
                else if (this.config.technology == 'mysql') {
                    sqlQuery = sqlQuery.replace(/nvarchar/gi, 'varchar'); //replace nvarchar with varchart for MySQL
                    for (const tblSQL of sqlQuery.split(/;\s*$/gm)) {
                        if (tblSQL.trim() != '')
                            await this.executeMysql(tblSQL.trim());
                    }
                }
                else if (this.config.technology == 'postgres') {
                    sqlQuery = sqlQuery.replace(/nvarchar/gi, 'varchar'); //replace nvarchar with varchart for PostgreSQL
                    sqlQuery = sqlQuery.replace(/tinyint/gi, 'smallint'); //replace tinyint with smallint for PostgreSQL
                    await this.executePostgres(sqlQuery);
                }
                resolve();
            }
            catch (err) {
                reject(err);
                logger.logError('database.createDatabaseTables()', err);
            }
        });
    }
    executeMysql(sqlQuery) {
        return new Promise(async (resolve, reject) => {
            let conn = await connectionPoolMysql.getConnection();
            try {
                let rowCount = 0;
                let data = [];
                if (Array.isArray(sqlQuery)) { //multiple query
                    for (const qry of sqlQuery) {
                        const [result] = await conn.query(qry);
                        rowCount = Array.isArray(result) ? result.length : result.affectedRows;
                        data = Array.isArray(result) ? result : [];
                    }
                }
                else {
                    const [result] = await conn.query(sqlQuery);
                    rowCount = Array.isArray(result) ? result.length : result.affectedRows;
                    data = Array.isArray(result) ? result : [];
                }
                resolve({ rowCount, data });
            }
            catch (err) {
                logger.logError('database.executeMysql()', err);
                reject(err);
            }
            finally {
                connectionPoolMysql.releaseConnection(conn);
            }
        });
    }
    executeMssql(sqlQuery) {
        return new Promise((resolve, reject) => {
            try {
                let connection = new mssql.Connection({
                    server: this.config.server,
                    authentication: {
                        options: {
                            userName: this.config.username,
                            password: this.config.password
                        },
                        type: 'default'
                    },
                    options: {
                        database: this.config.schema,
                        port: this.config.port,
                        trustServerCertificate: true,
                        encrypt: this.config.ssl,
                        rowCollectionOnRequestCompletion: true
                    }
                });
                connection.on('connect', async (connErr) => {
                    if (connErr) {
                        let errorMessage = '';
                        if (connErr.message.includes('getaddrinfo ENOTFOUND'))
                            errorMessage = 'Unable to make SQL Server connection to specified servername or IP address';
                        else if (connErr.message.includes('Could not connect (sequence)'))
                            errorMessage = 'Unable to make SQL Server connection to specified port';
                        else if (connErr.message.includes('Login failed for user'))
                            errorMessage = 'Invalid Database / Username / Password';
                        else
                            ;
                        logger.logError('database.executeMssql()', errorMessage || connErr);
                        reject(connErr);
                    }
                    else {
                        const executeQuery = (qry) => {
                            return new Promise((_resolve, _reject) => {
                                connection.execSql(new mssql.Request(qry, (queryErr, rowCount, rows) => {
                                    if (queryErr)
                                        _reject(queryErr);
                                    else
                                        _resolve({ rowCount: rowCount || 0, data: rows });
                                }));
                            });
                        };
                        let rowCount = 0;
                        let data = [];
                        if (Array.isArray(sqlQuery)) { //multiple query
                            for (const qry of sqlQuery) {
                                await executeQuery(qry);
                            }
                        }
                        else { //single query
                            let result = await executeQuery(sqlQuery);
                            rowCount = result.rowCount;
                            data = result.data || [];
                        }
                        connection.close();
                        resolve({ rowCount, data });
                    }
                });
                connection.connect();
            }
            catch (err) {
                reject(err);
                logger.logError('database.executeMssql()', err);
            }
        });
    }
    executePostgres(sqlQuery) {
        return new Promise(async (resolve, reject) => {
            let connection = null;
            let releaseAfter = false;
            try {
                if (!this.pgTransactionClient && !this.connectionPoolPostgres) {
                    await this.openConnectionPool();
                }
                if (!this.pgTransactionClient && !this.connectionPoolPostgres) {
                    throw new Error('PostgreSQL connection pool is not initialized');
                }
                connection = this.pgTransactionClient ?? await this.connectionPoolPostgres.connect();
                releaseAfter = !this.pgTransactionClient;
                let rowCount = 0;
                let data = [];
                if (Array.isArray(sqlQuery)) { //multiple query
                    for (const qry of sqlQuery) {
                        await connection.query(qry);
                    }
                }
                else { //single query
                    let qryConfig = {
                        rowMode: 'array',
                        text: sqlQuery
                    };
                    let result = await connection.query(qryConfig);
                    rowCount = result.rowCount || 0;
                    data = result.rows;
                }
                resolve({ rowCount, data });
            }
            catch (err) {
                reject(err);
                logger.logError('database.executePostgres()', err);
            }
            finally {
                if (releaseAfter && connection)
                    connection.release();
            }
        });
    }
    readMssql(sqlQuery) {
        return new Promise(async (resolve, reject) => {
            try {
                let connection = new mssql.Connection({
                    server: this.config.server,
                    authentication: {
                        options: {
                            userName: this.config.username,
                            password: this.config.password
                        },
                        type: 'default'
                    },
                    options: {
                        database: this.config.schema,
                        port: this.config.port,
                        trustServerCertificate: true,
                        encrypt: this.config.ssl,
                        rowCollectionOnRequestCompletion: true
                    }
                });
                connection.on('connect', async (connErr) => {
                    if (connErr) {
                        let errorMessage = '';
                        if (connErr.message.includes('getaddrinfo ENOTFOUND'))
                            errorMessage = 'Unable to make SQL Server connection to specified servername or IP address';
                        else if (connErr.message.includes('Could not connect (sequence)'))
                            errorMessage = 'Unable to make SQL Server connection to specified port';
                        else if (connErr.message.includes('Login failed for user'))
                            errorMessage = 'Invalid Database / Username / Password';
                        else
                            ;
                        logger.logError('database.readMssql()', errorMessage || connErr);
                        reject(connErr);
                    }
                    else {
                        let data = [];
                        connection.execSql(new mssql.Request(sqlQuery, (queryErr, rowCount, rows) => {
                            if (queryErr) {
                                reject(queryErr);
                            }
                            else {
                                data = rows;
                                connection.close();
                                resolve(data);
                            }
                        }));
                    }
                });
                connection.connect();
            }
            catch (err) {
                reject(err);
                logger.logError('database.readMssql()', err);
            }
        });
    }
    dumpDataPostges(targetTable, fieldNames) {
        return new Promise(async (resolve, reject) => {
            const connection = this.pgTransactionClient ?? await this.connectionPoolPostgres.connect();
            const releaseAfter = !this.pgTransactionClient;
            try {
                const sourceStream = fs.createReadStream(`./csv/${targetTable}.data`, 'utf-8');
                const columnClause = Array.isArray(fieldNames) && fieldNames.length
                    ? `(${fieldNames.join(',')})`
                    : '';
                let ptrCopyQueryStream = pgLoadInto(`copy ${targetTable} ${columnClause} from stdin csv header;`);
                const targetStream = connection.query(ptrCopyQueryStream);
                await pipeline(sourceStream, targetStream);
                resolve(ptrCopyQueryStream.rowCount || 0);
            }
            catch (err) {
                reject(err);
                logger.logError(`database.dumpDataPostges(${targetTable})`, err);
            }
            finally {
                if (releaseAfter)
                    connection.release();
            }
        });
    }
    dumpDataMysql(targetTable, lstFieldType) {
        return new Promise(async (resolve, reject) => {
            let connection = await mysql.createConnection({
                host: this.config.server,
                port: this.config.port,
                database: this.config.schema,
                user: this.config.username,
                password: this.config.password,
                ssl: !this.config.ssl ? undefined : {
                    rejectUnauthorized: false
                },
                infileStreamFactory: p => fs.createReadStream(p)
            });
            try {
                await connection.connect();
                let sqlQuery = `load data local infile './csv/${targetTable}.data' into table ${targetTable} fields terminated by ',' enclosed by '"' escaped by '' lines terminated by '\r\n' ignore 1 lines ;`;
                let [result] = await connection.execute(sqlQuery);
                resolve(result.affectedRows || 0);
            }
            catch (err) {
                let errorMessage = '';
                if (err && err.code) {
                    if (err.code == 'ECONNREFUSED')
                        errorMessage = 'Unable to make MySQL connection on specified port';
                    else if (err.code == 'ENOTFOUND')
                        errorMessage = 'Unable to make MySQL connection to servername or IP address';
                    else if (err.code == 'ER_BAD_DB_ERROR')
                        errorMessage = 'Invalid MySQL database name';
                    else if (err.code == 'ER_ACCESS_DENIED_ERROR')
                        errorMessage = 'Invalid MySQL password';
                    else if (err.code == 'ER_NOT_SUPPORTED_AUTH_MODE')
                        errorMessage = 'Invalid MySQL username/password/Authentication';
                    else
                        ;
                }
                reject(err);
                logger.logError(`database.dumpDataMysql(${targetTable})`, errorMessage || err);
            }
            finally {
                await connection.end();
            }
        });
    }
    dumpDataMysqlJson(targetTable, lstTableData) {
        return new Promise(async (resolve, reject) => {
            if (!lstTableData.length) { //skip bulk insert if no rows are found
                return resolve(0);
            }
            let conn = await connectionPoolMysql.getConnection();
            try {
                await conn.connect();
                let values = lstTableData.map(row => targetTable.fields.map(field => row[field.name]));
                let sqlQuery = `insert into ${targetTable.name} (${targetTable.fields.map(f => f.name).join(',')}) values ?`;
                let [result] = await conn.query(sqlQuery, [values]);
                resolve(result.affectedRows || 0);
            }
            catch (err) {
                logger.logError(`database.dumpDataMysqlJson(${targetTable.name})`, err);
                this.jsonToCsv(`./csv/${targetTable.name}.csv`, targetTable, lstTableData); //keep the CSV file for debugging
                reject(err);
            }
            finally {
                connectionPoolMysql.releaseConnection(conn);
            }
        });
    }
    dumpDataMssql(targetTable, lstFieldType) {
        return new Promise(async (resolve, reject) => {
            let lstColumnInfo = [];
            try {
                let content = fs.readFileSync(`./csv/${targetTable}.data`, 'utf-8');
                let lstData = this.csvToJsonArray(content, targetTable, lstFieldType);
                if (!lstData.length) { //skip bulk insert if no rows are found
                    return resolve(0);
                }
                lstColumnInfo = await this.populateDatabaseTableInfo(targetTable);
                let connection = new mssql.Connection({
                    server: this.config.server,
                    authentication: {
                        options: {
                            userName: this.config.username,
                            password: this.config.password
                        },
                        type: 'default'
                    },
                    options: {
                        database: this.config.schema,
                        port: this.config.port,
                        trustServerCertificate: true,
                        encrypt: this.config.ssl,
                        rowCollectionOnRequestCompletion: true,
                        requestTimeout: 0
                    }
                });
                connection.on('connect', (connErr) => {
                    connection.on('errorMessage', (msg) => {
                        let errorDescription = '';
                        if (msg.message.includes('invalid column length')) {
                            let regCol = msg.message.match(/\d+/g);
                            let fieldIndex = regCol?.length == 1 ? parseInt(regCol[0]) : -1;
                            let fieldName = lstColumnInfo[fieldIndex].fieldName;
                            errorDescription = `\r\nText value in the field "${fieldName}" is too long to accomodate in database.\r\nConsider increasing the field length in database.`;
                        }
                        logger.logError(`database.dumpDataMssql(${targetTable})`, msg.message + errorDescription);
                        reject(msg);
                    });
                    if (connErr) {
                        let errorMessage = '';
                        if (connErr.message.includes('getaddrinfo ENOTFOUND'))
                            errorMessage = 'Unable to make SQL Server connection to specified servername or IP address';
                        else if (connErr.message.includes('Could not connect (sequence)'))
                            errorMessage = 'Unable to make SQL Server connection to specified port';
                        else if (connErr.message.includes('Login failed for user'))
                            errorMessage = 'Invalid Database / Username / Password';
                        else
                            ;
                        logger.logError('database.dumpDataMssql()', errorMessage || connErr);
                        reject(connErr);
                    }
                    else {
                        const blOptions = { keepNulls: true };
                        const oBulkLoad = connection.newBulkLoad(targetTable, blOptions, function (err, rowCount) {
                            connection.close();
                            if (err) {
                                return reject(err);
                            }
                            else {
                                resolve(rowCount || 0);
                            }
                        });
                        for (const col of lstColumnInfo) {
                            let oColOpts = {
                                nullable: col.isNullable
                            };
                            //set datatype
                            let oColDataType;
                            if (col.dataType == 'varchar')
                                oColDataType = mssql.TYPES.VarChar;
                            else if (col.dataType == 'nvarchar')
                                oColDataType = mssql.TYPES.NVarChar;
                            else if (col.dataType == 'int')
                                oColDataType = mssql.TYPES.Int;
                            else if (col.dataType == 'tinyint')
                                oColDataType = mssql.TYPES.TinyInt;
                            else if (col.dataType == 'decimal')
                                oColDataType = mssql.TYPES.Decimal;
                            else if (col.dataType == 'date')
                                oColDataType = mssql.TYPES.Date;
                            else
                                oColDataType = mssql.TYPES.NVarChar;
                            //set string length for textual datatype
                            if (col.length) {
                                oColOpts.length = col.length;
                            }
                            //set precision for decimal datatype
                            if (col.dataType == 'decimal') {
                                oColOpts.precision = col.precision;
                                oColOpts.scale = col.scale;
                            }
                            oBulkLoad.addColumn(col.fieldName, oColDataType, oColOpts);
                        }
                        connection.execBulkLoad(oBulkLoad, lstData);
                    }
                });
                connection.on('errorMessage', (msg) => {
                    let errorDescription = '';
                    if (msg.message.includes('invalid column length')) {
                        let regCol = msg.message.match(/\d+/g);
                        let fieldIndex = regCol?.length == 1 ? parseInt(regCol[0]) : -1;
                        let fieldName = lstColumnInfo[fieldIndex - 1].fieldName; //-1 as column index in error message is 1-based
                        errorDescription = `\r\nText value in the field "${fieldName}" is too long to accomodate in database.\r\nConsider increasing the field length in database.`;
                    }
                    logger.logError(`database.dumpDataMssql(${targetTable})`, msg.message + errorDescription);
                    reject(msg);
                });
                connection.connect();
            }
            catch (err) {
                reject(err);
                logger.logError('database.dumpDataMssql()', err);
            }
        });
    }
    dumpDataMssqlJson(targetTable, lstTableData) {
        return new Promise(async (resolve, reject) => {
            try {
                if (!lstTableData.length) { //skip bulk insert if no rows are found
                    return resolve(0);
                }
                let lstFieldInfoDB = await this.populateDatabaseTableInfo(targetTable.name);
                let connection = new mssql.Connection({
                    server: this.config.server,
                    authentication: {
                        options: {
                            userName: this.config.username,
                            password: this.config.password
                        },
                        type: 'default'
                    },
                    options: {
                        database: this.config.schema,
                        port: this.config.port,
                        trustServerCertificate: true,
                        encrypt: this.config.ssl,
                        rowCollectionOnRequestCompletion: true,
                        requestTimeout: 0
                    }
                });
                connection.on('connect', (connErr) => {
                    connection.on('errorMessage', (msg) => {
                        let errorDescription = '';
                        if (msg.message.includes('invalid column length')) {
                            let regCol = msg.message.match(/\d+/g);
                            let fieldIndex = regCol?.length == 1 ? parseInt(regCol[0]) : -1;
                            let fieldName = targetTable.fields[fieldIndex - 1].name; //-1 as column index in error message is 1-based
                            errorDescription = `\r\nText value in the field "${fieldName}" is too long to accomodate in database.\r\nConsider increasing the field length in database.`;
                        }
                        logger.logError(`database.dumpDataMssql(${targetTable})`, msg.message + errorDescription);
                        reject(msg);
                    });
                    if (connErr) {
                        let errorMessage = '';
                        if (connErr.message.includes('getaddrinfo ENOTFOUND'))
                            errorMessage = 'Unable to make SQL Server connection to specified servername or IP address';
                        else if (connErr.message.includes('Could not connect (sequence)'))
                            errorMessage = 'Unable to make SQL Server connection to specified port';
                        else if (connErr.message.includes('Login failed for user'))
                            errorMessage = 'Invalid Database / Username / Password';
                        else
                            ;
                        logger.logError('database.dumpDataMssql()', errorMessage || connErr);
                        reject(connErr);
                    }
                    else {
                        const blOptions = { keepNulls: true };
                        const oBulkLoad = connection.newBulkLoad(targetTable.name, blOptions, function (err, rowCount) {
                            connection.close();
                            if (err) {
                                return reject(err);
                            }
                            else {
                                resolve(rowCount || 0);
                            }
                        });
                        for (const col of targetTable.fields) {
                            let dbColumnInfo = lstFieldInfoDB.find(f => f.fieldName.toLowerCase() == col.name.toLowerCase());
                            if (dbColumnInfo) {
                                let oColOpts = {
                                    nullable: dbColumnInfo.isNullable
                                };
                                //set datatype
                                let oColDataType;
                                if (dbColumnInfo.dataType == 'nvarchar')
                                    oColDataType = mssql.TYPES.NVarChar;
                                else if (dbColumnInfo.dataType == 'varchar')
                                    oColDataType = mssql.TYPES.VarChar;
                                else if (dbColumnInfo.dataType == 'decimal')
                                    oColDataType = mssql.TYPES.Decimal;
                                else if (dbColumnInfo.dataType == 'int')
                                    oColDataType = mssql.TYPES.Int;
                                else if (dbColumnInfo.dataType == 'tinyint')
                                    oColDataType = mssql.TYPES.TinyInt;
                                else if (col.datatype == 'date')
                                    oColDataType = mssql.TYPES.Date;
                                else
                                    ;
                                //set string length for textual datatype
                                if (dbColumnInfo.length) {
                                    oColOpts.length = dbColumnInfo.length;
                                }
                                //set precision for decimal datatype
                                if (dbColumnInfo.dataType == 'decimal') {
                                    oColOpts.precision = dbColumnInfo.precision;
                                    oColOpts.scale = dbColumnInfo.scale;
                                }
                                oBulkLoad.addColumn(col.name, oColDataType, oColOpts);
                            }
                            else {
                                return reject(new Error(`Field "${col.name}" not found in database table "${targetTable.name}"`));
                            }
                        }
                        connection.execBulkLoad(oBulkLoad, lstTableData);
                    }
                });
                connection.on('errorMessage', (msg) => {
                    let errorDescription = '';
                    if (msg.message.includes('invalid column length')) {
                        let regCol = msg.message.match(/\d+/g);
                        let fieldIndex = regCol?.length == 1 ? parseInt(regCol[0]) : -1;
                        let fieldName = targetTable.fields[fieldIndex - 1].name; //-1 as column index in error message is 1-based
                        errorDescription = `\r\nText value in the field "${fieldName}" is too long to accomodate in database.\r\nConsider increasing the field length in database.`;
                    }
                    logger.logError(`database.dumpDataMssqlJson(${targetTable.name})`, msg.message + errorDescription);
                    this.jsonToCsv(`./csv/${targetTable.name}.csv`, targetTable, lstTableData); //keep the CSV file for debugging
                    reject(msg);
                });
                connection.connect();
            }
            catch (err) {
                logger.logError(`database.dumpDataMssqlJson(${targetTable.name})`, err);
                this.jsonToCsv(`./csv/${targetTable.name}.csv`, targetTable, lstTableData); //keep the CSV file for debugging
                reject(err);
            }
        });
    }
    populateDatabaseTableInfo(targetTable) {
        let retval = [];
        return new Promise(async (resolve, reject) => {
            try {
                let sqlQuery = `select COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE from INFORMATION_SCHEMA.COLUMNS where TABLE_CATALOG = '${this.config.schema}' and TABLE_NAME = '${targetTable}' order by ORDINAL_POSITION`;
                let result = await this.readMssql(sqlQuery);
                for (const row of result) {
                    let fieldName = row[0].value;
                    let dataType = row[1].value;
                    let isNullable = row[2].value == 'YES';
                    let fieldLength = row[3].value !== null ? parseInt(row[3].value) : 0;
                    let fieldPrecision = row[4].value !== null ? parseInt(row[4].value) : 0;
                    let fieldScale = row[5].value !== null ? parseInt(row[5].value) : 0;
                    let itemFieldInfo = {
                        fieldName,
                        dataType,
                        isNullable
                    };
                    if (fieldLength) {
                        itemFieldInfo.length = fieldLength;
                    }
                    if (fieldPrecision) {
                        itemFieldInfo.precision = fieldPrecision;
                        itemFieldInfo.scale = fieldScale;
                    }
                    retval.push(itemFieldInfo);
                }
                resolve(retval);
            }
            catch (err) {
                reject(err);
                logger.logError('database.populateDatabaseTableInfo()', err);
            }
        });
    }
}
let database = new _database();
export { database };
//# sourceMappingURL=database.mjs.map