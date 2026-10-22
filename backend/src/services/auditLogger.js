const fs = require('fs');
const { AUDIT_LOG_PATH, DEFAULT_SESSION_ID } = require('../config/providers');
const {
    getSqliteDb,
    exportAuditSqliteToJson,
    recordAuditEntry
} = require('./sqliteDb');

function readAuditLog() {
    try {
        const db = getSqliteDb();
        return exportAuditSqliteToJson(db);
    } catch (err) {
        if (!fs.existsSync(AUDIT_LOG_PATH)) {
            return [];
        }
        try {
            const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trim();
            return JSON.parse(raw || '[]');
        } catch (_) {
            return [];
        }
    }
}

function clearAuditLog() {
    try {
        const db = getSqliteDb();
        db.prepare('DELETE FROM audit_logs').run();
        exportAuditSqliteToJson(db);
    } catch (err) {
        if (fs.existsSync(AUDIT_LOG_PATH)) {
            try {
                fs.writeFileSync(AUDIT_LOG_PATH, JSON.stringify([], null, 2), 'utf8');
            } catch (_) {}
        }
    }
}

function appendAuditLog(entry) {
    try {
        const db = getSqliteDb();
        const auditRecord = {
            id: entry.id || `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            timestamp: entry.timestamp || new Date().toISOString(),
            sessionId: entry.sessionId || DEFAULT_SESSION_ID,
            actionType: entry.actionType || 'UNKNOWN',
            sourceAccount: entry.sourceAccount || 'usr_1001',
            destination: entry.destination || '',
            amount: entry.amount !== undefined ? entry.amount : 0,
            currency: entry.currency || 'IQD',
            idempotencyKey: entry.idempotencyKey || null,
            executionStatus: entry.executionStatus || 'FAILED' // 'SUCCESS' | 'BLOCKED' | 'FAILED'
        };

        recordAuditEntry(db, auditRecord);
        return auditRecord;
    } catch (err) {
        console.error('⚠️ [Audit Log Fail-Safe Warning]: Failed to append to audit log:', err.message);
        return null;
    }
}

module.exports = {
    readAuditLog,
    clearAuditLog,
    appendAuditLog,
    AUDIT_LOG_PATH
};
