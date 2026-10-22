const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
    DB_FILE_PATH,
    AUDIT_LOG_PATH,
    SQLITE_DB_PATH,
    DB_TMP_FILE_PATH,
    AUDIT_TMP_LOG_PATH
} = require('../config/providers');
const { INITIAL_DB } = require('../config/initialDb');

let dbInstance = null;

/**
 * Initializes and returns the embedded SQLite database singleton.
 * Configures Write-Ahead Logging (WAL) mode and full ACID guarantees.
 */
function getSqliteDb(customPath = null) {
    if (dbInstance && !customPath) {
        return dbInstance;
    }

    const dbPath = customPath || SQLITE_DB_PATH;
    const isNew = !fs.existsSync(dbPath);

    const db = new Database(dbPath, {
        fileMustExist: false,
        timeout: 5000
    });

    // Configure SQLite PRAGMAs for high-performance ACID reliability
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    createTables(db);

    if (isNew || isDatabaseEmpty(db)) {
        seedDatabaseFromSources(db);
    }

    if (!customPath) {
        dbInstance = db;
    }

    return db;
}

/**
 * Closes the active SQLite database instance (useful for clean test teardowns).
 */
function closeSqliteDb() {
    if (dbInstance) {
        try {
            dbInstance.close();
        } catch (_) {}
        dbInstance = null;
    }
}

/**
 * Creates structured tables for accounts, contacts, bills, transactions, and audit_logs.
 */
function createTables(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            balance INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'IQD',
            wallet_provider TEXT DEFAULT 'VI',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS contacts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            alias TEXT,
            phone TEXT NOT NULL,
            wallet_provider TEXT DEFAULT 'VI',
            avatar TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS bills (
            id TEXT PRIMARY KEY,
            biller TEXT NOT NULL,
            account_number TEXT NOT NULL,
            amount INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'unpaid',
            due_date TEXT,
            category TEXT,
            icon TEXT,
            paid_at TEXT
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT,
            type TEXT NOT NULL,
            recipient TEXT,
            sender TEXT,
            phone TEXT,
            amount INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'IQD',
            status TEXT NOT NULL DEFAULT 'SUCCESS',
            date TEXT NOT NULL,
            timestamp TEXT DEFAULT (datetime('now')),
            note TEXT
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            session_id TEXT NOT NULL,
            action_type TEXT NOT NULL,
            source_account TEXT NOT NULL,
            destination TEXT,
            amount INTEGER DEFAULT 0,
            currency TEXT DEFAULT 'IQD',
            idempotency_key TEXT,
            execution_status TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions(idempotency_key);
        CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_logs(session_id);
    `);
}

function isDatabaseEmpty(db) {
    const row = db.prepare('SELECT COUNT(*) as count FROM accounts').get();
    return !row || row.count === 0;
}

/**
 * Automatic one-time database seeder that migrates existing data from
 * backend/mock_wallet_db.json and backend/audit_trail.json upon startup if database is empty.
 */
function seedDatabaseFromSources(db, customSource = null) {
    let sourceData = customSource || INITIAL_DB;
    if (!customSource) {
        try {
            if (fs.existsSync(DB_FILE_PATH)) {
                const raw = fs.readFileSync(DB_FILE_PATH, 'utf8').trim();
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.user) {
                        sourceData = parsed;
                    }
                }
            }
        } catch (err) {
            console.warn('[SQLite Seeder] Error reading mock_wallet_db.json, using INITIAL_DB:', err.message);
        }
    }

    const seedTx = db.transaction(() => {
        // Clear existing rows
        db.prepare('DELETE FROM accounts').run();
        db.prepare('DELETE FROM contacts').run();
        db.prepare('DELETE FROM bills').run();
        db.prepare('DELETE FROM transactions').run();

        // 1. User Account
        const u = sourceData.user || INITIAL_DB.user;
        db.prepare(`
            INSERT INTO accounts (id, name, phone, balance, currency, wallet_provider)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            u.id || 'usr_1001',
            u.name || 'محمد',
            u.phone || '+9647801234567',
            Number(u.balance !== undefined ? u.balance : 3000000),
            u.currency || 'IQD',
            u.wallet_provider || 'VI'
        );

        // 2. Contacts
        const contacts = Array.isArray(sourceData.contacts) ? sourceData.contacts : INITIAL_DB.contacts;
        const insertContact = db.prepare(`
            INSERT INTO contacts (id, name, alias, phone, wallet_provider)
            VALUES (?, ?, ?, ?, ?)
        `);
        for (const c of contacts) {
            insertContact.run(c.id, c.name, c.alias || c.name, c.phone, c.wallet_provider || 'VI');
        }

        // 3. Bills
        const bills = Array.isArray(sourceData.bills) ? sourceData.bills : INITIAL_DB.bills;
        const insertBill = db.prepare(`
            INSERT INTO bills (id, biller, account_number, amount, status)
            VALUES (?, ?, ?, ?, ?)
        `);
        for (const b of bills) {
            insertBill.run(b.id, b.biller, b.account_number || '', Number(b.amount || 0), b.status || 'unpaid');
        }

        // 4. Transactions
        const txs = Array.isArray(sourceData.recent_transactions) ? sourceData.recent_transactions : [];
        const insertTx = db.prepare(`
            INSERT INTO transactions (id, idempotency_key, type, recipient, phone, amount, currency, status, date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const t of txs) {
            insertTx.run(
                t.id,
                t.idempotency_key || null,
                t.type || 'TRANSFER',
                t.recipient || '',
                t.phone || '',
                Number(t.amount || 0),
                t.currency || 'IQD',
                t.status || 'SUCCESS',
                t.date || new Date().toISOString().split('T')[0]
            );
        }

        // 5. Audit Logs migration
        if (fs.existsSync(AUDIT_LOG_PATH)) {
            try {
                const rawAudit = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trim();
                const auditEntries = JSON.parse(rawAudit || '[]');
                if (Array.isArray(auditEntries) && auditEntries.length > 0) {
                    const insertAudit = db.prepare(`
                        INSERT OR IGNORE INTO audit_logs (id, timestamp, session_id, action_type, source_account, destination, amount, currency, idempotency_key, execution_status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    for (const a of auditEntries) {
                        insertAudit.run(
                            a.id || `audit_${Date.now()}`,
                            a.timestamp || new Date().toISOString(),
                            a.sessionId || 'default_session',
                            a.actionType || 'UNKNOWN',
                            a.sourceAccount || 'usr_1001',
                            a.destination || '',
                            Number(a.amount || 0),
                            a.currency || 'IQD',
                            a.idempotencyKey || null,
                            a.executionStatus || 'SUCCESS'
                        );
                    }
                }
            } catch (auditErr) {
                console.warn('[SQLite Seeder] Error migrating audit_trail.json:', auditErr.message);
            }
        }
    });

    seedTx();
    console.log('[SQLite Seeder] Successfully seeded database from existing JSON stores with full ACID integrity.');
}

/**
 * Synchronous JSON compatibility layer: Exports SQLite structured tables
 * into the exact JSON schema expected by legacy readers and existing regression tests.
 */
function exportSqliteToJson(db = null) {
    const activeDb = db || getSqliteDb();

    const userRow = activeDb.prepare('SELECT id, name, phone, balance, currency, wallet_provider FROM accounts LIMIT 1').get();
    const contactsRows = activeDb.prepare('SELECT id, name, alias, phone, wallet_provider FROM contacts').all();
    const billsRows = activeDb.prepare('SELECT id, biller, account_number, amount, status FROM bills').all();
    const txRows = activeDb.prepare('SELECT id, idempotency_key, type, recipient, phone, amount, currency, status, date FROM transactions ORDER BY rowid DESC').all();

    const dbObject = {
        user: userRow ? {
            id: userRow.id,
            name: userRow.name,
            phone: userRow.phone,
            balance: Number(userRow.balance),
            currency: userRow.currency,
            wallet_provider: userRow.wallet_provider
        } : INITIAL_DB.user,
        contacts: contactsRows.map(c => ({
            id: c.id,
            name: c.name,
            alias: c.alias,
            phone: c.phone,
            wallet_provider: c.wallet_provider
        })),
        bills: billsRows.map(b => ({
            id: b.id,
            biller: b.biller,
            account_number: b.account_number,
            amount: Number(b.amount),
            status: b.status
        })),
        recent_transactions: txRows.map(t => ({
            id: t.id,
            ...(t.idempotency_key && { idempotency_key: t.idempotency_key }),
            type: t.type,
            recipient: t.recipient,
            phone: t.phone,
            amount: Number(t.amount),
            currency: t.currency,
            status: t.status,
            date: t.date
        }))
    };

    // Atomic write to JSON file for backward compatibility
    try {
        fs.writeFileSync(DB_TMP_FILE_PATH, JSON.stringify(dbObject, null, 2), 'utf8');
        try {
            fs.renameSync(DB_TMP_FILE_PATH, DB_FILE_PATH);
        } catch (renameErr) {
            if (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') {
                fs.copyFileSync(DB_TMP_FILE_PATH, DB_FILE_PATH);
                try { fs.unlinkSync(DB_TMP_FILE_PATH); } catch (_) {}
            }
        }
    } catch (writeErr) {
        console.error('[SQLite Export Error] Failed to sync mock_wallet_db.json:', writeErr.message);
    }

    return dbObject;
}

/**
 * Synchronous export of SQLite audit_logs table to audit_trail.json.
 */
function exportAuditSqliteToJson(db = null) {
    const activeDb = db || getSqliteDb();
    const rows = activeDb.prepare('SELECT id, timestamp, session_id, action_type, source_account, destination, amount, currency, idempotency_key, execution_status FROM audit_logs ORDER BY rowid ASC').all();

    const auditArray = rows.map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        sessionId: r.session_id,
        actionType: r.action_type,
        sourceAccount: r.source_account,
        destination: r.destination,
        amount: Number(r.amount || 0),
        currency: r.currency,
        idempotencyKey: r.idempotency_key,
        executionStatus: r.execution_status
    }));

    try {
        fs.writeFileSync(AUDIT_TMP_LOG_PATH, JSON.stringify(auditArray, null, 2), 'utf8');
        try {
            fs.renameSync(AUDIT_TMP_LOG_PATH, AUDIT_LOG_PATH);
        } catch (renameErr) {
            if (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') {
                fs.copyFileSync(AUDIT_TMP_LOG_PATH, AUDIT_LOG_PATH);
                try { fs.unlinkSync(AUDIT_TMP_LOG_PATH); } catch (_) {}
            }
        }
    } catch (err) {
        console.error('[SQLite Audit Export Error]:', err.message);
    }

    return auditArray;
}

/**
 * Replaces SQLite state from a provided JavaScript object and exports to JSON.
 */
function syncSqliteWithJsonObject(data, db = null) {
    const activeDb = db || getSqliteDb();

    const tx = activeDb.transaction(() => {
        if (data.user) {
            activeDb.prepare(`
                INSERT OR REPLACE INTO accounts (id, name, phone, balance, currency, wallet_provider, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            `).run(
                data.user.id || 'usr_1001',
                data.user.name || 'محمد',
                data.user.phone || '+9647801234567',
                Number(data.user.balance !== undefined ? data.user.balance : 3000000),
                data.user.currency || 'IQD',
                data.user.wallet_provider || 'VI'
            );
        }

        if (Array.isArray(data.contacts)) {
            activeDb.prepare('DELETE FROM contacts').run();
            const insert = activeDb.prepare(`
                INSERT INTO contacts (id, name, alias, phone, wallet_provider)
                VALUES (?, ?, ?, ?, ?)
            `);
            for (const c of data.contacts) {
                insert.run(c.id, c.name, c.alias || c.name, c.phone, c.wallet_provider || 'VI');
            }
        }

        if (Array.isArray(data.bills)) {
            activeDb.prepare('DELETE FROM bills').run();
            const insert = activeDb.prepare(`
                INSERT INTO bills (id, biller, account_number, amount, status)
                VALUES (?, ?, ?, ?, ?)
            `);
            for (const b of data.bills) {
                insert.run(b.id, b.biller, b.account_number || '', Number(b.amount || 0), b.status || 'unpaid');
            }
        }

        if (Array.isArray(data.recent_transactions)) {
            activeDb.prepare('DELETE FROM transactions').run();
            const insert = activeDb.prepare(`
                INSERT INTO transactions (id, idempotency_key, type, recipient, phone, amount, currency, status, date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const t of data.recent_transactions) {
                insert.run(
                    t.id,
                    t.idempotency_key || null,
                    t.type || 'TRANSFER',
                    t.recipient || '',
                    t.phone || '',
                    Number(t.amount || 0),
                    t.currency || 'IQD',
                    t.status || 'SUCCESS',
                    t.date || new Date().toISOString().split('T')[0]
                );
            }
        }
    });

    tx();
    exportSqliteToJson(activeDb);
}

/**
 * Executes a financial transfer mutation inside an explicit ACID transaction (BEGIN / COMMIT / ROLLBACK).
 * Guarantees atomicity and eliminates race conditions under concurrent requests.
 */
function executeTransferTransaction({ recipient, amount, phone, idempotency_key, sessionId }) {
    const db = getSqliteDb();
    const key = idempotency_key || null;
    const dest = phone ? `${recipient || 'Unknown'} (${phone})` : (recipient || 'Unknown Recipient');
    const sid = sessionId || 'default_session';

    // 1. Idempotency Check: Replay cached transaction if key already exists
    if (key) {
        const existing = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?').get(key);
        if (existing) {
            const acc = db.prepare('SELECT balance, currency, id FROM accounts LIMIT 1').get();
            const existingTx = {
                id: existing.id,
                idempotency_key: existing.idempotency_key,
                type: existing.type,
                recipient: existing.recipient,
                phone: existing.phone,
                amount: Number(existing.amount),
                currency: existing.currency,
                status: existing.status,
                date: existing.date
            };

            // Append audit log for replay
            recordAuditEntry(db, {
                sessionId: sid,
                actionType: 'TRANSFER',
                sourceAccount: acc ? acc.id : 'usr_1001',
                destination: dest,
                amount: existingTx.amount,
                currency: existingTx.currency,
                idempotencyKey: key,
                executionStatus: 'SUCCESS'
            });

            return {
                success: true,
                newBalance: Number(acc.balance),
                transaction: existingTx,
                cached: true,
                idempotent: true
            };
        }
    }

    // 2. Financial Validation
    const numericAmount = Number(amount);
    const accBefore = db.prepare('SELECT id, balance, currency FROM accounts LIMIT 1').get();
    const currentBalance = accBefore ? Number(accBefore.balance) : 0;
    const curr = accBefore ? accBefore.currency : 'IQD';
    const accId = accBefore ? accBefore.id : 'usr_1001';

    if (isNaN(numericAmount) || !Number.isFinite(numericAmount) || numericAmount <= 0) {
        recordAuditEntry(db, {
            sessionId: sid,
            actionType: 'TRANSFER',
            sourceAccount: accId,
            destination: dest,
            amount: isNaN(numericAmount) ? 0 : numericAmount,
            currency: curr,
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error(`Invalid transfer amount: ${amount}`);
    }

    if (!Number.isInteger(numericAmount)) {
        recordAuditEntry(db, {
            sessionId: sid,
            actionType: 'TRANSFER',
            sourceAccount: accId,
            destination: dest,
            amount: numericAmount,
            currency: curr,
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error(`Transfer amount must be an integer, received fractional amount: ${amount}`);
    }

    if (numericAmount < 250) {
        recordAuditEntry(db, {
            sessionId: sid,
            actionType: 'TRANSFER',
            sourceAccount: accId,
            destination: dest,
            amount: numericAmount,
            currency: curr,
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error(`Transfer amount (${numericAmount} IQD) is below minimum allowed threshold (250 IQD).`);
    }

    if (currentBalance < numericAmount) {
        recordAuditEntry(db, {
            sessionId: sid,
            actionType: 'TRANSFER',
            sourceAccount: accId,
            destination: dest,
            amount: numericAmount,
            currency: curr,
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error(`Insufficient balance: current balance (${currentBalance} IQD) is less than transfer amount (${numericAmount} IQD).`);
    }

    const trxId = `trx_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const dateStr = new Date().toISOString().split('T')[0];

    const newTrx = {
        id: trxId,
        idempotency_key: key,
        type: 'TRANSFER',
        recipient: recipient || 'Unknown Recipient',
        phone: phone || '',
        amount: numericAmount,
        currency: curr,
        status: 'SUCCESS',
        date: dateStr
    };

    // 3. ATOMIC ACID TRANSACTION: Deduct balance + Insert transaction + Insert audit log
    const transferTx = db.transaction(() => {
        // Balance deduction
        const updateResult = db.prepare(`
            UPDATE accounts
            SET balance = balance - ?, updated_at = datetime('now')
            WHERE id = ? AND balance >= ?
        `).run(numericAmount, accId, numericAmount);

        if (updateResult.changes === 0) {
            throw new Error(`Insufficient balance or account not found during atomic deduction.`);
        }

        // Insert transaction ledger record
        db.prepare(`
            INSERT INTO transactions (id, idempotency_key, type, recipient, sender, phone, amount, currency, status, date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            newTrx.id,
            newTrx.idempotency_key,
            newTrx.type,
            newTrx.recipient,
            accBefore.name || 'محمد',
            newTrx.phone,
            newTrx.amount,
            newTrx.currency,
            newTrx.status,
            newTrx.date
        );

        // Record audit trail inside same transaction
        const auditId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        db.prepare(`
            INSERT INTO audit_logs (id, timestamp, session_id, action_type, source_account, destination, amount, currency, idempotency_key, execution_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            auditId,
            new Date().toISOString(),
            sid,
            'TRANSFER',
            accId,
            dest,
            numericAmount,
            curr,
            key,
            'SUCCESS'
        );
    });

    transferTx();

    const accAfter = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(accId);
    const newBalance = accAfter ? Number(accAfter.balance) : currentBalance - numericAmount;

    // Sync outward to JSON files for test suite compatibility
    exportSqliteToJson(db);
    exportAuditSqliteToJson(db);

    return {
        success: true,
        newBalance,
        transaction: newTrx
    };
}

/**
 * Executes a bill payment mutation inside an explicit ACID transaction (BEGIN / COMMIT / ROLLBACK).
 */
function executeBillPaymentTransaction({ billIds, idempotency_key, sessionId }) {
    const db = getSqliteDb();
    const key = idempotency_key || null;
    const sid = sessionId || 'default_session';

    // 1. Idempotency Check
    if (key) {
        const existingRows = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?').all(key);
        if (existingRows.length > 0) {
            const acc = db.prepare('SELECT balance, currency, id FROM accounts LIMIT 1').get();
            const totalAmount = existingRows.reduce((sum, t) => sum + Number(t.amount || 0), 0);
            const mappedTxs = existingRows.map(t => ({
                id: t.id,
                idempotency_key: t.idempotency_key,
                type: t.type,
                recipient: t.recipient,
                phone: t.phone,
                amount: Number(t.amount),
                currency: t.currency,
                status: t.status,
                date: t.date
            }));

            recordAuditEntry(db, {
                sessionId: sid,
                actionType: 'BILL_PAYMENT',
                sourceAccount: acc ? acc.id : 'usr_1001',
                destination: mappedTxs.map(e => e.recipient).join(', '),
                amount: totalAmount,
                currency: acc ? acc.currency : 'IQD',
                idempotencyKey: key,
                executionStatus: 'SUCCESS'
            });

            return {
                success: true,
                newBalance: Number(acc.balance),
                totalAmount,
                paidBills: [],
                transactions: mappedTxs,
                cached: true,
                idempotent: true
            };
        }
    }

    const acc = db.prepare('SELECT id, balance, currency, name FROM accounts LIMIT 1').get();
    const accId = acc ? acc.id : 'usr_1001';
    const curr = acc ? acc.currency : 'IQD';
    const currentBalance = acc ? Number(acc.balance) : 0;

    if (!Array.isArray(billIds) || billIds.length === 0) {
        recordAuditEntry(db, {
            sessionId: sid,
            actionType: 'BILL_PAYMENT',
            sourceAccount: accId,
            destination: 'N/A',
            amount: 0,
            currency: curr,
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error('لم يتم تحديد أي فاتورة للدفع.');
    }

    // Fetch candidate bills
    const placeholders = billIds.map(() => '?').join(',');
    const billsToPay = db.prepare(`SELECT * FROM bills WHERE id IN (${placeholders})`).all(...billIds);

    if (billsToPay.length === 0) {
        recordAuditEntry(db, {
            sessionId: sid,
            actionType: 'BILL_PAYMENT',
            sourceAccount: accId,
            destination: billIds.join(', '),
            amount: 0,
            currency: curr,
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error('لم يتم العثور على فواتير غير مدفوعة مطابقة في قاعدة البيانات.');
    }

    const unpaidBills = billsToPay.filter(b => b.status === 'unpaid');
    if (unpaidBills.length === 0) {
        recordAuditEntry(db, {
            sessionId: sid,
            actionType: 'BILL_PAYMENT',
            sourceAccount: accId,
            destination: billsToPay.map(b => b.biller).join(', '),
            amount: 0,
            currency: curr,
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error('لم يتم العثور على فواتير غير مدفوعة مطابقة في قاعدة البيانات.');
    }

    const totalAmount = unpaidBills.reduce((sum, b) => sum + Number(b.amount || 0), 0);

    if (currentBalance < totalAmount) {
        recordAuditEntry(db, {
            sessionId: sid,
            actionType: 'BILL_PAYMENT',
            sourceAccount: accId,
            destination: unpaidBills.map(b => b.biller).join(', '),
            amount: totalAmount,
            currency: curr,
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error(`الرصيد الحالي (${currentBalance.toLocaleString()} د.ع) غير كافي لدفع مبلغ ${totalAmount.toLocaleString()} د.ع.`);
    }

    const generatedTxs = [];
    const dateStr = new Date().toISOString().split('T')[0];

    // 2. ATOMIC ACID TRANSACTION: Deduct balance + Update bills status + Insert transactions + Audit
    const billPayTx = db.transaction(() => {
        // Balance deduction
        const updateResult = db.prepare(`
            UPDATE accounts
            SET balance = balance - ?, updated_at = datetime('now')
            WHERE id = ? AND balance >= ?
        `).run(totalAmount, accId, totalAmount);

        if (updateResult.changes === 0) {
            throw new Error('Insufficient balance or account not found during atomic bill payment deduction.');
        }

        const updateBillStmt = db.prepare(`
            UPDATE bills
            SET status = 'paid', paid_at = datetime('now')
            WHERE id = ?
        `);

        const insertTxStmt = db.prepare(`
            INSERT INTO transactions (id, idempotency_key, type, recipient, sender, phone, amount, currency, status, date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let billIndex = 0;
        for (const bill of unpaidBills) {
            billIndex++;
            updateBillStmt.run(bill.id);

            const txId = `trx_${Date.now()}_${billIndex}_${Math.random().toString(36).substring(2, 7)}`;
            const txRecord = {
                id: txId,
                idempotency_key: key || null,
                type: 'BILL_PAYMENT',
                recipient: bill.biller,
                phone: bill.account_number || '',
                amount: Number(bill.amount),
                currency: curr,
                status: 'SUCCESS',
                date: dateStr
            };

            insertTxStmt.run(
                txRecord.id,
                txRecord.idempotency_key,
                txRecord.type,
                txRecord.recipient,
                acc.name || 'محمد',
                txRecord.phone,
                txRecord.amount,
                txRecord.currency,
                txRecord.status,
                txRecord.date
            );

            generatedTxs.push(txRecord);
        }

        // Record audit entry
        const auditId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        db.prepare(`
            INSERT INTO audit_logs (id, timestamp, session_id, action_type, source_account, destination, amount, currency, idempotency_key, execution_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            auditId,
            new Date().toISOString(),
            sid,
            'BILL_PAYMENT',
            accId,
            unpaidBills.map(b => b.biller).join(', '),
            totalAmount,
            curr,
            key,
            'SUCCESS'
        );
    });

    billPayTx();

    const accAfter = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(accId);
    const newBalance = accAfter ? Number(accAfter.balance) : currentBalance - totalAmount;

    // Synchronously export to JSON files for regression assertions
    exportSqliteToJson(db);
    exportAuditSqliteToJson(db);

    return {
        success: true,
        newBalance,
        totalAmount,
        paidBills: unpaidBills.map(b => ({ ...b, status: 'paid' })),
        transactions: generatedTxs
    };
}

/**
 * Adds a new contact inside an atomic SQLite transaction.
 */
function addContactTransaction({ name, phone, alias, wallet_provider, sessionId }) {
    if (!name || !phone) {
        throw new Error('Contact name and phone number are required.');
    }
    const db = getSqliteDb();
    const sid = sessionId || 'default_session';

    let formattedPhone = String(phone).trim();
    if (formattedPhone.startsWith('07')) {
        formattedPhone = '+964' + formattedPhone.slice(1);
    }

    const newContact = {
        id: `cnt_${Date.now().toString().slice(-4)}`,
        name: name.trim(),
        alias: alias ? alias.trim() : name.trim(),
        phone: formattedPhone,
        wallet_provider: wallet_provider || 'VI'
    };

    const tx = db.transaction(() => {
        db.prepare(`
            INSERT INTO contacts (id, name, alias, phone, wallet_provider)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            newContact.id,
            newContact.name,
            newContact.alias,
            newContact.phone,
            newContact.wallet_provider
        );

        const auditId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        db.prepare(`
            INSERT INTO audit_logs (id, timestamp, session_id, action_type, source_account, destination, amount, currency, idempotency_key, execution_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            auditId,
            new Date().toISOString(),
            sid,
            'ADD_CONTACT',
            'usr_1001',
            `${newContact.name} (${newContact.phone})`,
            0,
            'IQD',
            null,
            'SUCCESS'
        );
    });

    tx();
    exportSqliteToJson(db);
    exportAuditSqliteToJson(db);

    return newContact;
}

/**
 * Internal helper to record an audit entry into SQLite and sync outward.
 */
function recordAuditEntry(db, entry) {
    try {
        const auditId = entry.id || `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        db.prepare(`
            INSERT INTO audit_logs (id, timestamp, session_id, action_type, source_account, destination, amount, currency, idempotency_key, execution_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            auditId,
            entry.timestamp || new Date().toISOString(),
            entry.sessionId || 'default_session',
            entry.actionType || 'UNKNOWN',
            entry.sourceAccount || 'usr_1001',
            entry.destination || '',
            Number(entry.amount || 0),
            entry.currency || 'IQD',
            entry.idempotencyKey || null,
            entry.executionStatus || 'SUCCESS'
        );
        exportAuditSqliteToJson(db);
    } catch (err) {
        console.error('[SQLite Audit Error]:', err.message);
    }
}

/**
 * Resets SQLite database and re-seeds from INITIAL_DB template.
 */
function resetSqliteDatabase(initialDb = INITIAL_DB) {
    const db = getSqliteDb();
    const resetTx = db.transaction(() => {
        db.prepare('DELETE FROM accounts').run();
        db.prepare('DELETE FROM contacts').run();
        db.prepare('DELETE FROM bills').run();
        db.prepare('DELETE FROM transactions').run();
    });
    resetTx();
    seedDatabaseFromSources(db, initialDb);
    exportSqliteToJson(db);
    return exportSqliteToJson(db);
}

module.exports = {
    getSqliteDb,
    closeSqliteDb,
    createTables,
    isDatabaseEmpty,
    seedDatabaseFromSources,
    exportSqliteToJson,
    exportAuditSqliteToJson,
    syncSqliteWithJsonObject,
    executeTransferTransaction,
    executeBillPaymentTransaction,
    addContactTransaction,
    resetSqliteDatabase,
    recordAuditEntry,
    SQLITE_DB_PATH
};
