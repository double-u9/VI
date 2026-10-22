const { readDatabase, resetDatabase } = require('../services/walletService');
const { resetSession } = require('../services/sessionStore');
const { getExchangeRate } = require('../config/exchangeRate');
const { DEFAULT_SESSION_ID } = require('../config/providers');

function getExchangeRateHandler(req, res) {
    try {
        res.json(getExchangeRate());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

function getDbHandler(req, res) {
    try {
        const db = readDatabase();
        res.json({
            ...db,
            exchange_rate: getExchangeRate()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

function getTransactionsHandler(req, res) {
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
            count: trxs.length,
            exchange_rate: getExchangeRate()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

function resetHandler(req, res) {
    try {
        const sessionId = req.headers['x-session-id'] || req.body?.sessionId || DEFAULT_SESSION_ID;
        resetSession(sessionId);
        resetDatabase();
        console.log(`🔄 [Session "${sessionId}" history, pending state, and wallet database reset to defaults]`);
        res.json({ status: 'Conversation history and database reset successful', sessionId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    getExchangeRateHandler,
    getDbHandler,
    getTransactionsHandler,
    resetHandler
};
