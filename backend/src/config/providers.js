const path = require('path');

// Ensure environment variables are loaded
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

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

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1/chat/completions';
const BACKEND_ROOT = path.resolve(__dirname, '../../');

const DB_FILE_PATH = path.join(BACKEND_ROOT, 'mock_wallet_db.json');
const DB_TMP_FILE_PATH = path.join(BACKEND_ROOT, 'mock_wallet_db.json.tmp');
const AUDIT_LOG_PATH = path.join(BACKEND_ROOT, 'audit_trail.json');
const AUDIT_TMP_LOG_PATH = path.join(BACKEND_ROOT, 'audit_trail.json.tmp');
const FEEDBACK_LIKES_PATH = path.join(BACKEND_ROOT, 'feedback_likes.json');
const FEEDBACK_DISLIKES_PATH = path.join(BACKEND_ROOT, 'feedback_dislikes.json');
const SESSIONS_CACHE_FILE = path.join(BACKEND_ROOT, '.session_cache.json');
const SESSIONS_CACHE_TMP_FILE = path.join(BACKEND_ROOT, '.session_cache.json.tmp');

const DEFAULT_SESSION_ID = 'default_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 Hours
const MAX_CONVERSATION_HISTORY = 12;

module.exports = {
    PROVIDERS,
    FAILOVER_CHAIN,
    LM_STUDIO_URL,
    BACKEND_ROOT,
    DB_FILE_PATH,
    DB_TMP_FILE_PATH,
    AUDIT_LOG_PATH,
    AUDIT_TMP_LOG_PATH,
    FEEDBACK_LIKES_PATH,
    FEEDBACK_DISLIKES_PATH,
    SESSIONS_CACHE_FILE,
    SESSIONS_CACHE_TMP_FILE,
    DEFAULT_SESSION_ID,
    SESSION_TTL_MS,
    MAX_CONVERSATION_HISTORY,
    SQLITE_DB_PATH: path.join(BACKEND_ROOT, 'wallet.db')
};
