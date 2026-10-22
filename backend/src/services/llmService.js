const { OpenAI } = require('openai');
const { PROVIDERS, FAILOVER_CHAIN } = require('../config/providers');

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
        max_tokens: options.max_tokens !== undefined ? options.max_tokens : 500,
        stream: options.stream || false
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

            // Skip cleanly if secondary provider key is missing
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

module.exports = {
    sleep,
    isRetryableError,
    executeSingleCompletion,
    callProviderWithBackoff,
    callUnifiedChatCompletion
};
