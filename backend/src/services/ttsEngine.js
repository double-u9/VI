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

function cleanTtsText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/<<<DB_ACTION>>>[\s\S]*?<<<END_DB_ACTION>>>/g, '')
        .replace(/[*#_~`]/g, '')
        .replace(/\bIQD\b/gi, 'دينار عراقي')
        .replace(/د\.ع/g, 'دينار عراقي')
        .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
        .trim();
}

async function synthesizeSpeech(text) {
    const cleanText = cleanTtsText(text);
    if (!cleanText) {
        throw new Error('Clean text is empty');
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;

    // 1. ElevenLabs custom / cloned voice
    if (apiKey) {
        try {
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
                return {
                    buffer: Buffer.from(audioBuffer),
                    engine: 'elevenlabs',
                    contentType: 'audio/mpeg'
                };
            } else {
                const errText = await elevenRes.text();
                console.warn(`[ElevenLabs TTS Error]: HTTP ${elevenRes.status}: ${errText}`);
            }
        } catch (elevenErr) {
            console.warn('[ElevenLabs TTS Exception]:', elevenErr.message);
        }
    }

    // 2. High-Fidelity Free Google Arabic Neural Voice
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
            return {
                buffer: Buffer.concat(audioBuffers),
                engine: 'google-arabic-cloud',
                contentType: 'audio/mpeg'
            };
        }
    } catch (cloudErr) {
        console.warn('[Google Arabic TTS Error]:', cloudErr.message);
    }

    // Fallback required
    const fallbackErr = new Error('TTS cloud providers unavailable');
    fallbackErr.status = 501;
    fallbackErr.fallback = 'browser';
    throw fallbackErr;
}

module.exports = {
    splitTextIntoTtsChunks,
    cleanTtsText,
    synthesizeSpeech
};
