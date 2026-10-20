const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { resetDatabase, INITIAL_DB } = require('./reset_db');

// Load environment variables securely from .env in project root
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const app = express();
app.use(cors());
app.use(express.json());

// Disable caching in development so browser always receives latest UI
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

app.use('/assets', express.static(path.join(__dirname, '../assets')));
app.use(express.static(path.join(__dirname, '../assets')));
app.use(express.static(path.join(__dirname, '../frontend')));

/* ==========================================================================
   Unified Model Providers Configuration & OpenAI Client Wrapper
   ========================================================================== */

const PROVIDERS = {
    local: {
        name: 'LM Studio (محلي)',
        baseURL: (process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1').replace(/\/chat\/completions\/?$/, ''),
        apiKeyEnv: 'LOCAL_API_KEY',
        defaultKey: 'lm-studio',
        defaultModel: 'local-model'
    },
    gemini: {
        name: 'Google Gemini',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKeyEnv: 'GEMINI_API_KEY',
        defaultKey: null,
        defaultModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
    },
    groq: {
        name: 'Groq',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKeyEnv: 'GROQ_API_KEY',
        defaultKey: null,
        defaultModel: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b'
    }
};

const FAILOVER_CHAIN = {
    local: ['gemini', 'groq'],
    gemini: ['groq', 'local'],
    groq: ['gemini', 'local']
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableError(err) {
    if (!err) return false;
    const status = err.status || err.statusCode;
    if (status === 429 || (status >= 500 && status <= 504)) return true;
    const code = err.code || '';
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) return true;
    const msg = (err.message || '').toLowerCase();
    return msg.includes('429') || msg.includes('rate limit') || msg.includes('quota') ||
           msg.includes('fetch failed') || msg.includes('econnrefused') ||
           msg.includes('etimedout') || msg.includes('network') || msg.includes('timeout') ||
           msg.includes('overloaded');
}

async function executeSingleCompletion(providerKey, messages, options = {}) {
    const provider = PROVIDERS[providerKey] || PROVIDERS.local;
    const keyName = provider.apiKeyEnv;
    const apiKey = process.env[keyName] || provider.defaultKey;

    if (!apiKey && providerKey !== 'local') {
        throw new Error(`مفتاح الـ API لـ ${provider.name} (${keyName}) غير متوفر! يرجى إضافته في ملف .env أولاً.`);
    }

    const client = new OpenAI({
        baseURL: provider.baseURL,
        apiKey: apiKey || 'lm-studio'
    });

    const model = options.model || provider.defaultModel;

    return await client.chat.completions.create({
        model: model,
        messages: messages,
        temperature: options.temperature !== undefined ? options.temperature : 0.2,
        max_tokens: options.max_tokens !== undefined ? options.max_tokens : 500
    });
}

async function callProviderWithBackoff(providerKey, messages, options = {}, maxRetries = 2) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await executeSingleCompletion(providerKey, messages, options);
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries && isRetryableError(err)) {
                const backoffMs = Math.min(2000, 500 * Math.pow(2, attempt));
                console.warn(`⚠️ [${providerKey}] Attempt ${attempt + 1}/${maxRetries + 1} failed (${err.message}). Retrying in ${backoffMs}ms...`);
                await sleep(backoffMs);
            } else {
                break;
            }
        }
    }
    throw lastError;
}

/**
 * Unified Chat Completion Handler with Exponential Backoff Retries & Automatic Failover
 * Routes all chat requests dynamically through OpenAI client based on selected provider.
 */
async function callUnifiedChatCompletion(providerKey, messages, options = {}) {
    const primaryKey = PROVIDERS[providerKey] ? providerKey : 'local';

    try {
        return await callProviderWithBackoff(primaryKey, messages, options, 2);
    } catch (primaryErr) {
        console.warn(`⚠️ [Primary Provider "${primaryKey}" Exhausted Retries]: ${primaryErr.message}`);

        // Automatic Provider Failover
        const candidates = FAILOVER_CHAIN[primaryKey] || [];
        for (const secondaryKey of candidates) {
            const secondaryProvider = PROVIDERS[secondaryKey];
            if (!secondaryProvider) continue;

            const secKeyName = secondaryProvider.apiKeyEnv;
            const secApiKey = process.env[secKeyName] || secondaryProvider.defaultKey;

            // Rule 2: Skip cleanly if secondary provider key is missing
            if (!secApiKey && secondaryKey !== 'local') {
                console.warn(`[Failover Skipped]: API key for secondary provider "${secondaryKey}" (${secKeyName}) is missing in environment.`);
                continue;
            }

            console.log(`🔄 [Automatic Failover Initiated]: Redirecting from "${primaryKey}" to "${secondaryKey}" (${secondaryProvider.name})...`);
            try {
                return await callProviderWithBackoff(secondaryKey, messages, options, 2);
            } catch (secErr) {
                console.warn(`⚠️ [Secondary Provider "${secondaryKey}" Failed]: ${secErr.message}`);
            }
        }

        throw new Error(
            `تعذر الاتصال بالنموذج الأساسي (${PROVIDERS[primaryKey]?.name || primaryKey}): ${primaryErr.message}. فشلت محاولات التبديل التلقائي للمزود الاحتياطي.`
        );
    }
}

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1/chat/completions';
const DB_FILE_PATH = path.join(__dirname, 'mock_wallet_db.json');
const DB_TMP_FILE_PATH = path.join(__dirname, 'mock_wallet_db.json.tmp');
const AUDIT_LOG_PATH = path.join(__dirname, 'audit_trail.json');
const AUDIT_TMP_LOG_PATH = path.join(__dirname, 'audit_trail.json.tmp');
const FEEDBACK_LIKES_PATH = path.join(__dirname, 'feedback_likes.json');
const FEEDBACK_DISLIKES_PATH = path.join(__dirname, 'feedback_dislikes.json');

function getClonedInitialDb() {
    return JSON.parse(JSON.stringify(INITIAL_DB));
}

/* ==========================================================================
   وظائف قراءة وتحديث ملفات التقييم وقاعدة البيانات على القرص
   ========================================================================== */

function readFeedbackFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify([], null, 2), 'utf8');
            return [];
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (err) {
        console.error(`[Feedback] Error reading ${filePath}:`, err.message);
        return [];
    }
}

function saveFeedbackFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error(`[Feedback Error] Failed to write ${filePath}:`, err.message);
        return false;
    }
}

/* ==========================================================================
   Security Audit Logging Layer (سجل التدقيق الأمني للعمليات المالية)
   ========================================================================== */

function readAuditLog() {
    try {
        if (!fs.existsSync(AUDIT_LOG_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trim();
        return JSON.parse(raw || '[]');
    } catch (err) {
        console.error('[Audit Log] Error reading audit trail:', err.message);
        return [];
    }
}

function clearAuditLog() {
    try {
        if (fs.existsSync(AUDIT_LOG_PATH)) {
            fs.writeFileSync(AUDIT_LOG_PATH, JSON.stringify([], null, 2), 'utf8');
        }
    } catch (err) {
        console.error('[Audit Log] Failed to clear audit trail:', err.message);
    }
}

function appendAuditLog(entry) {
    try {
        const auditRecord = {
            id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
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

        const logs = readAuditLog();
        logs.push(auditRecord);

        // Atomic write pattern to guarantee tamper-resistance and avoid partial corruption
        fs.writeFileSync(AUDIT_TMP_LOG_PATH, JSON.stringify(logs, null, 2), 'utf8');
        try {
            fs.renameSync(AUDIT_TMP_LOG_PATH, AUDIT_LOG_PATH);
        } catch (renameErr) {
            if (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') {
                fs.copyFileSync(AUDIT_TMP_LOG_PATH, AUDIT_LOG_PATH);
                try { fs.unlinkSync(AUDIT_TMP_LOG_PATH); } catch (e) {}
            } else {
                throw renameErr;
            }
        }
        return auditRecord;
    } catch (err) {
        // Rule 2 (Fail-Safe Logging): Log error cleanly without crashing primary transaction
        console.error('⚠️ [Audit Log Fail-Safe Warning]: Failed to append to audit log:', err.message);
        if (fs.existsSync(AUDIT_TMP_LOG_PATH)) {
            try { fs.unlinkSync(AUDIT_TMP_LOG_PATH); } catch (e) {}
        }
        return null;
    }
}

function readDatabase() {
    try {
        if (!fs.existsSync(DB_FILE_PATH)) {
            console.warn(`[DB Auto-Healing] Database file not found at ${DB_FILE_PATH}. Initializing with default INITIAL_DB template...`);
            const initial = getClonedInitialDb();
            saveDatabase(initial);
            return initial;
        }

        const raw = fs.readFileSync(DB_FILE_PATH, 'utf8').trim();
        if (!raw) {
            console.warn(`[DB Auto-Healing] Database file at ${DB_FILE_PATH} is empty. Initializing with default INITIAL_DB template...`);
            const initial = getClonedInitialDb();
            saveDatabase(initial);
            return initial;
        }

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.user) {
            throw new Error('Database file content does not conform to valid wallet schema.');
        }

        return parsed;
    } catch (error) {
        console.warn(`[DB Auto-Healing] Database reading/parsing failed (${error.message}). Restoring fresh copy from INITIAL_DB...`);
        const fallback = getClonedInitialDb();
        try {
            saveDatabase(fallback);
        } catch (saveErr) {
            console.error('[DB Auto-Healing Error] Failed to persist fallback database to disk:', saveErr.message);
        }
        return fallback;
    }
}

function saveDatabase(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid database data provided for save.');
    }

    const jsonString = JSON.stringify(data, null, 2);

    try {
        // Atomic write pattern: write to temporary file first, then atomically replace original
        fs.writeFileSync(DB_TMP_FILE_PATH, jsonString, 'utf8');
        try {
            fs.renameSync(DB_TMP_FILE_PATH, DB_FILE_PATH);
        } catch (renameErr) {
            if (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') {
                // Windows-safe fallback for transient file lock by indexers/antivirus
                fs.copyFileSync(DB_TMP_FILE_PATH, DB_FILE_PATH);
                try { fs.unlinkSync(DB_TMP_FILE_PATH); } catch (e) {}
            } else {
                throw renameErr;
            }
        }
        console.log(`[DB] Successfully persisted changes atomically to ${DB_FILE_PATH}`);
        return true;
    } catch (error) {
        console.error('[DB Error] Failed to write database to disk:', error.message);
        // Rule 3: Ensure temporary file is cleaned up if writing or renaming fails
        if (fs.existsSync(DB_TMP_FILE_PATH)) {
            try {
                fs.unlinkSync(DB_TMP_FILE_PATH);
            } catch (unlinkErr) {
                console.error('[DB Error] Failed to clean up temporary file:', unlinkErr.message);
            }
        }
        throw error;
    }
}

function executeTransferMutation({ recipient, amount, phone, idempotency_key, sessionId }) {
    const db = readDatabase();
    const key = idempotency_key || null;
    const dest = phone ? `${recipient || 'Unknown'} (${phone})` : (recipient || 'Unknown Recipient');
    const sid = sessionId || 'default_session';

    // 1. Idempotency check: Replay cached transaction if key already exists
    if (key && Array.isArray(db.recent_transactions)) {
        const existing = db.recent_transactions.find(t => t.idempotency_key === key);
        if (existing) {
            console.log(`[Idempotent Replay]: Returning cached transaction ${existing.id} for idempotency key ${key}`);
            appendAuditLog({
                sessionId: sid,
                actionType: 'TRANSFER',
                sourceAccount: db.user?.id || 'usr_1001',
                destination: dest,
                amount: existing.amount,
                currency: existing.currency || db.user?.currency || 'IQD',
                idempotencyKey: key,
                executionStatus: 'SUCCESS'
            });
            return { success: true, newBalance: db.user.balance, transaction: existing, cached: true, idempotent: true };
        }
    }

    // 2. Financial Integrity & Anti-Tampering: Strict positive non-zero integer validation
    const numericAmount = Number(amount);

    if (isNaN(numericAmount) || !Number.isFinite(numericAmount) || numericAmount <= 0) {
        appendAuditLog({
            sessionId: sid,
            actionType: 'TRANSFER',
            sourceAccount: db.user?.id || 'usr_1001',
            destination: dest,
            amount: isNaN(numericAmount) ? 0 : numericAmount,
            currency: db.user?.currency || 'IQD',
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error(`Invalid transfer amount: ${amount}`);
    }

    if (!Number.isInteger(numericAmount)) {
        appendAuditLog({
            sessionId: sid,
            actionType: 'TRANSFER',
            sourceAccount: db.user?.id || 'usr_1001',
            destination: dest,
            amount: numericAmount,
            currency: db.user?.currency || 'IQD',
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error(`Transfer amount must be an integer, received fractional amount: ${amount}`);
    }

    if (numericAmount < 250) {
        appendAuditLog({
            sessionId: sid,
            actionType: 'TRANSFER',
            sourceAccount: db.user?.id || 'usr_1001',
            destination: dest,
            amount: numericAmount,
            currency: db.user?.currency || 'IQD',
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error(`Transfer amount (${numericAmount} IQD) is below minimum allowed threshold (250 IQD).`);
    }

    if (db.user.balance < numericAmount) {
        appendAuditLog({
            sessionId: sid,
            actionType: 'TRANSFER',
            sourceAccount: db.user?.id || 'usr_1001',
            destination: dest,
            amount: numericAmount,
            currency: db.user?.currency || 'IQD',
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error(`Insufficient balance: current balance (${db.user.balance} IQD) is less than transfer amount (${numericAmount} IQD).`);
    }

    // 3. Balance deduction & Transaction record creation
    db.user.balance -= numericAmount;

    const trxId = `trx_${Date.now().toString().slice(-6)}`;
    const newTrx = {
        id: trxId,
        idempotency_key: key,
        type: "TRANSFER",
        recipient: recipient || "Unknown Recipient",
        phone: phone || "",
        amount: numericAmount,
        currency: db.user.currency || "IQD",
        status: "SUCCESS",
        date: new Date().toISOString().split('T')[0]
    };

    if (!Array.isArray(db.recent_transactions)) {
        db.recent_transactions = [];
    }
    db.recent_transactions.unshift(newTrx);

    saveDatabase(db);

    // 4. Audit Log Entry
    appendAuditLog({
        sessionId: sid,
        actionType: 'TRANSFER',
        sourceAccount: db.user?.id || 'usr_1001',
        destination: dest,
        amount: numericAmount,
        currency: newTrx.currency,
        idempotencyKey: key,
        executionStatus: 'SUCCESS'
    });

    return { success: true, newBalance: db.user.balance, transaction: newTrx };
}

function executeBillPaymentMutation({ billIds, idempotency_key, sessionId }) {
    const db = readDatabase();
    const key = idempotency_key || null;
    const sid = sessionId || 'default_session';

    // 1. Idempotency check: Replay cached transaction if key already exists
    if (key && Array.isArray(db.recent_transactions)) {
        const existing = db.recent_transactions.filter(t => t.idempotency_key === key);
        if (existing.length > 0) {
            console.log(`[Idempotent Replay]: Returning ${existing.length} cached bill payment transaction(s) for key ${key}`);
            const totalAmount = existing.reduce((sum, t) => sum + Number(t.amount || 0), 0);
            appendAuditLog({
                sessionId: sid,
                actionType: 'BILL_PAYMENT',
                sourceAccount: db.user?.id || 'usr_1001',
                destination: existing.map(e => e.biller || e.account_number).join(', '),
                amount: totalAmount,
                currency: db.user?.currency || 'IQD',
                idempotencyKey: key,
                executionStatus: 'SUCCESS'
            });
            return {
                success: true,
                newBalance: db.user.balance,
                totalAmount,
                paidBills: [],
                transactions: existing,
                cached: true,
                idempotent: true
            };
        }
    }

    if (!Array.isArray(billIds) || billIds.length === 0) {
        appendAuditLog({
            sessionId: sid,
            actionType: 'BILL_PAYMENT',
            sourceAccount: db.user?.id || 'usr_1001',
            destination: 'N/A',
            amount: 0,
            currency: db.user?.currency || 'IQD',
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error('لم يتم تحديد أي فاتورة للدفع.');
    }

    const billsToPay = (db.bills || []).filter(b => billIds.includes(b.id) && b.status === 'unpaid');
    if (billsToPay.length === 0) {
        appendAuditLog({
            sessionId: sid,
            actionType: 'BILL_PAYMENT',
            sourceAccount: db.user?.id || 'usr_1001',
            destination: billIds.join(', '),
            amount: 0,
            currency: db.user?.currency || 'IQD',
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error('لم يتم العثور على فواتير غير مدفوعة مطابقة في قاعدة البيانات.');
    }

    const totalAmount = billsToPay.reduce((sum, b) => sum + Number(b.amount || 0), 0);

    if (isNaN(totalAmount) || !Number.isFinite(totalAmount) || totalAmount <= 0 || !Number.isInteger(totalAmount)) {
        appendAuditLog({
            sessionId: sid,
            actionType: 'BILL_PAYMENT',
            sourceAccount: db.user?.id || 'usr_1001',
            destination: billsToPay.map(b => b.biller).join(', '),
            amount: isNaN(totalAmount) ? 0 : totalAmount,
            currency: db.user?.currency || 'IQD',
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error(`مبلغ الفاتورة غير صحيح: ${totalAmount}`);
    }

    if (db.user.balance < totalAmount) {
        appendAuditLog({
            sessionId: sid,
            actionType: 'BILL_PAYMENT',
            sourceAccount: db.user?.id || 'usr_1001',
            destination: billsToPay.map(b => b.biller).join(', '),
            amount: totalAmount,
            currency: db.user?.currency || 'IQD',
            idempotencyKey: key,
            executionStatus: 'BLOCKED'
        });
        throw new Error(`الرصيد الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع مبلغ ${totalAmount.toLocaleString()} د.ع.`);
    }

    // Deduct balance
    db.user.balance -= totalAmount;

    const paidTransactions = [];
    for (const b of billsToPay) {
        b.status = 'paid';
        const trxId = `trx_${Date.now().toString().slice(-6)}_${Math.floor(Math.random() * 1000)}`;
        const newTrx = {
            id: trxId,
            idempotency_key: key,
            type: "BILL_PAYMENT",
            biller: b.biller,
            account_number: b.account_number,
            amount: Number(b.amount),
            currency: db.user.currency || "IQD",
            status: "SUCCESS",
            date: new Date().toISOString().split('T')[0]
        };
        paidTransactions.push(newTrx);
        if (!Array.isArray(db.recent_transactions)) {
            db.recent_transactions = [];
        }
        db.recent_transactions.unshift(newTrx);
    }

    saveDatabase(db);
    console.log(`[Bill Payment Confirmed & Executed on DB]: Paid ${billsToPay.length} bill(s). Total: ${totalAmount.toLocaleString()} IQD. New Balance: ${db.user.balance.toLocaleString()} IQD`);

    // Audit Log Entry
    appendAuditLog({
        sessionId: sid,
        actionType: 'BILL_PAYMENT',
        sourceAccount: db.user?.id || 'usr_1001',
        destination: billsToPay.map(b => `${b.biller} (${b.account_number})`).join(', '),
        amount: totalAmount,
        currency: db.user?.currency || 'IQD',
        idempotencyKey: key,
        executionStatus: 'SUCCESS'
    });

    return {
        success: true,
        newBalance: db.user.balance,
        totalAmount,
        paidBills: billsToPay,
        transactions: paidTransactions
    };
}

function addContactMutation({ name, phone, alias, wallet_provider }) {
    const db = readDatabase();

    if (!name || !phone) {
        throw new Error('Contact name and phone number are required.');
    }

    if (!Array.isArray(db.contacts)) {
        db.contacts = [];
    }

    const newId = `cnt_${Date.now().toString().slice(-4)}`;
    let formattedPhone = String(phone).trim();
    if (formattedPhone.startsWith('07')) {
        formattedPhone = '+964' + formattedPhone.slice(1);
    }

    const newContact = {
        id: newId,
        name: name.trim(),
        alias: (alias || name).trim(),
        phone: formattedPhone,
        wallet_provider: wallet_provider || "VI"
    };

    db.contacts.push(newContact);
    saveDatabase(db);
    return { success: true, contact: newContact };
}

/* ==========================================================================
   Multi-User Session State Store & Pruning Manager
   ========================================================================== */

const sessions = new Map();
const DEFAULT_SESSION_ID = 'default_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 Hours

function createInitialSessionState() {
    return {
        conversationHistory: [],
        pendingTransfer: null,
        pendingDisambiguation: null,
        pendingBillPayment: null,
        pendingTransferRecipient: null,
        lastUserPhoneCandidate: null,
        recentUserPhoneCandidates: [],
        pendingContactCreation: null,
        lastActive: Date.now()
    };
}

const MAX_CONVERSATION_HISTORY = 12;

function trimConversationHistory(history, limit = MAX_CONVERSATION_HISTORY) {
    if (!Array.isArray(history)) return [];
    if (history.length > limit) {
        return history.slice(-limit);
    }
    return history;
}

function appendToConversationHistory(session, role, content) {
    if (!session || !role || typeof content !== 'string') return;
    if (!Array.isArray(session.conversationHistory)) {
        session.conversationHistory = [];
    }
    session.conversationHistory.push({ role, content });
    session.conversationHistory = trimConversationHistory(session.conversationHistory, MAX_CONVERSATION_HISTORY);
}

function recordSessionTurn(session, userMessage, assistantReply) {
    if (!session) return;
    if (userMessage) {
        appendToConversationHistory(session, 'user', userMessage);
    }
    if (assistantReply) {
        appendToConversationHistory(session, 'assistant', assistantReply);
    }
}

function getSession(sessionId) {
    const validId = (typeof sessionId === 'string' && sessionId.trim()) ? sessionId.trim() : DEFAULT_SESSION_ID;
    if (!sessions.has(validId)) {
        sessions.set(validId, createInitialSessionState());
    }
    const session = sessions.get(validId);
    session.lastActive = Date.now();
    return session;
}

function resetSession(sessionId) {
    const validId = (typeof sessionId === 'string' && sessionId.trim()) ? sessionId.trim() : DEFAULT_SESSION_ID;
    sessions.set(validId, createInitialSessionState());
}

// Basic cleanup interval to prune inactive sessions older than 24 hours
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
        if (id !== DEFAULT_SESSION_ID && (now - session.lastActive > SESSION_TTL_MS)) {
            sessions.delete(id);
            console.log(`[Session Pruned]: Inactive session "${id}" removed from memory.`);
        }
    }
}, 60 * 60 * 1000).unref();


function normalizeDigits(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/[٠۰]/g, '0')
        .replace(/[١۱]/g, '1')
        .replace(/[٢۲]/g, '2')
        .replace(/[٣۳]/g, '3')
        .replace(/[٤۴]/g, '4')
        .replace(/[٥۵]/g, '5')
        .replace(/[٦۶]/g, '6')
        .replace(/[٧۷]/g, '7')
        .replace(/[٨۸]/g, '8')
        .replace(/[٩۹]/g, '9');
}

function normalizeArabic(text) {
    if (!text || typeof text !== 'string') return '';
    return normalizeDigits(text)
        .trim()
        .toLowerCase()
        .replace(/[إأآا]/g, 'ا')
        .replace(/[ى]/g, 'ي')
        .replace(/[ة]/g, 'ه');
}

function extractAmount(text) {
    if (!text) return null;
    const clean = normalizeArabic(text);

    // 1. Spelled out Arabic amounts - Millions (checked first to avoid collisions with "مليون")
    if (clean.includes('مليونين ونص') || clean.includes('مليونين ونصف')) return 2500000;
    if (clean.includes('مليونين')) return 2000000;
    if (clean.includes('مليون ونص') || clean.includes('مليون ونصف')) return 1500000;
    if (clean.includes('مليون وربع')) return 1250000;
    if (clean.includes('نص مليون') || clean.includes('نصف مليون')) return 500000;
    if (clean.includes('ربع مليون')) return 250000;

    // Numeric with million multiplier: e.g. "2 مليون", "1.5 مليون", "3 مليون" (checked before single "مليون")
    const millionMatch = clean.match(/(\d+(?:[.,]\d+)?)\s*(?:مليون|ملايين)(?:[\s،,?!.]|$)/);
    if (millionMatch) {
        const numStr = millionMatch[1].replace(',', '.');
        return Math.round(parseFloat(numStr) * 1000000);
    }

    if (clean.includes('ثلاث ملايين') || clean.includes('ثلاثة ملايين')) return 3000000;
    if (clean.includes('اربع ملايين') || clean.includes('اربعة ملايين')) return 4000000;
    if (clean.includes('خمس ملايين') || clean.includes('خمسة ملايين')) return 5000000;
    if (clean.includes('مليون') || clean.includes('ملايين')) return 1000000;

    // 2. Spelled out Arabic amounts - Thousands
    if (clean.includes('خمسمية الف') || clean.includes('خمسمائة الف') || clean.includes('خمس مية الف')) return 500000;
    if (clean.includes('اربعمية الف') || clean.includes('اربعمائة الف') || clean.includes('اربع مية الف')) return 400000;
    if (clean.includes('ثلاثمية الف') || clean.includes('ثلاثمائة الف') || clean.includes('ثلاث مية الف')) return 300000;
    if (clean.includes('ميتين وخمسين الف') || clean.includes('مئتان وخمسين الف')) return 250000;
    if (clean.includes('ميتين الف') || clean.includes('مئتان الف')) return 200000;
    if (clean.includes('مية وخمسين') || clean.includes('مئة وخمسين')) return 150000;
    if (clean.includes('مية الف') || clean.includes('مئة الف') || clean.includes('ميه الف')) return 100000;
    if (clean.includes('تسعين الف') || clean.includes('تسعين ألف')) return 90000;
    if (clean.includes('ثمانين الف') || clean.includes('ثمانين ألف')) return 80000;
    if (clean.includes('سبعين الف') || clean.includes('سبعين ألف')) return 70000;
    if (clean.includes('خمسة وسبعين الف') || clean.includes('خمسة وسبعين ألف') || clean.includes('خمسه وسبعين الف')) return 75000;
    if (clean.includes('ستين الف') || clean.includes('ستين ألف')) return 60000;
    if (clean.includes('خمسين الف') || clean.includes('خمسين ألف')) return 50000;
    if (clean.includes('خمسة واربعين الف') || clean.includes('خمسة واربعين ألف') || clean.includes('خمسه واربعين الف')) return 45000;
    if (clean.includes('اربعين الف') || clean.includes('اربعين ألف') || clean.includes('أربعين الف') || clean.includes('أربعين ألف')) return 40000;
    if (clean.includes('خمسة وثلاثين الف') || clean.includes('خمسة وثلاثين ألف') || clean.includes('خمسه وثلاثين الف')) return 35000;
    if (clean.includes('ثلاثين الف') || clean.includes('ثلاثين ألف')) return 30000;
    if (clean.includes('خمسه وعشرين الف') || clean.includes('خمسة وعشرين الف') || clean.includes('خمسة وعشرين ألف') || clean.includes('خمسه وعشرين ألف')) return 25000;
    if (clean.includes('عشرين الف') || clean.includes('عشرين ألف')) return 20000;
    if (clean.includes('خمسطاش الف') || clean.includes('خمسة عشر الف') || clean.includes('خمسه عشر الف')) return 15000;
    if (clean.includes('عشره الاف') || clean.includes('عشرة الاف') || clean.includes('عشرة آلاف') || clean.includes('عشره آلاف')) return 10000;
    if (clean.includes('تسعه الاف') || clean.includes('تسعة الاف') || clean.includes('تسعة آلاف')) return 9000;
    if (clean.includes('ثمانيه الاف') || clean.includes('ثمانية الاف') || clean.includes('ثمانية آلاف')) return 8000;
    if (clean.includes('سبعه الاف') || clean.includes('سبعة الاف') || clean.includes('سبعة آلاف')) return 7000;
    if (clean.includes('سته الاف') || clean.includes('ستة الاف') || clean.includes('ستة آلاف')) return 6000;
    if (clean.includes('خمسه الاف') || clean.includes('خمسة الاف') || clean.includes('خمسة آلاف') || clean.includes('خمسه آلاف')) return 5000;
    if (clean.includes('اربعه الاف') || clean.includes('اربعة الاف') || clean.includes('أربعة آلاف')) return 4000;
    if (clean.includes('ثلاث الاف') || clean.includes('ثلاثة الاف') || clean.includes('تلاث الاف')) return 3000;
    if (clean.includes('الفين') || clean.includes('ألفين')) return 2000;
    if (clean.includes('ميه') || clean.includes('مية') || clean.includes('مئة')) return 100000;



    // 4. Numeric with thousand multiplier: e.g. "100 الف", "50 ألف", "25k"
    const thousandMatch = clean.match(/(\d+[\d,.]*)\s*(?:ألف|الف|آلاف|الاف|k)(?:[\s،,?!.]|$)/i);
    if (thousandMatch) {
        const numStr = thousandMatch[1].replace(/[,.]/g, '');
        return Math.round(parseFloat(numStr) * 1000);
    }

    // 5. Explicit currency suffix: e.g. "500 دينار", "25000 د.ع", "50000 iqd"
    const currencyMatch = clean.match(/(?:^|[\s،,])(\d+[\d,.]*)\s*(?:دينار|د\.ع|iqd)(?:[\s،,?!.]|$)/i);
    if (currencyMatch) {
        return parseInt(currencyMatch[1].replace(/[,.]/g, ''), 10);
    }

    // 6. Comma/dot separated numbers: e.g. "100,000", "1,000,000"
    const formattedMatch = clean.match(/(?:^|[\s،,])(\d{1,3}(?:[,.]\d{3})+)(?:[\s،,?!.]|$)/);
    if (formattedMatch) {
        return parseInt(formattedMatch[1].replace(/[,.]/g, ''), 10);
    }

    // Prepare text for plain digit matching: remove phone numbers (078/077/075...) and account numbers
    let plainClean = clean
        .replace(/(?:(?:\+|00)?964[\s-]*)?0?7[578][\s\d-]{7,15}(?:[\s،,?!.]|$)/g, ' ')
        .replace(/(?:حساب|بطاق[هة]|ماستركارد|ماستر\s*كارد|فيزا|account|card|mastercard)[\s:]*(?:رقم[\s:]*)?[0-9\s-]{4,20}/gi, ' ');

    // 7. Plain digits: e.g. "100000", "50000", "25000" (4 to 8 digits)
    const plainMatch = plainClean.match(/(?:^|[\s،,])(\d{4,8})(?:[\s،,?!.]|$)/);
    if (plainMatch) {
        return parseInt(plainMatch[1], 10);
    }

    return null;
}

function findAmbiguousContacts(userMessage, contacts) {
    if (!userMessage || !Array.isArray(contacts)) return null;
    const normMsg = normalizeArabic(userMessage);

    // Group contacts by normalized base name
    const grouped = {};
    for (const c of contacts) {
        const baseNorm = normalizeArabic(c.name || '');
        if (!baseNorm) continue;
        if (!grouped[baseNorm]) {
            grouped[baseNorm] = [];
        }
        grouped[baseNorm].push(c);
    }

    // Check if userMessage mentions any name that has multiple contacts
    for (const [nameNorm, list] of Object.entries(grouped)) {
        if (list.length > 1) {
            const nameRegex = new RegExp(`(^|[\\s،,])(ل|الى\\s+|الي\\s+)?(${nameNorm})([\\s،,]|$)`, 'i');
            if (nameRegex.test(normMsg)) {
                const specificMatches = list.filter(c => {
                    const normAlias = normalizeArabic(c.alias || '');
                    const aliasWords = normAlias.split(/[\s()\/]+/).filter(w => w.length >= 3 && w !== nameNorm);
                    const hasAliasWord = aliasWords.some(w => normMsg.includes(w));

                    const phoneDigits = (c.phone || '').replace(/\D/g, '');
                    const hasPhone = phoneDigits.length >= 4 && normMsg.replace(/\D/g, '').includes(phoneDigits.slice(-6));

                    return hasAliasWord || hasPhone;
                });

                if (specificMatches.length !== 1) {
                    return {
                        baseName: list[0].name,
                        matches: list
                    };
                }
            }
        }
    }

    return null;
}

function resolveContactSelection(userMessage, matches) {
    if (!userMessage || !Array.isArray(matches) || matches.length === 0) return null;
    const raw = userMessage.trim().toLowerCase();
    const normalized = normalizeArabic(raw);

    // Number matching: "1", "2", "3", "4" or "الاول", "الثاني", "الثالث", "الرابع"
    if (raw === '1' || normalized === 'الاول' || normalized.startsWith('الاول ')) {
        return matches[0] || null;
    }
    if (raw === '2' || normalized === 'الثاني' || normalized.startsWith('الثاني ')) {
        return matches[1] || null;
    }
    if (raw === '3' || normalized === 'الثالث' || normalized.startsWith('الثالث ')) {
        return matches[2] || null;
    }
    if (raw === '4' || normalized === 'الرابع' || normalized.startsWith('الرابع ')) {
        return matches[3] || null;
    }

    // Phone digits matching:
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 4) {
        const found = matches.find(c => (c.phone || '').replace(/\D/g, '').includes(digits));
        if (found) return found;
    }

    // Distinguishing alias words (e.g. "كمال", "جاسم", "الفيترجي"):
    for (const c of matches) {
        const normAlias = normalizeArabic(c.alias || '');
        const normName = normalizeArabic(c.name || '');
        const words = normAlias.split(/[\s()\/]+/).filter(w => w.length >= 3 && w !== normName);
        for (const w of words) {
            if (normalized.includes(w)) {
                return c;
            }
        }
        if (normAlias && normalized.includes(normAlias)) return c;
    }

    return null;
}

function isDisambiguationAbandonment(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = normalizeArabic(text);
    return clean.includes('ما اعرفه') || clean.includes('ما اعرفة') || clean.includes('ما اعرفها') ||
           clean.includes('ما اعرف') || clean.includes('ما ادري') || clean.includes('ولا واحد') ||
           clean.includes('ولا شخص') || clean.includes('ولا وحده') || clean.includes('ولا وحدة') ||
           clean.includes('مو ذولي') || clean.includes('مو هذولي') || clean.includes('مو ذولة') ||
           clean.includes('مو هما') || clean.includes('مو هم') || clean.includes('مو هو') || clean.includes('مو هذا') ||
           clean.includes('عوفه') || clean.includes('اتركه') || clean.includes('اترك الموضوع') ||
           clean.includes('انسى') || clean.includes('بطلت') || clean.includes('ما اريد احول') ||
           clean.includes('ما اريد') || clean.includes('هونت');
}

function extractUserPhoneCandidates(text) {
    if (!text || typeof text !== 'string') return [];
    const norm = normalizeDigits(text);
    const regex = /(?:^|[^\d+])(?:(?:\+|00)?964[\s-]*)?0?(7[578](?:[\s-]*\d)+)(?!\d)/g;
    const results = [];
    let match;
    while ((match = regex.exec(norm)) !== null) {
        const rawDigits = match[1].replace(/\D/g, '');
        const full = '0' + rawDigits;
        if (!results.includes(full)) {
            results.push(full);
        }
    }
    return results;
}

function isContactCreationIntent(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = normalizeArabic(text);

    // Common Iraqi contact creation phrases
    const directPhrases = [
        'ضيفه عندك', 'ضيفة عندك', 'احفظه عندك', 'احفظة عندك', 'سجله عندك', 'سجلة عندك',
        'ضيف هذا الرقم', 'احفظ هذا الرقم', 'سجل هذا الرقم', 'خزن هذا الرقم',
        'اي ضيفه عندك', 'اي ضيفه', 'اي احفظه', 'اي سجله', 'إي ضيفه عندك', 'إي ضيفه', 'إي احفظه', 'إي سجله',
        'ضيف جهة اتصال', 'احفظ جهة اتصال', 'اضافة جهة اتصال'
    ];

    if (directPhrases.some(p => clean.includes(p))) return true;

    // Standalone single-word action commands with strict word boundaries (so "مسجلهم" or "المسجلين" is not mistaken for "سجله")
    const singleWordActions = ['ضيفه', 'ضيفة', 'احفظه', 'احفظة', 'سجله', 'سجلة', 'خزنه', 'خزنة'];
    const hasStandaloneAction = singleWordActions.some(w => {
        const regex = new RegExp(`(^|[\\s،,])(${w})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });
    if (hasStandaloneAction) return true;

    const hasAddVerb = clean.includes('ضيف') || clean.includes('اضف') || clean.includes('احفظ') ||
                       (/(^|[\s،,])سجل([\s،,]|$)/.test(clean)) || clean.includes('خزن') || clean.includes('اضافة') || clean.includes('حفظ');

    const hasContactContext = clean.includes('عندك') || clean.includes('بمحفظتك') || clean.includes('بجهات') ||
                             clean.includes('جهات الاتصال') || clean.includes('بالاسماء') || clean.includes('بالاصدقاء') ||
                             clean.includes('رقم') || clean.includes('الرقم') || clean.includes('باسم') ||
                             clean.includes('اسمه') || clean.includes('اسم');

    return hasAddVerb && hasContactContext;
}

function extractContactNameFromMessage(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.trim();

    // Match "باسم ...", "اسمه ...", "سميه ...", "اسم ..."
    const nameMatch = clean.match(/(?:باسم|اسمه|سميه|اسم)\s+([^\s,،]+(?:\s+[^\s,،]+)?)/i);
    if (nameMatch) {
        const rawName = nameMatch[1].trim();
        const stopWords = ['عندك', 'محفظتك', 'رقم', 'هاتف', 'هذا', 'جهة', 'اتصال'];
        if (!stopWords.includes(rawName)) {
            return rawName;
        }
    }

    return null;
}

function isContactsListInquiry(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = normalizeArabic(text);

    // If it's a contact creation/addition, it is NOT an inquiry to show the list!
    if (isContactCreationIntent(text) || clean.includes('ضيف') || clean.includes('اضف') || clean.includes('احفظ') || clean.includes('اضافة') || clean.includes('حفظ')) {
        return false;
    }

    // Direct phrases (including speech-to-text slips like جهاز instead of جهات)
    const phrases = [
        'جهات اتصالي', 'جهات اتصالاتي', 'جهات الاتصال', 'جهات اتصال',
        'جهاز اتصالي', 'جهاز اتصالاتي', 'جهاز الاتصال', 'جهاز اتصال',
        'قائمه اتصالي', 'قائمة اتصالي', 'قائمه اتصالاتي', 'قائمة اتصالاتي', 'قائمه الاتصال', 'قائمة الاتصال', 'قائمه اتصال', 'قائمة اتصال',
        'قائمه جهات اتصال', 'قائمة جهات اتصال', 'قائمه جهات اتصالي', 'قائمة جهات اتصالي', 'قائمه جهات اتصالاتي', 'قائمة جهات اتصالاتي',
        'قائمه جهاز اتصال', 'قائمة جهاز اتصال', 'قائمه جهاز اتصالي', 'قائمة جهاز اتصالي', 'قائمه جهاز اتصالاتي', 'قائمة جهاز اتصالاتي',
        'قائمه الاسماء', 'قائمة الاسماء', 'قائمه اصدقائي', 'قائمة اصدقائي', 'قائمه المعارف', 'قائمة المعارف',
        'منو مسجل عندي', 'منو مسجل بمحفظتي', 'منو مسجل', 'منو عندي',
        'الاشخاص المسجلين', 'الاشخاص اللي مسجلهم', 'الاشخاص المسجله', 'الاشخاص اللي مسجلين',
        'الاسماء المسجله', 'الاسماء اللي مسجلها', 'الارقام المسجله', 'الارقام اللي مسجلها',
        'كل الاسماء', 'ارقام اصدقائي', 'كل جهات الاتصال', 'كل جهات اتصالي'
    ];
    if (phrases.some(p => clean.includes(p))) {
        return true;
    }

    // "اعرض / شوفني / طلعلي / اريد اشوف / شنو / انطيني" + (جهات / جهاز / قائمه / اسماء / اشخاص / اصدقاء / اتصال)
    const hasInquiryLead = clean.includes('اعرض') || clean.includes('عرض') || clean.includes('شوفني') || clean.includes('طلعلي') || clean.includes('اريد اشوف') || clean.includes('شنو') || clean.includes('شو') || clean.includes('انطيني') || clean.includes('طيني') || clean.includes('اريدك');
    const hasContactConcept = clean.includes('اتصال') || clean.includes('اتصالاتي') || clean.includes('اتصالي') || clean.includes('اسماء') || clean.includes('اشخاص') || clean.includes('اصدقاء') || clean.includes('معارف');
    if (hasInquiryLead && hasContactConcept) {
        return true;
    }

    // "قائمه" + ("اتصال" or "اتصالي" or "اتصالاتي" or "اصدقاء" or "اسماء" or "اشخاص" or "معارف" or "جهاز")
    if (clean.includes('قائم') && (clean.includes('اتصال') || clean.includes('اصدقاء') || clean.includes('اسماء') || clean.includes('اشخاص') || clean.includes('معارف') || clean.includes('جهاز'))) {
        return true;
    }

    return false;
}

function handleContactInquiry(userMessage, contacts) {
    if (!userMessage || !Array.isArray(contacts)) return null;
    const clean = normalizeArabic(userMessage);

    const hasInquiryKeywords = 
        isContactsListInquiry(userMessage) ||
        clean.includes('قائم') || clean.includes('اقام') || clean.includes('جهات الاتصال') ||
        clean.includes('اصدقاء') || clean.includes('عندك رقم') || clean.includes('ما عندك رقم') ||
        clean.includes('مسجل عندك') || clean.includes('موجود عندك') || clean.includes('منو مسجل') ||
        clean.includes('شو مسجل') || clean.includes('شنو مسجل') || clean.includes('ارقام اصدقائي') ||
        clean.includes('هل رقم') || clean.includes('رقم منو') || clean.includes('عندك احد');

    if (!hasInquiryKeywords) return null;

    // Check if inquiring about all contacts (e.g. "منو مسجل عندي", "قائمة اتصالاتي", "جهات الاتصال")
    const isGeneralList = 
        isContactsListInquiry(userMessage) ||
        clean.includes('منو مسجل') || clean.includes('كل جهات') || clean.includes('كل الاسماء') ||
        clean.includes('ارقام اصدقائي') || clean.includes('كل اصدقائي') ||
        (clean.includes('منو عندي') && (clean.includes('قائم') || clean.includes('اقام') || clean.includes('اتصال'))) ||
        (clean === 'قائمه اتصالاتي' || clean === 'قائمة اتصالاتي' || clean === 'جهات الاتصال' || clean === 'اصدقائي');

    if (isGeneralList) {
        if (contacts.length === 0) {
            return 'ما عندك أي جهات اتصال مسجلة بمحفظتك حالياً.';
        }
        const list = contacts.map((c, i) => `${i + 1}. ${c.alias || c.name} (${c.phone})`).join('\n');
        return `هاي قائمة بجهات الاتصال المسجلة بمحفظتك:\n\n${list}\n\n💡 تكدر تختار أي شخص منهم وتكلي: "حول 50 الف لسيف" أو "حول 25 الف لأحمد".`;
    }

    // Specific contact inquiry: e.g. "ما عندك رقم جعفر اقامه اتصالاتي", "عندك رقم سيف؟", "هل جعفر مسجل؟"
    for (const c of contacts) {
        const normName = normalizeArabic(c.name || '');
        const normAlias = normalizeArabic(c.alias || '');
        if ((normName && clean.includes(normName)) || (normAlias && clean.includes(normAlias))) {
            return `اي نعم عيوني، مسجل عندك بمحفظتك:\n• الاسم: ${c.alias || c.name}\n• رقم الهاتف: ${c.phone}`;
        }
    }

    // Unknown contact - extract the target name
    const stopWords = ['عندك', 'ماعندك', 'ما', 'هل', 'رقم', 'هاتف', 'موجود', 'مسجل', 'بقائمه', 'باقامه', 'قائمه', 'اقامه', 'اتصالاتي', 'اصدقائي', 'محفظتي', 'حسابي', 'هو', 'هي', 'ليش', 'شنو', 'شو', 'اكو', 'ماكو', 'في', 'من'];
    const words = clean.split(/[\s،,?!.]+/).filter(w => w.length >= 3 && !stopWords.includes(w));
    const targetName = words.length > 0 ? words[0] : 'هذا الشخص';

    return `لا عيوني، ما لقيت أي شخص باسم "${targetName}" مسجل بقائمة اتصالاتك بمحفظتك.\nإذا تحب تكدر تدزلي اسمه ورقمه حتى أضيفه إلك بمحفظتك.`;
}

function classifyRecipient(text, contacts = []) {
    if (!text || typeof text !== 'string') {
        return { type: 'NO_RECIPIENT', valid: false };
    }

    const normText = normalizeDigits(text);
    const clean = normalizeArabic(text);

    // 1. Explicit Account or Card labels
    // Patterns:
    // "حساب رقم 123456789012", "لحساب 123456789012", "بطاقة 1234567890123456", "ماستركارد 1234567890123456"
    const accountLabelRegex = /(?:لحساب|للحساب|حساب(?:\s+مصرفي|\s+بنكي)?|رقم\s+حساب|حساب\s+رقم|لبطاق[هة]|للبطاق[هة]|بطاق[هة](?:\s+مصرفي[هة]|\s+بنكي[هة]|\s+دفع)?|رقم\s+بطاق[هة]|بطاق[هة]\s+رقم|ماستركارد|ماستر\s*كارد|ماستر|فيزا(?:\s*كارد)?|account|card|mastercard|visa)/i;

    if (accountLabelRegex.test(clean)) {
        const acctMatch = normText.match(/(?:(?:لحساب|للحساب|حساب(?:\s+مصرفي|\s+بنكي)?|رقم\s+حساب|حساب\s+رقم|لبطاق[هة]|للبطاق[هة]|بطاق[هة](?:\s+مصرفي[هة]|\s+بنكي[هة]|\s+دفع)?|رقم\s+بطاق[هة]|بطاق[هة]\s+رقم|ماستركارد|ماستر\s*كارد|ماستر|فيزا(?:\s*كارد)?|account|card|mastercard|visa)[\s:]*(?:رقم[\s:]*)?)([0-9\s-]{3,30})/i);

        let candidateDigits = '';
        if (acctMatch) {
            candidateDigits = acctMatch[1].replace(/\D/g, '');
        } else {
            const digitsMatch = normText.match(/\b\d{4,20}\b/);
            if (digitsMatch) {
                candidateDigits = digitsMatch[0];
            }
        }

        if (candidateDigits) {
            const isPhoneShaped = /^0?7[578]\d{8}$/.test(candidateDigits) || /^(?:964)?7[578]\d{8}$/.test(candidateDigits);
            if (!isPhoneShaped) {
                if (candidateDigits.length >= 10 && candidateDigits.length <= 16) {
                    const isCard = /(?:بطاق|ماستر|فيزا|card|visa|mastercard)/i.test(clean);
                    const label = isCard ? `بطاقة مصرفية (${candidateDigits})` : `حساب مصرفي (${candidateDigits})`;
                    return {
                        type: 'ACCOUNT_CARD',
                        valid: true,
                        recipient: label,
                        phone: candidateDigits,
                        accountNumber: candidateDigits,
                        display: label,
                        isCard
                    };
                } else {
                    return {
                        type: 'INVALID_ACCOUNT_CARD',
                        valid: false,
                        error: 'رقم الحساب أو البطاقة المصرفية غير صحيح. يجب أن يتكون من 10 إلى 16 رقماً.',
                        rawDigits: candidateDigits
                    };
                }
            }
        }
    }

    // 2. Iraqi Mobile Phone Detection (Zain 078, Asiacell 077, Korek 075)
    const phoneCandidateRegex = /(?:^|[^\d+])(?:(?:\+|00)?964[\s-]*)?0?(7[578](?:[\s-]*\d)+)(?!\d)/g;
    let match;
    const phoneCandidates = [];
    while ((match = phoneCandidateRegex.exec(normText)) !== null) {
        const rawDigits = match[1].replace(/\D/g, '');
        const full = '0' + rawDigits;
        phoneCandidates.push(full);
    }

    if (phoneCandidates.length > 0) {
        const primaryPhone = phoneCandidates[0];

        // Check for unsupported Iraqi operators (Asiacell 077, Korek 075)
        if (primaryPhone.startsWith('075') || primaryPhone.startsWith('077')) {
            return {
                type: 'UNSUPPORTED_PHONE',
                valid: false,
                error: 'حالياً التحويل مدعوم لأرقام زين اللي تبدي بـ 078 فقط، أو لأرقام الحسابات والبطاقات المصرفية من 10 إلى 16 رقم. أرقام الهاتف اللي تبدي بـ 075 أو 077 غير مدعومة.',
                rawNumber: primaryPhone
            };
        }

        // Check for Zain (078)
        if (primaryPhone.startsWith('078')) {
            if (primaryPhone.length === 11) {
                return {
                    type: 'SUPPORTED_PHONE',
                    valid: true,
                    recipient: `رقم الهاتف (${primaryPhone})`,
                    phone: primaryPhone,
                    display: `رقم الهاتف (${primaryPhone})`
                };
            } else {
                return {
                    type: 'INVALID_PHONE',
                    valid: false,
                    error: 'رقم هاتف زين غير صحيح. يجب أن يتكون الرقم من 11 رقماً ويبدأ بـ 078 (مثال: 07801234567).',
                    rawNumber: primaryPhone
                };
            }
        }
    }

    // 3. Unlabeled Arbitrary Digits (that are NOT phone and NOT amount)
    const allNumberMatches = normText.match(/\b\d{9,18}\b/g);
    if (allNumberMatches && allNumberMatches.length > 0) {
        return {
            type: 'UNKNOWN_DIGITS',
            valid: false,
            error: 'الرقم المدخل غير معروف. يرجى تزويدي برقم هاتف زين يبدأ بـ 078 (11 رقماً)، أو تحديد رقم الحساب أو البطاقة المصرفية صراحة (من 10 إلى 16 رقماً، مثال: لحساب رقم ...).'
        };
    }

    // 4. Contact Book Lookup
    if (Array.isArray(contacts) && contacts.length > 0) {
        const matched = [];
        for (const c of contacts) {
            const normName = normalizeArabic(c.name || '');
            const normAlias = normalizeArabic(c.alias || '');
            const aliasWords = normAlias.split(/[\s()\/]+/).filter(w => w.length >= 3 && w !== normName);

            const nameRegex = new RegExp(`(^|[\\s،,])(ل|الى\\s+|الي\\s+)?(${normName})([\\s،,]|$)`, 'i');
            const matchesName = normName && nameRegex.test(clean);
            const matchesAlias = normAlias && clean.includes(normAlias);
            const matchesAliasWord = aliasWords.some(w => clean.includes(w) && (clean.includes('ل' + w) || clean.includes('الى ' + w) || clean.includes('الي ' + w)));

            if (matchesName || matchesAlias || matchesAliasWord) {
                matched.push(c);
            }
        }

        if (matched.length > 1) {
            return {
                type: 'CONTACT_AMBIGUOUS',
                valid: false,
                matches: matched,
                baseName: matched[0].name
            };
        }

        if (matched.length === 1) {
            return {
                type: 'CONTACT',
                valid: true,
                recipient: matched[0].alias || matched[0].name,
                phone: matched[0].phone,
                contact: matched[0]
            };
        }
    }

    // 5. Unknown Name Check (e.g. "حول لجعفر", "دز لحسن")
    const nameMatch = clean.match(/(?:^|[\s،,])(?:ل|الى\s+|الي\s+)([\u0621-\u064A]{3,15})(?:[\s،,]|$)/);
    const ignoreList = [
        'حسابي', 'محفظتي', 'رصيدي', 'شخص', 'احد', 'واحد', 'صديق', 'فلوس', 'مبلغ', 'رقم',
        'اتي', 'اتصال', 'اتصالي', 'اتصالاتي', 'جهات', 'قائمه', 'قائمة', 'بينهم', 'اي'
    ];
    if (nameMatch && !ignoreList.includes(nameMatch[1])) {
        return {
            type: 'UNKNOWN_NAME',
            valid: false,
            name: nameMatch[1]
        };
    }

    return {
        type: 'NO_RECIPIENT',
        valid: false
    };
}

function handleDirectTransferIntent(userMessage, db, session = null) {
    if (!userMessage || !db) return null;
    const clean = normalizeArabic(userMessage);

    // Exclude balance and transaction inquiries
    if (isBalanceInquiry(userMessage) || isTransactionsInquiry(userMessage)) return null;

    // Exclude bill inquiries/payments
    if (clean.includes('فاتور') || clean.includes('قائم')) return null;

    const transferVerbs = ['حول', 'تحول', 'احول', 'تحولي', 'تحوللي', 'تدز', 'دز', 'ادز', 'ارسل', 'ترسل', 'ابعت', 'ابعث'];
    const isTransferVerb = transferVerbs.some(v => {
        const regex = new RegExp(`(^|[\\s،,])(${v})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });

    const normText = normalizeDigits(userMessage);
    const hasPhoneCandidate = /(?:(?:\+|00)?964[\s-]*)?0?7[578]/.test(normText);
    const hasAccountLabel = /(?:حساب|بطاق[هة]|ماستركارد|ماستر\s*كارد|فيزا|account|card|mastercard|visa)/i.test(clean);

    if (!isTransferVerb && !hasPhoneCandidate && !hasAccountLabel) return null;

    const contacts = db.contacts || [];
    const recipientInfo = classifyRecipient(userMessage, contacts);
    const amount = extractAmount(userMessage);

    // 1. Unsupported Iraqi mobile numbers (075 or 077)
    if (recipientInfo.type === 'UNSUPPORTED_PHONE') {
        return recipientInfo.error;
    }

    // 2. Invalid Zain phone (e.g. invalid length)
    if (recipientInfo.type === 'INVALID_PHONE') {
        return recipientInfo.error;
    }

    // 3. Invalid Account / Card number (length not 10-16)
    if (recipientInfo.type === 'INVALID_ACCOUNT_CARD') {
        return recipientInfo.error;
    }

    // 4. Arbitrary unlabelled digits
    if (recipientInfo.type === 'UNKNOWN_DIGITS') {
        return recipientInfo.error;
    }

    // 5. Ambiguous Contacts (e.g. "أحمد")
    if (recipientInfo.type === 'CONTACT_AMBIGUOUS') {
        if (session) {
            session.pendingDisambiguation = {
                name: recipientInfo.baseName,
                matches: recipientInfo.matches,
                amount: amount
            };
        }
        const listText = recipientInfo.matches.map((c, i) => `${i + 1}. ${c.alias || c.name} (${c.phone})`).join('\n');
        return `يا هلا عيوني، عندك أكثر من جهة اتصال باسم "${recipientInfo.baseName}" بمحفظتك:\n${listText}\n\nيا واحد منهم تقصد؟ يرجى كتابة الرقم أو الاسم الكامل حتى أجهّزلك التحويل.`;
    }

    // 6. Valid Recipient (SUPPORTED_PHONE, ACCOUNT_CARD, CONTACT)
    if (recipientInfo.valid) {
        const targetRecipient = recipientInfo.recipient;
        const targetPhone = recipientInfo.phone;
        const targetDisplay = (targetRecipient.includes(targetPhone) || !targetPhone)
            ? targetRecipient
            : `${targetRecipient} (${targetPhone})`;

        if (amount) {
            if (amount < 250) {
                return 'أقل مبلغ تحويل مسموح به هو 250 د.ع.';
            }
            if (db.user.balance < amount) {
                return `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${amount.toLocaleString()} د.ع.`;
            }
            if (session) {
                session.pendingTransfer = {
                    recipient: targetRecipient,
                    phone: targetPhone,
                    amount: amount
                };
            }
            const remainingBal = db.user.balance - amount;
            return `تفاصيل التحويل:\n• المستلم: ${targetDisplay}\n• المبلغ: ${amount.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
        } else {
            if (session) {
                session.pendingTransferRecipient = {
                    name: targetRecipient,
                    phone: targetPhone
                };
            }
            return `صار عيوني، تم تحديد المستلم: ${targetDisplay}.\nشكد المبلغ اللي تريد تحوله له؟`;
        }
    }

    // 7. Unknown Name Check (e.g. "حول لجعفر")
    if (recipientInfo.type === 'UNKNOWN_NAME') {
        if (amount) {
            return `يا هلا عيوني، ما لقيت أي شخص باسم "${recipientInfo.name}" بقائمة اتصالاتك بمحفظتك.\nحتى أجهّزلك تحويل مبلغ ${amount.toLocaleString()} د.ع، يرجى تزويدي برقم هاتفه.`;
        }
        return `يا هلا عيوني، ما لقيت أي شخص باسم "${recipientInfo.name}" بقائمة اتصالاتك بمحفظتك.\nإذا تريد تحول له، يرجى تزويدي برقم هاتفه والمبلغ اللي تريد تدزه.`;
    }

    // 8. NO_RECIPIENT with transfer verb
    if (isTransferVerb) {
        if (amount) {
            if (session) {
                session.pendingTransferAmount = amount;
            }
            return `شكد حلو! تريد تحول مبلغ ${amount.toLocaleString()} د.ع، بس لمنو تريد تدزه؟ يرجى كتابة اسم الشخص من جهات اتصالك أو رقم هاتف زين (078...) أو رقم حساب/بطاقة مصرفية.`;
        }
        return `تدلل عيوني، لمنو تريد تحول وشكد المبلغ اللي تريد تدزه؟ تكدر تدزلي اسم الشخص أو رقم هاتف زين (078...) أو رقم الحساب/البطاقة.`;
    }

    return null;
}

const CANCELLATION_WORDS = ['لا', 'إلغاء', 'الغاء', 'بطلت', 'هونت', 'ما أريد', 'ما اريد', 'cancel'];

function isUserCancellation(text) {
    if (!text) return false;
    const clean = normalizeArabic(text).trim();

    // If the message has substantive topic words (e.g. asking for contacts, bills, balance, transfer, etc.),
    // even if it starts with "لا", it is a correction or clarification (e.g. "لا قائمة جهات اتصال", "لا مو الفواتير", "لا اقصد الرصيد"),
    // NOT a cancellation!
    const topicWords = ['قائم', 'جهات', 'اتصال', 'اتصالي', 'اتصالاتي', 'جهاز', 'اسماء', 'اشخاص', 'رصيد', 'فلوس', 'فواتير', 'فاتور', 'كهرباء', 'مياه', 'ماء', 'انترنت', 'حول', 'دز', 'ارسل', 'ادفع', 'سدد'];
    const hasTopicWord = topicWords.some(tw => clean.includes(tw));
    if (hasTopicWord) {
        // Only cancel if explicit cancellation keywords (like إلغاء, الغي, بطلت, هونت, ما اريد) are explicitly present
        const explicitCancel = clean.includes('الغاء') || clean.includes('الغي') || clean.includes('إلغاء') || clean.includes('بطلت') || clean.includes('هونت') || clean.includes('ما اريد') || clean.includes('ما أريد') || clean.includes('cancel');
        return explicitCancel;
    }

    // Clarification or correction phrases starting with "لا" (e.g. "لا مو الفواتير", "لا اقصد", "لا اعرضلي", "لا مو هيج")
    // are NOT cancellations of a transaction!
    if (/^لا\s+(مو|اقصد|أقصد|اعرض|أعرض|شوفني|طلع|غلط|ليس|اريد|أريد|خليني)/.test(clean) || clean.includes('لا مو')) {
        return false;
    }

    return CANCELLATION_WORDS.some(w => {
        const nw = normalizeArabic(w);
        const regex = new RegExp(`(^|[\\s،,])(${nw})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });
}

const EXPLICIT_AFFIRMATIONS = [
    'نعم', 'أكد', 'اكد', 'موافق', 'أي', 'اي', 'تمام', 'توكل', 'أكيد', 'اكيد',
    'يلا', 'yes', 'ok', 'confirm'
];

const ACTION_CONFIRMATIONS = [
    'أرسل', 'ارسل', 'دز', 'دزه', 'دزها', 'حول', 'حوله', 'حولها',
    'ادفع', 'ادفعها', 'سدد', 'سددها', 'send'
];

function isUserConfirmation(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = normalizeArabic(text).trim();
    if (isUserCancellation(text)) return false;

    // 1. Explicit affirmative responses (e.g. "نعم", "اي", "اكد", "موافق", "تمام", "توكل", "نعم ادفع الفاتورة")
    const hasAffirmation = EXPLICIT_AFFIRMATIONS.some(word => {
        const normWord = normalizeArabic(word);
        const regex = new RegExp(`(^|[\\s،,])(${normWord})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });
    if (hasAffirmation) return true;

    // 2. Action verbs (e.g. "ادفع", "سدد", "حول", "دز")
    // ONLY considered confirmation when NOT initiating an initial command with biller names, bill keywords, or amounts
    const hasActionVerb = ACTION_CONFIRMATIONS.some(word => {
        const normWord = normalizeArabic(word);
        const regex = new RegExp(`(^|[\\s،,])(${normWord})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });

    if (hasActionVerb) {
        const isInitialCommand = clean.includes('فاتور') || clean.includes('قائم') || clean.includes('حساب') ||
                                 clean.includes('كهرباء') || clean.includes('مياه') || clean.includes('ماء') || clean.includes('ماي') || clean.includes('انترنت') ||
                                 clean.includes('فايبر') || clean.includes('زين') || clean.includes('اسياسيل') || clean.includes('كورك') ||
                                 extractAmount(text) !== null;
        if (!isInitialCommand) {
            return true;
        }
    }

    return false;
}

function isStandaloneNumberedChoice(text) {
    if (!text || typeof text !== 'string') return false;
    const cleanDigits = normalizeDigits(text);
    const clean = normalizeArabic(cleanDigits).replace(/[.,!?،؟]/g, '').trim();

    // 1. Single digit 1-9
    if (/^[1-9]$/.test(clean)) return true;

    // 2. رقم 1 to 9, خيار 1 to 9
    if (/^(رقم|خيار|الخيار)\s*[1-9]$/.test(clean)) return true;

    // 3. Ordinals
    const ordinals = ['الاول', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس'];
    if (ordinals.includes(clean)) return true;

    // 4. الخيار الأول, رقم الاول
    if (/^(رقم|خيار|الخيار)\s*(الاول|الأول|الثاني|الثالث|الرابع|الخامس|السادس)$/.test(clean)) return true;

    return false;
}

const GREETING_WORDS = [
    'اهلا', 'أهلا', 'مرحبا', 'مرحباً', 'هلا', 'هلو', 'يا هلا', 'سلام', 'السلام عليكم', 'سلام عليكم',
    'شلونك', 'شلونكم', 'شخبارك', 'صباح الخير', 'مساء الخير', 'يعطيك العافيه', 'يعطيك العافية'
];

function isGreeting(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length > 5) return false;
    return GREETING_WORDS.some(gw => {
        const normGw = normalizeArabic(gw);
        return clean === normGw || clean.startsWith(normGw + ' ') || clean.endsWith(' ' + normGw);
    });
}

function isBalanceInquiry(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);
    const hasInquiry = clean.includes('رصيد') || clean.includes('شكد عندي') || clean.includes('كم عندي') || clean.includes('فلوسي') || clean.includes('حسابي');
    const isTransfer = (clean.includes('حول') || clean.includes('ارسل') || clean.includes('دز') || clean.includes('ادفع') || clean.includes('سدد')) && (clean.includes('الف') || clean.includes('ألف') || /\d/.test(clean));
    return hasInquiry && !isTransfer;
}

function isTransactionsInquiry(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);
    return clean.includes('سجل الحركات') || clean.includes('سجل المعاملات') || clean.includes('اخر المعاملات') || clean.includes('اخر العمليات') || clean.includes('اخر الحركات') || clean.includes('تاريخ المعاملات') || clean.includes('المعاملات الاخيره') || clean.includes('الحركات الاخيره') || clean.includes('السجل');
}

function isBillInquiry(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);

    // If it's a contacts inquiry, transactions inquiry, or balance inquiry, it is NOT a bill inquiry!
    if (isContactsListInquiry(text) || isTransactionsInquiry(text) || isBalanceInquiry(text)) return false;

    // Contact/Transaction words exclude bill inquiry
    if (clean.includes('اتصال') || clean.includes('اتصالاتي') || clean.includes('اتصالي') || clean.includes('اصدقاء') || clean.includes('اسماء') || clean.includes('اشخاص') || clean.includes('جهاز') || clean.includes('سجل')) return false;

    // Require explicit bill keywords or utility context when mentioning 'قائمه'
    const hasBillKeyword = clean.includes('فاتوره') || clean.includes('فواتير');
    const hasUtilityContext = clean.includes('كهرباء') || clean.includes('مياه') || clean.includes('ماء') || clean.includes('ماي') || clean.includes('انترنت') || clean.includes('نت') || clean.includes('فايبر') || clean.includes('غير مدفوع') || clean.includes('مطلوب');
    const hasBillList = (clean.includes('قوائم') || clean.includes('قائمه')) && hasUtilityContext;

    if (!hasBillKeyword && !hasBillList) return false;

    // Remove bill inquiry descriptors before testing for payment action verbs
    const stripped = clean
        .replace(/غير\s*مدفوع[هة]?/g, '')
        .replace(/الغير\s*مدفوع[هة]?/g, '')
        .replace(/مدفوع[هة]?/g, '')
        .replace(/ما\s*مدفوع[هة]?/g, '')
        .replace(/مطلوب[هة]?/g, '')
        .replace(/المطلوب[هة]?/g, '');

    const isPayment = stripped.includes('ادفع') || stripped.includes('دفع') || stripped.includes('سدد') || stripped.includes('تسديد') || stripped.includes('سدلي') || stripped.includes('ادفعلي') || stripped.includes('حول');
    return !isPayment;
}

function isPayAllBillsRequest(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);
    const hasPayment = clean.includes('ادفع') || clean.includes('دفع') || clean.includes('سدد') || clean.includes('تسديد') || clean.includes('سدلي') || clean.includes('ادفعلي');
    const hasAll = clean.includes('كل الفواتير') || clean.includes('جميع الفواتير') || clean.includes('الفواتير كلها') || clean.includes('كل فواتيري') || clean.includes('كل القوائم') || clean.includes('كلها');
    return hasPayment && hasAll;
}

function findMatchingBill(text, bills) {
    if (!text || !Array.isArray(bills)) return null;
    const clean = normalizeArabic(text);
    const unpaid = bills.filter(b => b.status === 'unpaid');

    // 1. Numeric / Ordinal selection from recent inquiry:
    // e.g. "1", "2", "3", "4", "رقم 1", "فاتورة 2", "نعم 2", "نعم مال 1"
    const singleNumMatch = clean.match(/(?:رقم|فاتوره|قائمه)?\s*([1-9])\b/);
    if (singleNumMatch && (clean.length <= 15 || clean.startsWith('نعم') || clean.startsWith('اي'))) {
        const idx = parseInt(singleNumMatch[1], 10) - 1;
        if (unpaid[idx]) return unpaid[idx];
    }

    if (clean.includes('الاول') || clean.includes('الاولى')) {
        if (unpaid[0]) return unpaid[0];
    }
    if (clean.includes('الثاني') || clean.includes('الثانيه')) {
        if (unpaid[1]) return unpaid[1];
    }
    if (clean.includes('الثالث') || clean.includes('الثالثه')) {
        if (unpaid[2]) return unpaid[2];
    }
    if (clean.includes('الرابع') || clean.includes('الرابعه')) {
        if (unpaid[3]) return unpaid[3];
    }

    // 2. Keyword matching on biller
    for (const b of bills) {
        const normBiller = normalizeArabic(b.biller);

        // Direct full match or account number
        if (clean.includes(normBiller)) return b;
        if (b.account_number && clean.includes(b.account_number.toLowerCase())) return b;

        // Electricity
        if ((clean.includes('كهرباء') || clean.includes('الكرخ')) && normBiller.includes('كهرباء')) {
            return b;
        }

        // Phone / Mobile Line
        if ((clean.includes('خط') || clean.includes('موبايل') || clean.includes('هاتف') || clean.includes('اتصال')) && (normBiller.includes('خط') || normBiller.includes('هاتف') || normBiller.includes('موبايل'))) {
            return b;
        }

        // Water
        if ((clean.includes('مياه') || clean.includes('ماء') || clean.includes('ماي') || clean.includes('البصره')) && normBiller.includes('مياه')) {
            return b;
        }

        // Internet (Match ONLY internet keywords, NEVER the assistant's name 'فاي' alone)
        if ((clean.includes('انترنت') || clean.includes('نت') || clean.includes('فايبر') || clean.includes('واي فاي') || clean.includes('شبكه')) && normBiller.includes('انترنت')) {
            return b;
        }
    }

    return null;
}

function detectBillPaymentIntent(userMessage, bills) {
    if (!userMessage || !Array.isArray(bills)) return null;
    const clean = normalizeArabic(userMessage);
    const unpaid = bills.filter(b => b.status === 'unpaid');

    // 1. Pay all bills
    if (isPayAllBillsRequest(userMessage)) {
        return { type: 'ALL', bills: unpaid };
    }

    // 2. Matching specific bill
    const matched = findMatchingBill(userMessage, bills);
    if (matched) {
        // Confirm it represents a genuine bill payment intent
        const isPaymentVerb = clean.includes('ادفع') || clean.includes('دفع') || clean.includes('سدد') || clean.includes('تسديد') || clean.includes('سدلي') || clean.includes('ادفعلي');
        const isBillKeyword = clean.includes('فاتوره') || clean.includes('قائمه') || clean.includes('حساب');

        if (isPaymentVerb || isBillKeyword) {
            return { type: 'SINGLE', bill: matched };
        }
    }

    return null;
}

async function handleModelActions(rawReply, db, userMessage, providerKey = 'local', session = null) {
    if (!rawReply || typeof rawReply !== 'string') return rawReply;

    const actionRegex = /<<<DB_ACTION>>>([\s\S]*?)<<<END_DB_ACTION>>>/;
    const match = rawReply.match(actionRegex);

    if (!match) {
        // Anti-fabrication safeguard: if model falsely claims a transaction succeeded without <<<DB_ACTION>>>
        const normReply = normalizeArabic(rawReply);
        const claimsPayment = (normReply.includes('تم دفع') || normReply.includes('تم تسديد') || normReply.includes('تم تحويل')) &&
                              (normReply.includes('بنجاح') || normReply.includes('فاتور'));
        if (claimsPayment) {
            console.warn('⚠️ [SECURITY INTERCEPT]: Model fabricated payment success without <<<DB_ACTION>>>. Overriding with safety prompt.');
            return '⚠️ لم يتم تنفيذ أي عملية دفع أو خصم من رصيدك حتى الآن. يرجى تأكيد العملية لتنفيذها بشكل رسمي وآمن.';
        }
        return rawReply;
    }

    let actionPayload = null;
    let parseSuccess = false;

    // Attempt 1: Direct JSON parse
    try {
        actionPayload = JSON.parse(match[1].trim());
        parseSuccess = true;
    } catch (initialErr) {
        console.warn(`⚠️ [DB_ACTION Parse Error]: ${initialErr.message}. Initiating model self-correction...`);

        // Attempt 2: Self-correction loop (Rule 2: Exactly one retry attempt)
        try {
            const selfCorrectionPrompt = [
                {
                    role: "system",
                    content: `You are a strict JSON repair utility. Fix the malformed JSON for a wallet database action.
The action must adhere to one of these schemas:
TRANSFER:
{"action": "TRANSFER", "recipient": "<Name>", "amount": <number>, "phone": "<Phone>"}
BILL_PAYMENT:
{"action": "BILL_PAYMENT", "bill_id": "<Bill ID or 'ALL'>", "biller": "<Biller name>", "amount": <number>, "account_number": "<Account number>"}
ADD_CONTACT:
{"action": "ADD_CONTACT", "name": "<Name>", "alias": "<Name>", "phone": "<Phone>", "wallet_provider": "VI"}

Output ONLY valid, parseable raw JSON. Do NOT include markdown blocks, quotes around the json, or explanatory text.`
                },
                {
                    role: "user",
                    content: `Malformed JSON snippet:
${match[1].trim()}

Parser Error:
${initialErr.message}

Return the corrected valid JSON object only:`
                }
            ];

            const correctionResponse = await callUnifiedChatCompletion(providerKey, selfCorrectionPrompt, {
                temperature: 0.1,
                max_tokens: 300
            });

            let correctedText = (correctionResponse.choices?.[0]?.message?.content || '').trim();
            correctedText = correctedText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            const innerMatch = correctedText.match(/<<<DB_ACTION>>>([\s\S]*?)<<<END_DB_ACTION>>>/);
            if (innerMatch) {
                correctedText = innerMatch[1].trim();
            }

            actionPayload = JSON.parse(correctedText);
            parseSuccess = true;
            console.log('✅ [DB_ACTION Self-Correction Successful]: Malformed action payload repaired.');
        } catch (correctionErr) {
            console.error('❌ [DB_ACTION Self-Correction Failed]:', correctionErr.message);
            parseSuccess = false;
        }
    }

    // Abort mutation if parsing / self-correction failed on second attempt
    if (!parseSuccess || !actionPayload || typeof actionPayload !== 'object') {
        console.error('🚨 [DB_ACTION Aborted]: Action parsing failed after self-correction attempt. Mutation aborted.');
        return '⚠️ عذراً عيوني، حدث خطأ تقني في معالجة بيانات العملية ولم يتم تنفيذ أي تغيير على محفظتك أو رصيدك. يرجى المحاولة مرة أخرى.';
    }

    try {
        if (actionPayload.action === 'TRANSFER') {
            const numericAmt = Number(actionPayload.amount);

            // Rule 3: Schema validation guards
            if (isNaN(numericAmt) || numericAmt <= 0) {
                console.error('[Action Execution Error] Invalid transfer amount in payload:', actionPayload.amount);
                return '⚠️ عذراً عيوني، لم يتم تحديد مبلغ صحيح للتحويل، ولم يُخصم أي مبلغ من رصيدك.';
            }

            if (db.user.balance < numericAmt) {
                return `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${numericAmt.toLocaleString()} د.ع.`;
            }

            const currentPendingTransfer = session?.pendingTransfer || null;
            if (currentPendingTransfer || isUserConfirmation(userMessage)) {
                const toExecute = currentPendingTransfer || {
                    recipient: actionPayload.recipient,
                    amount: numericAmt,
                    phone: actionPayload.phone
                };
                console.log('[Transfer Confirmed & Executed on DB]:', toExecute);
                const result = executeTransferMutation(toExecute);
                if (session) {
                    session.pendingTransfer = null;
                    session.pendingDisambiguation = null;
                }

                const toExecuteDisplay = (toExecute.recipient.includes(toExecute.phone) || !toExecute.phone)
                    ? toExecute.recipient
                    : `${toExecute.recipient} (${toExecute.phone})`;
                return `تم تأكيد التحويل بنجاح! دزيت ${toExecute.amount.toLocaleString()} د.ع إلى ${toExecuteDisplay}. رصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
            } else {
                console.log('[Action Intercepted - Requiring Confirmation]:', actionPayload);
                const newPendingTransfer = {
                    recipient: actionPayload.recipient,
                    amount: numericAmt,
                    phone: actionPayload.phone
                };
                if (session) {
                    session.pendingTransfer = newPendingTransfer;
                }

                const remainingBal = db.user.balance - numericAmt;
                const newPendingDisplay = (newPendingTransfer.recipient.includes(newPendingTransfer.phone) || !newPendingTransfer.phone)
                    ? newPendingTransfer.recipient
                    : `${newPendingTransfer.recipient} (${newPendingTransfer.phone})`;
                return `تفاصيل التحويل المطلوبة:\n• المستلم: ${newPendingDisplay}\n• المبلغ: ${newPendingTransfer.amount.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
            }
        } else if (actionPayload.action === 'BILL_PAYMENT' || actionPayload.action === 'PAY_BILL') {
            const isAll = actionPayload.bill_id === 'ALL' ||
                (typeof actionPayload.biller === 'string' && (actionPayload.biller.toUpperCase() === 'ALL' || normalizeArabic(actionPayload.biller).includes('كل الفواتير')));

            if (isAll) {
                const unpaid = (db.bills || []).filter(b => b.status === 'unpaid');
                if (unpaid.length === 0) {
                    return 'ما عندك أي فواتير غير مدفوعة حالياً بمحفظتك، كل فواتيرك مسددة بالكامل! ✅';
                }

                const totalAmount = unpaid.reduce((sum, b) => sum + Number(b.amount || 0), 0);
                if (db.user.balance < totalAmount) {
                    return `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع كل الفواتير البالغة ${totalAmount.toLocaleString()} د.ع.`;
                }

                const currentPendingBill = session?.pendingBillPayment || null;
                if (currentPendingBill || isUserConfirmation(userMessage)) {
                    const toExecute = currentPendingBill || {
                        type: 'ALL',
                        billIds: unpaid.map(b => b.id),
                        totalAmount: totalAmount,
                        bills: unpaid
                    };
                    const result = executeBillPaymentMutation(toExecute);
                    if (session) {
                        session.pendingBillPayment = null;
                    }
                    return `تم تأكيد دفع كافة الفواتير بنجاح! ✅\nتم تسديد ${result.paidBills.length} فواتير بمجموع ${result.totalAmount.toLocaleString()} د.ع.\nرصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
                } else {
                    const newPendingBill = {
                        type: 'ALL',
                        billIds: unpaid.map(b => b.id),
                        totalAmount: totalAmount,
                        bills: unpaid
                    };
                    if (session) {
                        session.pendingBillPayment = newPendingBill;
                    }
                    const remainingBal = db.user.balance - totalAmount;
                    const billsBreakdown = unpaid.map(b => `• ${b.biller}: ${b.amount.toLocaleString()} د.ع`).join('\n');
                    return `تفاصيل تسديد كافة الفواتير:\n• عدد الفواتير: ${unpaid.length}\n${billsBreakdown}\n• المجموع الكلي: ${totalAmount.toLocaleString()} د.ع\n• الرصيد بعد الدفع: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أسدد كل الفواتير؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                }
            } else {
                let targetBill = null;
                if (actionPayload.bill_id && actionPayload.bill_id !== 'ALL') {
                    targetBill = (db.bills || []).find(b => b.id === actionPayload.bill_id);
                }
                if (!targetBill && actionPayload.account_number) {
                    targetBill = (db.bills || []).find(b => b.account_number && b.account_number.toLowerCase() === String(actionPayload.account_number).toLowerCase());
                }
                if (!targetBill && actionPayload.biller) {
                    const normSearch = normalizeArabic(actionPayload.biller);
                    targetBill = (db.bills || []).find(b => {
                        const nb = normalizeArabic(b.biller);
                        return nb.includes(normSearch) || normSearch.includes(nb);
                    });
                }

                if (!targetBill) {
                    return '⚠️ عذراً عيوني، لم يتم العثور على الفاتورة المطلوبة في قائمة فواتيرك.';
                }

                if (targetBill.status === 'paid') {
                    return `فاتورة "${targetBill.biller}" مسددة مسبقاً وما عليها أي مستحقات حالياً! ✅`;
                }

                const billAmount = Number(targetBill.amount);
                if (isNaN(billAmount) || billAmount <= 0) {
                    return '⚠️ عذراً عيوني، بيانات مبلغ الفاتورة غير صحيحة.';
                }

                if (db.user.balance < billAmount) {
                    return `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع فاتورة ${targetBill.biller} البالغة ${billAmount.toLocaleString()} د.ع.`;
                }

                const currentPendingBill = session?.pendingBillPayment || null;
                if (currentPendingBill || isUserConfirmation(userMessage)) {
                    const toExecute = currentPendingBill || {
                        type: 'SINGLE',
                        billIds: [targetBill.id],
                        totalAmount: billAmount,
                        bills: [targetBill]
                    };
                    const result = executeBillPaymentMutation(toExecute);
                    if (session) {
                        session.pendingBillPayment = null;
                    }
                    return `تم تأكيد دفع الفاتورة بنجاح! ✅\nتم تسديد ${result.totalAmount.toLocaleString()} د.ع لحساب (${targetBill.biller} - ${targetBill.account_number}).\nرصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
                } else {
                    const newPendingBill = {
                        type: 'SINGLE',
                        billIds: [targetBill.id],
                        totalAmount: billAmount,
                        bills: [targetBill]
                    };
                    if (session) {
                        session.pendingBillPayment = newPendingBill;
                    }
                    const remainingBal = db.user.balance - billAmount;
                    return `تفاصيل تسديد الفاتورة:\n• الفاتورة: ${targetBill.biller} (${targetBill.account_number})\n• المبلغ المطلوب: ${billAmount.toLocaleString()} د.ع\n• الرصيد بعد الدفع: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أسدد الفاتورة؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                }
            }
        } else if (actionPayload.action === 'ADD_CONTACT') {
            // Rule 1 (Zero-Regression): Preserve anti-hallucination check with provenance support
            const rawPhoneDigits = String(actionPayload.phone || '').replace(/\D/g, '');
            const userMessageDigits = userMessage.replace(/\D/g, '');

            const isCurrentMessagePhone = rawPhoneDigits.length >= 7 && userMessageDigits.includes(rawPhoneDigits.slice(-7));
            const isUserContextPhone = session?.lastUserPhoneCandidate?.source === 'USER_INPUT' &&
                String(session.lastUserPhoneCandidate.phone || '').replace(/\D/g, '').endsWith(rawPhoneDigits.slice(-7));

            const isAuthenticUserPhone = isCurrentMessagePhone || isUserContextPhone;

            if (!isAuthenticUserPhone) {
                console.warn(`⚠️ [SECURITY INTERCEPT]: Blocked hallucinated ADD_CONTACT action for "${actionPayload.name}" with fake phone "${actionPayload.phone}". User did not provide this number.`);
                return `عذراً عيوني، ما كتبت رقم الهاتف الفعلي لـ "${actionPayload.name}". يرجى كتابة رقم هاتفه حتى أضيفه لك بمحفظتك.`;
            }

            addContactMutation({
                name: actionPayload.name,
                phone: actionPayload.phone,
                alias: actionPayload.alias,
                wallet_provider: actionPayload.wallet_provider
            });

            if (session) {
                session.lastUserPhoneCandidate = null;
                session.pendingContactCreation = null;
            }

            const cleanBotText = rawReply.replace(actionRegex, '').trim();
            if (cleanBotText) {
                return cleanBotText;
            }
            return `تدلل عيوني! تم حفظ "${actionPayload.name}" برقم (${actionPayload.phone}) في جهات اتصال محفظتك بنجاح. ✅`;
        }
    } catch (err) {
        console.error('[Action Execution Error]', err.message);
        return `⚠️ تعذر إتمام العملية: ${err.message}`;
    }

    return rawReply.replace(actionRegex, '').trim();
}

/* ==========================================================================
   Chat API Endpoint
   ========================================================================== */

app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    const selectedProvider = req.body.provider || req.body.model || 'local';
    const sessionId = req.headers['x-session-id'] || req.body?.sessionId || DEFAULT_SESSION_ID;
    const session = getSession(sessionId);
    const idempotencyKey = req.headers['x-idempotency-key'] || req.headers['idempotency-key'] || req.body?.idempotencyKey || req.body?.idempotency_key || null;

    if (!userMessage) {
        return res.status(400).json({ error: 'Message field is required.' });
    }

    // Prominent Terminal Log of the incoming user message
    console.log(`\n======================================================`);
    console.log(`📩 [Incoming User Message]: "${userMessage}"`);
    console.log(`⚙️  [Selected Provider]: "${selectedProvider}" (${PROVIDERS[selectedProvider]?.name || selectedProvider})`);
    console.log(`🆔 [Session ID]: "${sessionId}"`);
    console.log(`======================================================`);

    try {
        const db = readDatabase();

        // Track authentic user-provided phone numbers strictly from the current incoming user message
        const userPhones = extractUserPhoneCandidates(userMessage);
        if (userPhones.length === 1) {
            session.lastUserPhoneCandidate = {
                phone: userPhones[0],
                source: 'USER_INPUT',
                timestamp: Date.now()
            };
            session.recentUserPhoneCandidates = [userPhones[0]];
        } else if (userPhones.length > 1) {
            session.lastUserPhoneCandidate = null; // Ambiguous! Multiple candidate numbers
            session.recentUserPhoneCandidates = userPhones;
        }

        // 0. Direct Balance Inquiry (ALWAYS from disk - Never hallucinated)
        if (isBalanceInquiry(userMessage)) {
            // Supersede any active contact disambiguation
            if (session.pendingDisambiguation) {
                session.pendingDisambiguation = null;
            }
            let reply = `رصيدك الحالي بمحفظتك هسة هو: ${db.user.balance.toLocaleString()} ${db.user.currency || 'IQD'}.`;
            if (session.pendingBillPayment) {
                reply += `\n\n(ملاحظة: عندك طلب معلق لتسديد فاتورة بقيمة ${session.pendingBillPayment.totalAmount.toLocaleString()} د.ع. إذا تريد تكمل كلي "نعم" أو "إلغاء").`;
            } else if (session.pendingTransfer) {
                reply += `\n\n(ملاحظة: عندك طلب معلق لتحويل ${session.pendingTransfer.amount.toLocaleString()} د.ع إلى ${session.pendingTransfer.recipient}. إذا تريد تكمل كلي "نعم" أو "إلغاء").`;
            }
            recordSessionTurn(session, userMessage, reply);
            return res.json({ response: reply });
        }

        // 0b. Direct Transactions History Inquiry (from disk - Always 100% accurate)
        if (isTransactionsInquiry(userMessage)) {
            // Supersede any active contact disambiguation
            if (session.pendingDisambiguation) {
                session.pendingDisambiguation = null;
            }
            const trxs = db.recent_transactions || [];
            let reply = '';
            if (trxs.length === 0) {
                reply = 'ما عندك أي معاملات مسجلة بالسجل حتى الآن بمحفظتك.';
            } else {
                const list = trxs.slice(0, 5).map((t, i) => {
                    const typeText = t.type === 'TRANSFER' ? `تحويل إلى ${t.recipient}` : `دفع فاتورة ${t.biller}`;
                    return `${i + 1}. ${typeText} بمبلغ ${Number(t.amount).toLocaleString()} د.ع بتاريخ ${t.date} (${t.status === 'SUCCESS' ? 'ناجحة ✅' : t.status})`;
                }).join('\n');
                reply = `هاي قائمة بآخر المعاملات المسجلة بمحفظتك:\n\n${list}\n\n💡 تكدر تفتح "السجل" من أعلى الشاشة حتى تشوف كافة التفاصيل والإحصائيات الكاملة!`;
            }
            recordSessionTurn(session, userMessage, reply);
            return res.json({ response: reply, openTransactionsDrawer: true });
        }

        // 0c. Direct Contacts List Inquiry (from disk - Always 100% accurate)
        if (isContactsListInquiry(userMessage)) {
            // Supersede any active contact disambiguation
            if (session.pendingDisambiguation) {
                session.pendingDisambiguation = null;
            }
            const contacts = db.contacts || [];
            let reply = '';
            if (contacts.length === 0) {
                reply = 'ما عندك أي جهات اتصال مسجلة بمحفظتك حالياً.';
            } else {
                const list = contacts.map((c, i) => `${i + 1}. ${c.alias || c.name} (${c.phone})`).join('\n');
                reply = `هاي قائمة بجهات الاتصال المسجلة بمحفظتك:\n\n${list}\n\n💡 تكدر تختار أي شخص منهم وتكلي: "حول 50 الف لسيف" أو "حول 25 الف لأحمد".`;
            }
            recordSessionTurn(session, userMessage, reply);
            return res.json({ response: reply });
        }

        // 1. Check for cancellation at any point
        if (isUserCancellation(userMessage)) {
            if (session.pendingTransfer || session.pendingDisambiguation || session.pendingBillPayment || session.pendingTransferRecipient || session.pendingContactCreation) {
                console.log('\n❌ [Operation Cancelled by User]');
                session.pendingTransfer = null;
                session.pendingDisambiguation = null;
                session.pendingBillPayment = null;
                session.pendingTransferRecipient = null;
                session.pendingContactCreation = null;
                session.lastUserPhoneCandidate = null;
                session.recentUserPhoneCandidates = [];
                const reply = 'صار عيوني، تم إلغاء العملية وما انخصم أي فلس من رصيدك.';
                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            } else {
                const reply = 'صار عيوني، ماكو أي عملية معلقة حالياً حتى ألغيها بمحفظتك.';
                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            }
        }

        // 2. Check if user is confirming an existing pending bill payment
        if (session.pendingBillPayment && isUserConfirmation(userMessage)) {
            try {
                const billParams = {
                    billIds: session.pendingBillPayment.bills ? session.pendingBillPayment.bills.map(b => b.id) : (session.pendingBillPayment.billIds || []),
                    idempotency_key: idempotencyKey || session.pendingBillPayment.idempotency_key || null
                };
                const result = executeBillPaymentMutation(billParams);
                const completed = session.pendingBillPayment;
                session.pendingBillPayment = null;

                console.log(`\n======================================================`);
                console.log(`✅ [TRANSACTION EXECUTED & SAVED TO DATABASE]`);
                console.log(`Transaction Type: BILL PAYMENT`);
                if (completed.type === 'ALL') {
                    console.log(`Paid Bills Count: ${completed.bills.length}`);
                    completed.bills.forEach(b => console.log(`   • ${b.biller} (${b.account_number}): ${b.amount.toLocaleString()} IQD`));
                } else {
                    const bill = completed.bills[0];
                    console.log(`Biller: ${bill.biller}`);
                    console.log(`Account Number: ${bill.account_number}`);
                }
                console.log(`Total Paid: ${result.totalAmount.toLocaleString()} IQD`);
                console.log(`New Wallet Balance: ${result.newBalance.toLocaleString()} IQD`);
                console.log(`Database File: ${DB_FILE_PATH}`);
                console.log(`======================================================\n`);

                let reply = '';
                if (completed.type === 'ALL') {
                    reply = `تم تأكيد دفع كافة الفواتير بنجاح! ✅\nتم تسديد ${completed.bills.length} فواتير بمجموع ${result.totalAmount.toLocaleString()} د.ع.\nرصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
                } else {
                    const bill = completed.bills[0];
                    reply = `تم تأكيد دفع الفاتورة بنجاح! ✅\nتم تسديد ${result.totalAmount.toLocaleString()} د.ع لحساب (${bill.biller} - ${bill.account_number}).\nرصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
                }

                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            } catch (mutationErr) {
                session.pendingBillPayment = null;
                console.error('[Bill Payment Error]:', mutationErr.message);
                const errorReply = `تعذر إتمام دفع الفاتورة: ${mutationErr.message}`;
                recordSessionTurn(session, userMessage, errorReply);
                return res.json({ response: errorReply });
            }
        }

        // 3. Check if user is confirming an existing pending transfer
        if (session.pendingTransfer && isUserConfirmation(userMessage)) {
            try {
                const transferParams = {
                    ...session.pendingTransfer,
                    idempotency_key: idempotencyKey || session.pendingTransfer.idempotency_key || null
                };
                const result = executeTransferMutation(transferParams);
                const completedTrx = session.pendingTransfer;
                session.pendingTransfer = null;
                session.pendingDisambiguation = null;

                console.log(`\n======================================================`);
                console.log(`✅ [TRANSACTION EXECUTED & SAVED TO DATABASE]`);
                console.log(`Transaction Type: TRANSFER`);
                console.log(`Recipient: ${completedTrx.recipient} (${completedTrx.phone})`);
                console.log(`Transfer Amount: ${completedTrx.amount.toLocaleString()} IQD`);
                console.log(`New Wallet Balance: ${result.newBalance.toLocaleString()} IQD`);
                console.log(`Database File: ${DB_FILE_PATH}`);
                console.log(`======================================================\n`);

                const targetDisplay = (completedTrx.recipient.includes(completedTrx.phone) || !completedTrx.phone)
                    ? completedTrx.recipient
                    : `${completedTrx.recipient} (${completedTrx.phone})`;
                const reply = `تم تأكيد التحويل بنجاح! دزيت ${completedTrx.amount.toLocaleString()} د.ع إلى ${targetDisplay}. رصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            } catch (mutationErr) {
                session.pendingTransfer = null;
                console.error('[Transfer Error]:', mutationErr.message);
                const errorReply = `تعذر إتمام التحويل: ${mutationErr.message}`;
                recordSessionTurn(session, userMessage, errorReply);
                return res.json({ response: errorReply });
            }
        }

        // 3b. Check if user is resolving a pending contact creation waiting for a name
        if (session.pendingContactCreation) {
            const rawName = userMessage.replace(/^(باسم|سميه|اسمه|اسم)\s+/i, '').trim();
            if (rawName && rawName.length >= 2 && !isDisambiguationAbandonment(userMessage)) {
                const targetPhone = session.pendingContactCreation.phone;
                const normPhone = targetPhone.replace(/\D/g, '').slice(-10);
                const normName = normalizeArabic(rawName);

                const existingContact = (db.contacts || []).find(c => {
                    const cPhone = (c.phone || '').replace(/\D/g, '').slice(-10);
                    const cName = normalizeArabic(c.name || '');
                    return cPhone === normPhone || cName === normName;
                });

                session.pendingContactCreation = null;
                session.lastUserPhoneCandidate = null;
                session.recentUserPhoneCandidates = [];
                session.pendingTransferRecipient = null;

                if (existingContact) {
                    const isSamePhone = (existingContact.phone || '').replace(/\D/g, '').slice(-10) === normPhone;
                    const warnReply = isSamePhone
                        ? `هذا الرقم (${targetPhone}) مسجل مسبقاً بمحفظتك باسم "${existingContact.name}".`
                        : `الاسم "${rawName}" مسجل مسبقاً بمحفظتك برقم (${existingContact.phone}).`;
                    recordSessionTurn(session, userMessage, warnReply);
                    return res.json({ response: warnReply });
                }

                addContactMutation({
                    name: rawName,
                    phone: targetPhone,
                    alias: rawName,
                    wallet_provider: 'VI'
                });

                const reply = `تدلل عيوني! تم حفظ "${rawName}" برقم (${targetPhone}) في جهات اتصال محفظتك بنجاح. ✅`;
                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            } else {
                session.pendingContactCreation = null;
                session.lastUserPhoneCandidate = null;
                session.recentUserPhoneCandidates = [];
            }
        }

        // 4. Check if user is inquiring about bills ("شنو الفواتير اللي عندي؟" / "شنو هي الفواتير الغير مدفوعة")
        if (isBillInquiry(userMessage)) {
            const unpaid = (db.bills || []).filter(b => b.status === 'unpaid');
            if (unpaid.length === 0) {
                const reply = 'ما عندك أي فواتير غير مدفوعة حالياً بمحفظتك، كل فواتيرك مسددة بالكامل! ✅';
                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            }

            const totalUnpaid = unpaid.reduce((sum, b) => sum + Number(b.amount || 0), 0);
            const list = unpaid.map((b, i) => `${i + 1}. ${b.biller} (رقم الحساب: ${b.account_number}) - المبلغ: ${b.amount.toLocaleString()} د.ع`).join('\n');
            const reply = `عندك ${unpaid.length} فواتير غير مدفوعة حالياً بمحفظتك:\n${list}\n\nالمجموع الكلي: ${totalUnpaid.toLocaleString()} د.ع.\n\nتريد تسدد أي وحدة منها؟ تكدر تكلي: "ادفع مال كهرباء" أو "ادفع رقم 1" أو "ادفع كل الفواتير".`;
            recordSessionTurn(session, userMessage, reply);
            return res.json({ response: reply });
        }

        // 5. Check if user wants to pay ALL bills or a SPECIFIC bill
        const billIntent = detectBillPaymentIntent(userMessage, db.bills);
        if (billIntent) {
            if (billIntent.type === 'ALL') {
                const unpaid = (db.bills || []).filter(b => b.status === 'unpaid');
                if (unpaid.length === 0) {
                    const reply = 'ما عندك أي فواتير غير مدفوعة حالياً بمحفظتك، كل فواتيرك مسددة بالكامل! ✅';
                    recordSessionTurn(session, userMessage, reply);
                    return res.json({ response: reply });
                }

                const totalAmount = unpaid.reduce((sum, b) => sum + Number(b.amount || 0), 0);
                if (db.user.balance < totalAmount) {
                    const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع كل الفواتير البالغة ${totalAmount.toLocaleString()} د.ع.`;
                    recordSessionTurn(session, userMessage, reply);
                    return res.json({ response: reply });
                }

                session.pendingBillPayment = {
                    type: 'ALL',
                    billIds: unpaid.map(b => b.id),
                    totalAmount: totalAmount,
                    bills: unpaid
                };

                const remainingBal = db.user.balance - totalAmount;
                const billsBreakdown = unpaid.map(b => `• ${b.biller}: ${b.amount.toLocaleString()} د.ع`).join('\n');
                const reply = `تفاصيل تسديد كافة الفواتير:\n• عدد الفواتير: ${unpaid.length}\n${billsBreakdown}\n• المجموع الكلي: ${totalAmount.toLocaleString()} د.ع\n• الرصيد بعد الدفع: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أسدد كل الفواتير؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;

                console.log(`\n⏳ [Bill Payment Step 1 - Awaiting User Confirmation]:`);
                console.log(`   Bills Count: ${unpaid.length}`);
                console.log(`   Total Amount: ${totalAmount.toLocaleString()} IQD`);
                console.log(`   Remaining Balance After Payment: ${remainingBal.toLocaleString()} IQD\n`);

                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            } else if (billIntent.type === 'SINGLE') {
                const targetBill = billIntent.bill;
                if (targetBill.status === 'paid') {
                    const reply = `فاتورة "${targetBill.biller}" مسددة مسبقاً وما عليها أي مستحقات حالياً! ✅`;
                    recordSessionTurn(session, userMessage, reply);
                    return res.json({ response: reply });
                }

                if (db.user.balance < targetBill.amount) {
                    const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع فاتورة ${targetBill.biller} البالغة ${targetBill.amount.toLocaleString()} د.ع.`;
                    recordSessionTurn(session, userMessage, reply);
                    return res.json({ response: reply });
                }

                session.pendingBillPayment = {
                    type: 'SINGLE',
                    billIds: [targetBill.id],
                    totalAmount: targetBill.amount,
                    bills: [targetBill]
                };

                const remainingBal = db.user.balance - targetBill.amount;
                const reply = `تفاصيل تسديد الفاتورة:\n• الفاتورة: ${targetBill.biller} (${targetBill.account_number})\n• المبلغ المطلوب: ${targetBill.amount.toLocaleString()} د.ع\n• الرصيد بعد الدفع: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أسدد الفاتورة؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;

                console.log(`\n⏳ [Bill Payment Step 1 - Awaiting User Confirmation]:`);
                console.log(`   Biller: ${targetBill.biller} (${targetBill.account_number})`);
                console.log(`   Amount Due: ${targetBill.amount.toLocaleString()} IQD`);
                console.log(`   Remaining Balance After Payment: ${remainingBal.toLocaleString()} IQD\n`);

                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            }
        }

        // 6. Check if user wants to add/save a contact
        if (isContactCreationIntent(userMessage)) {
            // Check for multiple candidate numbers
            if (session.recentUserPhoneCandidates && session.recentUserPhoneCandidates.length > 1) {
                const reply = `عندي أكثر من رقم (${session.recentUserPhoneCandidates.join(' و ')}). يا رقم منهم تحب أضيفه لجهات الاتصال؟`;
                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            }

            // Determine target phone: from current message or last user-provided candidate
            const currentMsgPhones = extractUserPhoneCandidates(userMessage);
            const targetPhone = currentMsgPhones.length === 1
                ? currentMsgPhones[0]
                : (session.lastUserPhoneCandidate?.source === 'USER_INPUT' ? session.lastUserPhoneCandidate.phone : null);

            if (!targetPhone) {
                const reply = 'تدلل عيوني، يرجى تزويدي برقم الهاتف اللي تحب أضيفه لجهات اتصالك.';
                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            }

            const nameFromMsg = extractContactNameFromMessage(userMessage);
            if (!nameFromMsg) {
                // Name missing: ask user for name
                session.pendingContactCreation = {
                    phone: targetPhone,
                    source: 'USER_INPUT'
                };
                session.pendingTransferRecipient = null;
                const reply = `تدلل عيوني، شنو الاسم اللي تريد أحفظ بيه هذا الرقم (${targetPhone}) بمحفظتك؟`;
                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            } else {
                // Both name and phone known
                const normPhone = targetPhone.replace(/\D/g, '').slice(-10);
                const normName = normalizeArabic(nameFromMsg);

                const existingContact = (db.contacts || []).find(c => {
                    const cPhone = (c.phone || '').replace(/\D/g, '').slice(-10);
                    const cName = normalizeArabic(c.name || '');
                    return cPhone === normPhone || cName === normName;
                });

                session.pendingContactCreation = null;
                session.lastUserPhoneCandidate = null;
                session.recentUserPhoneCandidates = [];
                session.pendingTransferRecipient = null;

                if (existingContact) {
                    const isSamePhone = (existingContact.phone || '').replace(/\D/g, '').slice(-10) === normPhone;
                    const warnReply = isSamePhone
                        ? `هذا الرقم (${targetPhone}) مسجل مسبقاً بمحفظتك باسم "${existingContact.name}".`
                        : `الاسم "${nameFromMsg}" مسجل مسبقاً بمحفظتك برقم (${existingContact.phone}).`;
                    recordSessionTurn(session, userMessage, warnReply);
                    return res.json({ response: warnReply });
                }

                addContactMutation({
                    name: nameFromMsg,
                    phone: targetPhone,
                    alias: nameFromMsg,
                    wallet_provider: 'VI'
                });

                const reply = `تدلل عيوني! تم حفظ "${nameFromMsg}" برقم (${targetPhone}) في جهات اتصال محفظتك بنجاح. ✅`;
                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            }
        }

        // 7. Check if user is resolving an ambiguous contact (pendingDisambiguation)
        if (session.pendingDisambiguation) {
            const matches = session.pendingDisambiguation.matches || [];
            const selected = resolveContactSelection(userMessage, matches);
            if (selected) {
                const amount = extractAmount(userMessage) || session.pendingDisambiguation.amount;
                session.pendingDisambiguation = null;

                if (amount) {
                    if (db.user.balance < amount) {
                        const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${amount.toLocaleString()} د.ع.`;
                        recordSessionTurn(session, userMessage, reply);
                        return res.json({ response: reply });
                    }

                    session.pendingTransfer = {
                        recipient: selected.alias || selected.name,
                        phone: selected.phone,
                        amount: amount
                    };

                    const remainingBal = db.user.balance - amount;

                    console.log(`\n⏳ [Transfer Step 1 - Awaiting User Confirmation]:`);
                    console.log(`   Recipient: ${session.pendingTransfer.recipient} (${session.pendingTransfer.phone})`);
                    console.log(`   Amount: ${session.pendingTransfer.amount.toLocaleString()} IQD`);
                    console.log(`   Remaining Balance After Transfer: ${remainingBal.toLocaleString()} IQD\n`);

                    const reply = `تمام عيوني، اخترت ${selected.alias || selected.name}.\n\nتفاصيل التحويل:\n• المستلم: ${selected.alias || selected.name} (${selected.phone})\n• المبلغ: ${amount.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                    recordSessionTurn(session, userMessage, reply);
                    return res.json({ response: reply });
                } else {
                    session.pendingTransferRecipient = {
                        name: selected.alias || selected.name,
                        phone: selected.phone
                    };
                    const reply = `صار عيوني، اخترت ${selected.alias || selected.name} (${selected.phone}).\nشكد المبلغ اللي تريد تحوله له؟`;
                    recordSessionTurn(session, userMessage, reply);
                    return res.json({ response: reply });
                }
            } else {
                // Invalid, unrelated, or abandoned response: immediately clear pending disambiguation state
                session.pendingDisambiguation = null;
                session.pendingTransfer = null;
                session.pendingTransferRecipient = null;

                if (isDisambiguationAbandonment(userMessage)) {
                    const reply = 'صار عيوني، تم إلغاء اختيار جهة الاتصال وما تم تجهيز أو تنفيذ أي تحويل وما انخصم أي مبلغ من رصيدك.';
                    recordSessionTurn(session, userMessage, reply);
                    return res.json({ response: reply });
                }

                const isOtherIntent = isBalanceInquiry(userMessage) ||
                                      isTransactionsInquiry(userMessage) ||
                                      isBillInquiry(userMessage) ||
                                      detectBillPaymentIntent(userMessage, db.bills) ||
                                      handleContactInquiry(userMessage, db.contacts) ||
                                      findAmbiguousContacts(userMessage, db.contacts);

                if (!isOtherIntent) {
                    const reply = 'لم يتم اختيار أي من الأسماء المعروضة، وتم إلغاء عملية التحديد وما تم تنفيذ أي تحويل.';
                    recordSessionTurn(session, userMessage, reply);
                    return res.json({ response: reply });
                }
            }
        }

        // 8. Check if the user message mentions a name matching multiple contacts
        const ambiguous = findAmbiguousContacts(userMessage, db.contacts);
        if (ambiguous) {
            const extractedAmt = extractAmount(userMessage);
            session.pendingTransfer = null;
            session.pendingTransferRecipient = null;
            session.pendingDisambiguation = {
                name: ambiguous.baseName,
                matches: ambiguous.matches,
                amount: extractedAmt
            };

            console.log(`\n🔍 [Contact Disambiguation]: Found ${ambiguous.matches.length} contacts matching "${ambiguous.baseName}". Waiting for user selection.`);

            const listText = ambiguous.matches.map((c, i) => `${i + 1}. ${c.alias || c.name} (${c.phone})`).join('\n');
            const reply = `يا هلا عيوني، عندك أكثر من جهة اتصال باسم "${ambiguous.baseName}" بمحفظتك:\n${listText}\n\nيا واحد منهم تقصد؟ يرجى كتابة الرقم أو الاسم الكامل حتى أجهّزلك التحويل.`;
            recordSessionTurn(session, userMessage, reply);
            return res.json({ response: reply });
        }

        // 9. Check if user is resolving a pending recipient waiting for an amount
        if (session.pendingTransferRecipient) {
            const extractedAmt = extractAmount(userMessage);
            if (extractedAmt) {
                const target = session.pendingTransferRecipient;
                session.pendingTransferRecipient = null;

                if (extractedAmt < 250) {
                    session.pendingTransferRecipient = target;
                    const reply = 'أقل مبلغ تحويل مسموح به هو 250 د.ع.';
                    recordSessionTurn(session, userMessage, reply);
                    return res.json({ response: reply });
                }

                if (db.user.balance < extractedAmt) {
                    const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${extractedAmt.toLocaleString()} د.ع.`;
                    recordSessionTurn(session, userMessage, reply);
                    return res.json({ response: reply });
                }

                session.pendingTransfer = {
                    recipient: target.name,
                    phone: target.phone,
                    amount: extractedAmt
                };

                const remainingBal = db.user.balance - extractedAmt;
                const targetDisplay = (target.name.includes(target.phone) || !target.phone)
                    ? target.name
                    : `${target.name} (${target.phone})`;
                const reply = `تفاصيل التحويل:\n• المستلم: ${targetDisplay}\n• المبلغ: ${extractedAmt.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                recordSessionTurn(session, userMessage, reply);
                return res.json({ response: reply });
            }
        }

        // 10. Check if user is inquiring about contacts ("ما عندك رقم جعفر؟", "منو مسجل عندي؟", "هل فلان مسجل؟")
        const contactInquiryReply = handleContactInquiry(userMessage, db.contacts);
        if (contactInquiryReply) {
            recordSessionTurn(session, userMessage, contactInquiryReply);
            return res.json({ response: contactInquiryReply });
        }

        // 11. Check direct transfer intent (e.g. "هل تقدر تحول لي لجعفر", "حول لسيف", "حول 50 الف لحسين")
        const transferIntentReply = handleDirectTransferIntent(userMessage, db, session);
        if (transferIntentReply) {
            recordSessionTurn(session, userMessage, transferIntentReply);
            return res.json({ response: transferIntentReply });
        }

        // 12. Check if user sent a standalone numbered choice when no selection prompt is active
        if (isStandaloneNumberedChoice(userMessage) && !session.pendingDisambiguation && !session.pendingBillPayment && !session.pendingTransfer && !session.pendingTransferRecipient && !session.pendingContactCreation) {
            const reply = 'ماكو أي خيارات أو قائمة معروضة حالياً للاختيار منها. بشنو أگدر أساعدك بمحفظتك؟';
            recordSessionTurn(session, userMessage, reply);
            return res.json({ response: reply });
        }

        const dbData = JSON.stringify(db, null, 2);
        const unpaidBills = (db.bills || []).filter(b => b.status === 'unpaid');
        const totalUnpaidAmount = unpaidBills.reduce((sum, b) => sum + Number(b.amount || 0), 0);
        const proactiveDigest = unpaidBills.length > 0
            ? `تنبيه مالي استباقي دقيق: المستخدم لديه ${unpaidBills.length} فواتير غير مدفوعة بإجمالي ${totalUnpaidAmount.toLocaleString()} د.ع (${unpaidBills.map(b => `${b.biller} بقيمة ${Number(b.amount).toLocaleString()} د.ع`).join('، ')}). عندما يحييك المستخدم أو يسألك شلونك أو يبدأ المحادثة، بعد الترحيب العراقي الدافئ، اذكره برصيده الحالي (${db.user.balance.toLocaleString()} د.ع) ونبهه بلطف عن فواتيره غير المسددة واقترح عليه سدادها.`
            : `تنبيه مالي استباقي دقيق: رصيد المستخدم ${db.user.balance.toLocaleString()} د.ع، وليس عليه أي فواتير متأخرة نهائياً. عند الترحيب، طمئنه بأن كل فواتيره مسددة ووضعه المالي ممتاز.`;

        const systemPrompt = `You are "فاي" (VI) — a smart, friendly, highly capable Iraqi AI financial assistant for digital wallets.

IDENTITY & NAME RULES (MANDATORY):
- Your name is "فاي" (VI) — المساعد المالي الذكي.
- You are strictly an independent AI assistant. Your name is exclusively "فاي" (VI). NEVER claim any name other than "فاي (VI)" or associate your identity with any external telecom or wallet company.
- When asked "شنو اسمك؟", "منو انت؟", "مو اسمك فاي؟", or asked to introduce yourself: Always confirm with clarity, confidence, and warmth in Iraqi Arabic:
  "اسمي فاي (VI) - مساعدك المالي الذكي، وبخدمتك دائماً لمساعدتك في محفظتك الرقمية، التحويلات، ودفع الفواتير بكل سهولة وأمان!"

LANGUAGE & PERSONALITY:
- Always speak in authentic, warm, polite Iraqi Arabic dialect (لهجة عراقية محبوبة وراقية).
- Use natural expressions: "عيوني"، "تدلل"، "بخدمتك"، "شلون أگدر أساعدك"، "هسة"، "شكد"، "يا هلا"، "تسلم"، "ماكو".
- Strictly avoid Egyptian words (like "عايز", "عشان") or Gulf words (like "تبي"). You are proudly Iraqi.
- Be perceptive, intelligent, and understand the real meaning of the user's words.

PROACTIVE FINANCIAL INTELLIGENCE & WALLET CONTEXT:
${proactiveDigest}

CASUAL CONVERSATION & SOCIAL CHAT (CRITICAL):
- When the user talks to you socially or asks about your well-being:
  * "دا اسأل عليك" (I'm checking up on you / asking how you are) / "شلونك" / "شخبارك" / "شكو ماكو" / "هلا" / "مرحبا" / "هلو":
    The user is asking how YOU (فاي) are doing or greeting you! Words like "عليك" or "فاي" are NEVER person names or recipients for a financial transfer!
    Reply politely, warmly, and authentically in Iraqi Arabic. After acknowledging their greeting gracefully, mention their current wallet balance and proactively suggest reviewing or settling unpaid bills if any, or reassuring them that their finances are in order.
  * "شكراً" / "عاشت ايدك" / "تسلم" / "مشكور": Reply gracefully ("تدلل عيوني بخدمتك", "وايدك العايشة يا غالي").
- DO NOT treat friendly conversation as an error, and DO NOT say "هذا الشخص مو مسجل بقائمة اتصالاتك" unless the user is EXPLICITLY requesting to transfer money to a named person!

GENERAL INTELLIGENCE & OFF-TOPIC QUESTIONS:
- You are a fully capable AI model. If the user asks general questions (math, calculations, explanation, daily advice): Answer smartly, concisely, and helpfully in Iraqi Arabic, then politely remind them that you are also ready to assist with their wallet whenever they need.

CURRENT DATABASE CONTEXT:
${dbData}

CURRENT USER BALANCE:
${db.user.balance} IQD (${db.user.balance.toLocaleString()} دينار عراقي).

ARITHMETIC CHECK:
The user currently has ${db.user.balance.toLocaleString()} IQD. 
Transfer amounts such as 100,000 IQD (100 ألف) or 50,000 IQD are STRICTLY LESS than ${db.user.balance.toLocaleString()} IQD and ARE VALID. Do NOT claim the balance is insufficient when the requested amount is <= ${db.user.balance}!

CRITICAL TRUTH & ANTI-HALLUCINATION RULES:
1. NEVER INVENT PHONE NUMBERS: You are STRICTLY FORBIDDEN from inventing, fabricating, or guessing any phone number. You may ONLY use phone numbers explicitly provided by the user in their message or already stored in CURRENT DATABASE CONTEXT.
2. NEVER INVENT TRANSFER AMOUNTS: If the user didn't mention a specific amount, DO NOT assume a number! Always ask: "شكد المبلغ اللي تريد تحوله؟"
3. ONLY PROCESS TRANSFERS WHEN INTENT IS CLEAR: Only look for contacts when the user clearly asks to send money (e.g. "حول", "دز", "ارسل"). If an explicit recipient name does not exist in contacts and no phone number was given, explain: "هذا الشخص مو مسجل بقائمة اتصالاتك" and ask for their phone number.
4. NEVER CLAIM TO ADD A CONTACT unless the user explicitly provided both the name and a real phone number in their message.
5. NO STALE NUMBER SELECTIONS: Never interpret a standalone number (e.g. "1", "2") as selecting a contact or executing a transfer from an earlier conversation turn if no disambiguation list is currently active.

DECISION FLOW (Evaluate in order):

1. BALANCE INQUIRY:
If the user asks about their balance, reply with their exact balance from user.balance (${db.user.balance.toLocaleString()} ${db.user.currency}). Do not guess.

2. AMOUNT CHECKS:
- If the amount is zero or negative: Reject in Iraqi dialect. Transfer amounts must be positive numbers.
- If the amount exceeds current balance (${db.user.balance} IQD): Stop immediately and explain that the balance is insufficient.

3. CONTACT CHECKS & INITIAL TRANSFER REQUEST (Search strictly in "contacts"):
- No Match: If the name does not exist at all, say that the contact is not in their list and ask for their phone number.
- Multiple Matches: If the user says a name that matches more than one entry, list all matching contacts with their full names and phone numbers. Ask the user to choose which one. DO NOT confirm or transfer yet.
- Single Match: Summarize recipient name, phone, amount, and remaining balance. Ask clearly: "متأكد تريد أحول؟ (يرجى الرد بـ نعم أو إلغاء)"
CRITICAL SECURITY RULE: NEVER output <<<DB_ACTION>>> in this step! You must WAIT for the user to explicitly confirm in their next message.

4. TRANSFER CONFIRMATION:
- If and ONLY IF the assistant previously asked for confirmation and the user replies with explicit confirmation (e.g. "نعم", "أكد", "موافق", "أي", "توكل", "أرسل", "دز"):
Confirm success warmly, and attach the action tag at the very end:
<<<DB_ACTION>>>
{
  "action": "TRANSFER",
  "recipient": "<Full Name>",
  "amount": <number>,
  "phone": "<Phone>"
}
<<<END_DB_ACTION>>>
- If the user says "لا" or "إلغاء": Confirm cancellation without any action tag.

5. ADD CONTACT:
- If the user asks to save or add a contact:
Confirm addition, and attach the action tag at the very end:
<<<DB_ACTION>>>
{
  "action": "ADD_CONTACT",
  "name": "<Name>",
  "alias": "<Name>",
  "phone": "<Phone>",
  "wallet_provider": "VI"
}
<<<END_DB_ACTION>>>

6. BILL PAYMENT:
- If the user asks to pay a bill or all bills, summarize the bill(s), total amount, and remaining balance. Ask clearly: "متأكد تريد أسدد الفاتورة؟ (يرجى الرد بـ نعم أو إلغاء)"
CRITICAL SECURITY RULE: NEVER output <<<DB_ACTION>>> in this step! You must WAIT for the user to explicitly confirm in their next message.
- If and ONLY IF the assistant previously asked for confirmation and the user replies with explicit confirmation (e.g. "نعم", "أكد", "موافق", "أي", "توكل", "ادفع"):
Confirm success warmly, and attach the action tag at the very end:
<<<DB_ACTION>>>
{
  "action": "BILL_PAYMENT",
  "bill_id": "<Bill ID or ALL>",
  "biller": "<Biller name>",
  "amount": <number>,
  "account_number": "<Account number>"
}
<<<END_DB_ACTION>>>
- If the user says "لا" or "إلغاء": Confirm cancellation without any action tag.

7. CONTACTS LIST INQUIRY & REGISTERED PEOPLE:
- If the user asks to see, view, or list their contacts, friends, or registered people/numbers in any way (e.g. "اعرض لي جهات اتصالاتي", "قائمة اتصالي", "شنو الاشخاص اللي مسجلهم", "منو مسجل عندي", "شوفني الاسماء", "قائمة جهاز اتصالاتي"):
  List all registered contacts directly from the "contacts" array in CURRENT DATABASE CONTEXT above, in a clear, friendly numbered list with their names, aliases, and phone numbers.
  Politely inform the user that they can easily transfer to any of them by stating their name and the amount (e.g. "حول 50 الف لسيف").
  CRITICAL: NEVER return unpaid bills when the user asked about contacts or registered people!`;

        appendToConversationHistory(session, "user", userMessage);

        const payloadMessages = [
            { role: "system", content: systemPrompt },
            ...session.conversationHistory
        ];

        let rawBotReply = '';
        try {
            console.log(`🤖 [Routing to Provider]: "${selectedProvider}" (${PROVIDERS[selectedProvider]?.name || selectedProvider})`);
            const completion = await callUnifiedChatCompletion(selectedProvider, payloadMessages, {
                temperature: 0.2,
                max_tokens: 500
            });
            rawBotReply = completion.choices?.[0]?.message?.content || "(لم يتم استلام رد من النموذج)";
        } catch (fetchErr) {
            console.error(`[${selectedProvider} Completion Error]:`, fetchErr.message);
            let offlineReply = '';
            if (fetchErr.message && (fetchErr.message.includes('النموذج الأساسي') || fetchErr.message.includes('المزود الاحتياطي') || fetchErr.message.includes('مفتاح الـ API'))) {
                offlineReply = `⚠️ ${fetchErr.message}`;
            } else if (selectedProvider === 'local') {
                offlineReply = '⚠️ عيوني، نموذج الذكاء الاصطناعي (LM Studio) غير متصل حالياً أو ما زال قيد التحميل في الحاسبة.\n\nيرجى التأكد من تشغيل السيرفر من داخل برنامج LM Studio (الضغط على Start Server على البورت 1234) حتى أگدر أفكر وأجاوبك مباشرة!';
            } else if (selectedProvider === 'gemini') {
                offlineReply = `⚠️ تعذر الاتصال بنموذج Google Gemini.\n\nالسبب: ${fetchErr.message}\n\n💡 يرجى التأكد من ضبط GEMINI_API_KEY داخل ملف .env والتأكد من توفر اتصال بالإنترنت.`;
            } else if (selectedProvider === 'groq') {
                offlineReply = `⚠️ تعذر الاتصال بنموذج Groq.\n\nالسبب: ${fetchErr.message}\n\n💡 يرجى التأكد من ضبط GROQ_API_KEY داخل ملف .env والتأكد من توفر اتصال بالإنترنت.`;
            } else {
                offlineReply = `⚠️ خطأ في الاتصال بالنموذج (${selectedProvider}): ${fetchErr.message}`;
            }
            appendToConversationHistory(session, "assistant", offlineReply);
            return res.json({ response: offlineReply });
        }

        const cleanBotReply = await handleModelActions(rawBotReply, db, userMessage, selectedProvider, session);
        appendToConversationHistory(session, "assistant", cleanBotReply);

        res.json({ response: cleanBotReply });

    } catch (error) {
        console.error('[Server Error]:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/db', (req, res) => {
    try {
        const db = readDatabase();
        res.json(db);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/transactions', (req, res) => {
    try {
        const db = readDatabase();
        const trxs = db.recent_transactions || [];
        const totalSpent = trxs.reduce((sum, t) => sum + Number(t.amount || 0), 0);
        res.json({
            transactions: trxs,
            balance: db.user.balance,
            currency: db.user.currency || 'IQD',
            userName: db.user.name || 'محمد',
            totalSpent,
            count: trxs.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/contacts', (req, res) => {
    try {
        const db = readDatabase();
        res.json({
            contacts: db.contacts || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/bills', (req, res) => {
    try {
        const db = readDatabase();
        res.json({
            bills: db.bills || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/reset', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body?.sessionId || DEFAULT_SESSION_ID;
    resetSession(sessionId);
    resetDatabase();
    console.log(`🔄 [Session "${sessionId}" history, pending state, and wallet database reset to defaults]`);
    res.json({ status: 'Conversation history and database reset successful', sessionId });
});

/* ==========================================================================
   مسارات تسجيل تقييمات الذكاء الاصطناعي (Likes & Dislikes)
   ========================================================================== */

app.post('/api/feedback', (req, res) => {
    try {
        const { type, msgId, userMessage, botResponse, theme } = req.body || {};

        if (!type || !msgId) {
            return res.status(400).json({ error: 'Missing required feedback fields: type, msgId' });
        }

        let likes = readFeedbackFile(FEEDBACK_LIKES_PATH);
        let dislikes = readFeedbackFile(FEEDBACK_DISLIKES_PATH);

        // Remove any prior evaluation with the same msgId from both files to ensure clean state
        likes = likes.filter(item => item.msgId !== msgId);
        dislikes = dislikes.filter(item => item.msgId !== msgId);

        const now = new Date();
        const readableDate = now.toLocaleString('ar-IQ', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });

        if (type === 'like') {
            const record = {
                id: `fb_like_${Date.now()}`,
                msgId,
                type: 'like',
                userMessage: userMessage || '',
                botResponse: botResponse || '',
                theme: theme || 'dark',
                timestamp: now.toISOString(),
                readableDate
            };
            likes.unshift(record); // Prepend to top
            saveFeedbackFile(FEEDBACK_LIKES_PATH, likes);
            saveFeedbackFile(FEEDBACK_DISLIKES_PATH, dislikes);
            console.log(`👍 [Feedback] Like recorded for msgId: ${msgId}`);
            return res.json({ success: true, action: 'liked', recordId: record.id, totalLikes: likes.length });
        } else if (type === 'dislike') {
            const record = {
                id: `fb_dislike_${Date.now()}`,
                msgId,
                type: 'dislike',
                userMessage: userMessage || '',
                botResponse: botResponse || '',
                theme: theme || 'dark',
                timestamp: now.toISOString(),
                readableDate
            };
            dislikes.unshift(record); // Prepend to top
            saveFeedbackFile(FEEDBACK_DISLIKES_PATH, dislikes);
            saveFeedbackFile(FEEDBACK_LIKES_PATH, likes);
            console.log(`👎 [Feedback] Dislike recorded for msgId: ${msgId}`);
            return res.json({ success: true, action: 'disliked', recordId: record.id, totalDislikes: dislikes.length });
        } else if (type === 'remove') {
            saveFeedbackFile(FEEDBACK_LIKES_PATH, likes);
            saveFeedbackFile(FEEDBACK_DISLIKES_PATH, dislikes);
            console.log(`🔄 [Feedback] Feedback cleared for msgId: ${msgId}`);
            return res.json({ success: true, action: 'removed' });
        }

        res.status(400).json({ error: 'Invalid feedback type' });
    } catch (err) {
        console.error('[Feedback API Error]:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/feedback/likes', (req, res) => {
    try {
        const likes = readFeedbackFile(FEEDBACK_LIKES_PATH);
        res.json({ total: likes.length, items: likes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/feedback/dislikes', (req, res) => {
    try {
        const dislikes = readFeedbackFile(FEEDBACK_DISLIKES_PATH);
        res.json({ total: dislikes.length, items: dislikes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/audit', (req, res) => {
    try {
        const logs = readAuditLog();
        res.json({ total: logs.length, logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function splitTextIntoTtsChunks(text, maxLength = 180) {
    if (!text || typeof text !== 'string') return [];
    if (text.length <= maxLength) return [text];

    const sentences = text.match(/[^،.؟!\n]+[،.؟!\n]*/g) || [text];
    const chunks = [];
    let currentChunk = '';

    for (const sentence of sentences) {
        if ((currentChunk + ' ' + sentence).trim().length <= maxLength) {
            currentChunk = (currentChunk + ' ' + sentence).trim();
        } else {
            if (currentChunk) chunks.push(currentChunk);
            if (sentence.length > maxLength) {
                const words = sentence.split(' ');
                let wordChunk = '';
                for (const word of words) {
                    if ((wordChunk + ' ' + word).trim().length <= maxLength) {
                        wordChunk = (wordChunk + ' ' + word).trim();
                    } else {
                        if (wordChunk) chunks.push(wordChunk);
                        wordChunk = word;
                    }
                }
                currentChunk = wordChunk;
            } else {
                currentChunk = sentence.trim();
            }
        }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks;
}

app.post('/api/tts', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: 'Text is required' });
        }

        // Clean text from internal action tags, markdown, and emojis for smooth TTS
        const cleanText = text
            .replace(/<<<DB_ACTION>>>[\s\S]*?<<<END_DB_ACTION>>>/g, '')
            .replace(/[*#_~`]/g, '')
            .replace(/\bIQD\b/gi, 'دينار عراقي')
            .replace(/د\.ع/g, 'دينار عراقي')
            .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
            .trim();

        if (!cleanText) {
            return res.status(400).json({ error: 'Clean text is empty' });
        }

        const apiKey = process.env.ELEVENLABS_API_KEY;

        // 1. If ElevenLabs is configured, use it for luxury cloned/custom voice
        if (apiKey) {
            const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
            const elevenUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

            const elevenRes = await fetch(elevenUrl, {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg'
                },
                body: JSON.stringify({
                    text: cleanText.substring(0, 600),
                    model_id: 'eleven_multilingual_v2',
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.8
                    }
                })
            });

            if (elevenRes.ok) {
                const audioBuffer = await elevenRes.arrayBuffer();
                res.set({
                    'Content-Type': 'audio/mpeg',
                    'Cache-Control': 'no-cache',
                    'X-TTS-Engine': 'elevenlabs'
                });
                return res.send(Buffer.from(audioBuffer));
            } else {
                const errText = await elevenRes.text();
                console.warn(`[ElevenLabs TTS Error]: HTTP ${elevenRes.status}: ${errText}`);
            }
        }

        // 2. High-Fidelity Free Google Arabic Neural Voice (Zero Config / Free)
        try {
            const chunks = splitTextIntoTtsChunks(cleanText, 180);
            const audioBuffers = [];

            for (const chunk of chunks) {
                const googleUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=ar&client=tw-ob&q=${encodeURIComponent(chunk)}`;
                const googleRes = await fetch(googleUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                if (googleRes.ok) {
                    audioBuffers.push(Buffer.from(await googleRes.arrayBuffer()));
                }
            }

            if (audioBuffers.length > 0) {
                const combined = Buffer.concat(audioBuffers);
                res.set({
                    'Content-Type': 'audio/mpeg',
                    'Cache-Control': 'no-cache',
                    'X-TTS-Engine': 'google-arabic-cloud'
                });
                return res.send(combined);
            }
        } catch (cloudErr) {
            console.warn('[Google Arabic TTS Error]:', cloudErr.message);
        }

        // 3. Fallback to client browser SpeechSynthesis
        return res.status(501).json({ error: 'TTS cloud providers unavailable', fallback: 'browser' });
    } catch (err) {
        console.error('[TTS API Error]:', err.message);
        return res.status(500).json({ error: err.message, fallback: 'browser' });
    }
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
        console.log(`====================================================`);
        console.log(`  AI Financial Agent Backend running on port ${PORT}`);
        console.log(`  Connected to LM Studio: ${LM_STUDIO_URL}`);
        console.log(`  Database File: ${DB_FILE_PATH}`);
        console.log(`====================================================`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`\n[Notice]: Port ${PORT} is already in use by another running process.`);
            console.error(`If the server is already running, you do not need to start it again.\n`);
        } else {
            console.error('\n[Server Error]:', err.message);
        }
    });
}

module.exports = {
    app,
    normalizeDigits,
    normalizeArabic,
    extractAmount,
    classifyRecipient,
    handleDirectTransferIntent,
    executeTransferMutation,
    executeBillPaymentMutation,
    addContactMutation,
    handleModelActions,
    findAmbiguousContacts,
    resolveContactSelection,
    isDisambiguationAbandonment,
    extractUserPhoneCandidates,
    isContactCreationIntent,
    extractContactNameFromMessage,
    detectBillPaymentIntent,
    findMatchingBill,
    isBillInquiry,
    isContactsListInquiry,
    isUserCancellation,
    isUserConfirmation,
    isStandaloneNumberedChoice,
    MAX_CONVERSATION_HISTORY,
    appendToConversationHistory,
    recordSessionTurn,
    trimConversationHistory,
    readDatabase,
    saveDatabase,
    getSession,
    resetSession,
    resetDatabase,
    readAuditLog,
    appendAuditLog,
    clearAuditLog,
    AUDIT_LOG_PATH,
    splitTextIntoTtsChunks
};