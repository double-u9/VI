const { getSession } = require('../services/sessionStore');
const { DEFAULT_SESSION_ID } = require('../config/providers');

/**
 * Session Validation & Resolution Middleware
 * Attaches validated session instance, sessionId, and idempotencyKey to req.
 */
function sessionValidator(req, res, next) {
    const sessionId = req.headers['x-session-id'] || req.body?.sessionId || req.query?.sessionId || DEFAULT_SESSION_ID;
    const idempotencyKey = req.headers['x-idempotency-key'] || req.headers['idempotency-key'] || req.body?.idempotencyKey || req.body?.idempotency_key || null;

    req.sessionId = (typeof sessionId === 'string' && sessionId.trim()) ? sessionId.trim() : DEFAULT_SESSION_ID;
    req.session = getSession(req.sessionId);
    req.idempotencyKey = idempotencyKey;
    next();
}

module.exports = {
    sessionValidator
};
