const fs = require('fs');
const { FEEDBACK_LIKES_PATH, FEEDBACK_DISLIKES_PATH } = require('../config/providers');

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

function submitFeedbackHandler(req, res) {
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
            likes.unshift(record);
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
            dislikes.unshift(record);
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
}

function getLikesHandler(req, res) {
    try {
        const likes = readFeedbackFile(FEEDBACK_LIKES_PATH);
        res.json({ total: likes.length, items: likes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

function getDislikesHandler(req, res) {
    try {
        const dislikes = readFeedbackFile(FEEDBACK_DISLIKES_PATH);
        res.json({ total: dislikes.length, items: dislikes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    readFeedbackFile,
    saveFeedbackFile,
    submitFeedbackHandler,
    getLikesHandler,
    getDislikesHandler
};
