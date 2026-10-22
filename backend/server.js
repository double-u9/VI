const express = require('express');
const cors = require('cors');
const path = require('path');

// Load environment variables securely from .env in project root
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { LM_STUDIO_URL, DB_FILE_PATH, AUDIT_LOG_PATH, MAX_CONVERSATION_HISTORY } = require('./src/config/providers');
const { EXCHANGE_RATE_CONFIG, getExchangeRate } = require('./src/config/exchangeRate');

// Middlewares
const { securityHeaders } = require('./src/middlewares/securityHeaders');
const { sessionValidator } = require('./src/middlewares/sessionValidator');
const { errorHandler } = require('./src/middlewares/errorHandler');
const { chatRateLimiter, ttsRateLimiter, createTokenBucketRateLimiter, TokenBucket } = require('./src/middlewares/rateLimiter');

// Controllers
const { handleChat } = require('./src/controllers/chatController');
const { getExchangeRateHandler, getDbHandler, getTransactionsHandler, resetHandler } = require('./src/controllers/walletController');
const { getBillsHandler } = require('./src/controllers/billsController');
const { getContactsHandler } = require('./src/controllers/contactsController');
const { submitFeedbackHandler, getLikesHandler, getDislikesHandler } = require('./src/controllers/feedbackController');
const { getAuditLogsHandler } = require('./src/controllers/auditController');
const { handleTts } = require('./src/controllers/ttsController');

// Services (for facade exports & backward compatibility)
const {
    normalizeDigits,
    normalizeArabic,
    extractAmount,
    classifyRecipient,
    handleDirectTransferIntent,
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
    evaluateHybridIntent,
    classifySemanticIntent,
    CONFIDENCE_THRESHOLD
} = require('./src/services/nlpRouter');

const {
    readDatabase,
    saveDatabase,
    resetDatabase,
    executeTransferMutation,
    executeBillPaymentMutation,
    addContactMutation,
    handleModelActions
} = require('./src/services/walletService');

const {
    getSqliteDb,
    closeSqliteDb,
    resetSqliteDatabase,
    exportSqliteToJson,
    exportAuditSqliteToJson,
    syncSqliteWithJsonObject,
    executeTransferTransaction,
    executeBillPaymentTransaction,
    addContactTransaction,
    SQLITE_DB_PATH
} = require('./src/services/sqliteDb');

const {
    getSession,
    resetSession,
    appendToConversationHistory,
    recordSessionTurn,
    trimConversationHistory,
    loadSessionsFromDisk,
    reloadSessionsFromDisk,
    saveSessionsSync,
    pruneExpiredSessions,
    createInitialSessionState,
    sessions
} = require('./src/services/sessionStore');
const { SESSIONS_CACHE_FILE } = require('./src/config/providers');

const {
    readAuditLog,
    appendAuditLog,
    clearAuditLog
} = require('./src/services/auditLogger');

const { splitTextIntoTtsChunks } = require('./src/services/ttsEngine');

const app = express();

app.use(cors());
app.use(express.json());
app.use(securityHeaders);

app.use('/assets', express.static(path.join(__dirname, '../assets')));
app.use(express.static(path.join(__dirname, '../assets')));
app.use(express.static(path.join(__dirname, '../frontend')));

// API Routes
app.post('/api/chat', sessionValidator, chatRateLimiter, handleChat);
app.get('/api/exchange-rate', getExchangeRateHandler);
app.get('/api/db', getDbHandler);
app.get('/api/transactions', getTransactionsHandler);
app.get('/api/contacts', getContactsHandler);
app.get('/api/bills', getBillsHandler);
app.post('/api/reset', resetHandler);
app.post('/api/feedback', submitFeedbackHandler);
app.get('/api/feedback/likes', getLikesHandler);
app.get('/api/feedback/dislikes', getDislikesHandler);
app.get('/api/audit', getAuditLogsHandler);
app.post('/api/tts', ttsRateLimiter, handleTts);

app.use(errorHandler);

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

    process.on('SIGINT', () => {
        saveSessionsSync();
        closeSqliteDb();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        saveSessionsSync();
        closeSqliteDb();
        process.exit(0);
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
    splitTextIntoTtsChunks,
    EXCHANGE_RATE_CONFIG,
    getExchangeRate,
    chatRateLimiter,
    ttsRateLimiter,
    createTokenBucketRateLimiter,
    TokenBucket,
    loadSessionsFromDisk,
    reloadSessionsFromDisk,
    saveSessionsSync,
    pruneExpiredSessions,
    createInitialSessionState,
    sessions,
    SESSIONS_CACHE_FILE,
    evaluateHybridIntent,
    classifySemanticIntent,
    CONFIDENCE_THRESHOLD,
    getSqliteDb,
    closeSqliteDb,
    resetSqliteDatabase,
    exportSqliteToJson,
    exportAuditSqliteToJson,
    syncSqliteWithJsonObject,
    executeTransferTransaction,
    executeBillPaymentTransaction,
    addContactTransaction,
    SQLITE_DB_PATH
};