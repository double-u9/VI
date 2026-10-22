const fs = require('fs');
const path = require('path');
const {
    SESSIONS_CACHE_FILE,
    SESSIONS_CACHE_TMP_FILE = path.join(path.dirname(SESSIONS_CACHE_FILE), '.session_cache.json.tmp'),
    DEFAULT_SESSION_ID,
    SESSION_TTL_MS,
    MAX_CONVERSATION_HISTORY
} = require('../config/providers');

/**
 * In-memory hydrated session registry backed by durable file persistence.
 */
const sessions = new Map();

/**
 * Factory for a pristine session state containing all workflow and pending confirmation slots.
 */
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

/**
 * Atomic synchronous flush of sessions to disk with Windows transient-lock resilience
 */
function saveSessionsSync() {
    try {
        const now = Date.now();
        const serialized = {};
        for (const [id, session] of sessions.entries()) {
            if (!session || typeof session !== 'object') continue;
            const lastActive = typeof session.lastActive === 'number' ? session.lastActive : now;

            // Enforce 24-hour TTL expiration: skip non-default expired sessions
            if (id === DEFAULT_SESSION_ID || (now - lastActive <= SESSION_TTL_MS)) {
                serialized[id] = {
                    conversationHistory: Array.isArray(session.conversationHistory) ? session.conversationHistory : [],
                    pendingTransfer: session.pendingTransfer || null,
                    pendingDisambiguation: session.pendingDisambiguation || null,
                    pendingBillPayment: session.pendingBillPayment || null,
                    pendingTransferRecipient: session.pendingTransferRecipient || null,
                    lastUserPhoneCandidate: session.lastUserPhoneCandidate || null,
                    recentUserPhoneCandidates: Array.isArray(session.recentUserPhoneCandidates) ? session.recentUserPhoneCandidates : [],
                    pendingContactCreation: session.pendingContactCreation || null,
                    lastActive: lastActive
                };
            }
        }

        const jsonString = JSON.stringify(serialized, null, 2);
        fs.writeFileSync(SESSIONS_CACHE_TMP_FILE, jsonString, 'utf8');

        try {
            fs.renameSync(SESSIONS_CACHE_TMP_FILE, SESSIONS_CACHE_FILE);
        } catch (renameErr) {
            if (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') {
                // Windows-safe fallback for transient file lock by indexers/antivirus
                fs.copyFileSync(SESSIONS_CACHE_TMP_FILE, SESSIONS_CACHE_FILE);
                try { fs.unlinkSync(SESSIONS_CACHE_TMP_FILE); } catch (_) {}
            } else {
                throw renameErr;
            }
        }
        return true;
    } catch (err) {
        console.error('[SessionStore Error] Failed to persist sessions atomically:', err.message);
        if (fs.existsSync(SESSIONS_CACHE_TMP_FILE)) {
            try { fs.unlinkSync(SESSIONS_CACHE_TMP_FILE); } catch (_) {}
        }
        return false;
    }
}

let saveSessionTimeout = null;

/**
 * Debounced background session persistence with optional immediate flush
 */
function persistSessionsToDisk(immediate = false) {
    if (saveSessionTimeout) {
        clearTimeout(saveSessionTimeout);
        saveSessionTimeout = null;
    }

    if (immediate) {
        return saveSessionsSync();
    }

    saveSessionTimeout = setTimeout(() => {
        saveSessionTimeout = null;
        saveSessionsSync();
    }, 50);
}

/**
 * Gracefully rehydrates sessions from disk, restoring financial workflows and pruning expired sessions
 */
function loadSessionsFromDisk() {
    try {
        if (!fs.existsSync(SESSIONS_CACHE_FILE)) {
            return false;
        }

        const raw = fs.readFileSync(SESSIONS_CACHE_FILE, 'utf8').trim();
        if (!raw) return false;

        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
            const now = Date.now();
            let loadedCount = 0;

            for (const [id, s] of Object.entries(data)) {
                if (!s || typeof s !== 'object') continue;
                const lastActive = typeof s.lastActive === 'number' ? s.lastActive : now;

                // Enforce 24-hour TTL expiration upon hydration
                if (id !== DEFAULT_SESSION_ID && (now - lastActive > SESSION_TTL_MS)) {
                    continue; // Skip expired session
                }

                // Graceful state recovery: ensure all financial workflow and confirmation keys exist
                sessions.set(id, {
                    conversationHistory: Array.isArray(s.conversationHistory) ? s.conversationHistory : [],
                    pendingTransfer: s.pendingTransfer || null,
                    pendingDisambiguation: s.pendingDisambiguation || null,
                    pendingBillPayment: s.pendingBillPayment || null,
                    pendingTransferRecipient: s.pendingTransferRecipient || null,
                    lastUserPhoneCandidate: s.lastUserPhoneCandidate || null,
                    recentUserPhoneCandidates: Array.isArray(s.recentUserPhoneCandidates) ? s.recentUserPhoneCandidates : [],
                    pendingContactCreation: s.pendingContactCreation || null,
                    lastActive: lastActive
                });
                loadedCount++;
            }
            return true;
        }
    } catch (err) {
        console.error('[SessionStore Error] Failed to hydrate sessions from disk:', err.message);
    }
    return false;
}

/**
 * Prunes sessions inactive for longer than 24 hours (SESSION_TTL_MS)
 */
function pruneExpiredSessions(now = Date.now()) {
    let pruned = 0;
    for (const [id, session] of sessions.entries()) {
        if (id !== DEFAULT_SESSION_ID && (now - (session.lastActive || 0) > SESSION_TTL_MS)) {
            sessions.delete(id);
            pruned++;
        }
    }
    if (pruned > 0) {
        saveSessionsSync();
    }
    return pruned;
}

/**
 * Reloads all sessions from disk by wiping memory state first (simulates service restart)
 */
function reloadSessionsFromDisk() {
    sessions.clear();
    return loadSessionsFromDisk();
}

// Initial hydration on startup
loadSessionsFromDisk();

// Process exit hook to flush pending session updates before shutdown
if (typeof process !== 'undefined' && process.on) {
    process.once('beforeExit', () => {
        saveSessionsSync();
    });
}

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
    persistSessionsToDisk();
}

function recordSessionTurn(session, userMessage, assistantReply) {
    if (!session) return;
    if (userMessage) {
        appendToConversationHistory(session, 'user', userMessage);
    }
    if (assistantReply) {
        appendToConversationHistory(session, 'assistant', assistantReply);
    }
    persistSessionsToDisk();
}

function getSession(sessionId) {
    const validId = (typeof sessionId === 'string' && sessionId.trim()) ? sessionId.trim() : DEFAULT_SESSION_ID;
    if (!sessions.has(validId)) {
        sessions.set(validId, createInitialSessionState());
        persistSessionsToDisk();
    }
    const session = sessions.get(validId);
    session.lastActive = Date.now();
    return session;
}

function resetSession(sessionId) {
    const validId = (typeof sessionId === 'string' && sessionId.trim()) ? sessionId.trim() : DEFAULT_SESSION_ID;
    sessions.set(validId, createInitialSessionState());
    saveSessionsSync();
}

// Periodic cleanup interval to prune inactive sessions older than 24 hours
const pruneInterval = setInterval(() => {
    pruneExpiredSessions();
}, 30 * 60 * 1000).unref();

module.exports = {
    sessions,
    createInitialSessionState,
    loadSessionsFromDisk,
    reloadSessionsFromDisk,
    persistSessionsToDisk,
    saveSessionsSync,
    pruneExpiredSessions,
    MAX_CONVERSATION_HISTORY,
    trimConversationHistory,
    appendToConversationHistory,
    recordSessionTurn,
    getSession,
    resetSession,
    DEFAULT_SESSION_ID,
    SESSION_TTL_MS,
    pruneInterval
};
