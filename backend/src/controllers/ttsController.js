const { synthesizeSpeech, cleanTtsText } = require('../services/ttsEngine');

async function handleTts(req, res) {
    try {
        const { text } = req.body || {};
        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: 'Text is required' });
        }

        const cleanText = cleanTtsText(text);
        if (!cleanText) {
            return res.status(400).json({ error: 'Clean text is empty' });
        }

        try {
            const speechResult = await synthesizeSpeech(text);
            res.set({
                'Content-Type': speechResult.contentType || 'audio/mpeg',
                'Cache-Control': 'no-cache',
                'X-TTS-Engine': speechResult.engine
            });
            return res.send(speechResult.buffer);
        } catch (synthErr) {
            if (synthErr.fallback === 'browser') {
                return res.status(501).json({ error: 'TTS cloud providers unavailable', fallback: 'browser' });
            }
            throw synthErr;
        }
    } catch (err) {
        console.error('[TTS API Error]:', err.message);
        return res.status(500).json({ error: err.message, fallback: 'browser' });
    }
}

module.exports = {
    handleTts
};
