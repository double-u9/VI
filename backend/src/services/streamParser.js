/**
 * In-Memory Sliding-Window Token Parser for SSE Streaming
 * Buffers partial delimiter candidates to prevent raw technical markup (<<<DB_ACTION>>>, <CONFIRMATION_REQUIRED>)
 * from leaking to client before parsing and emitting them as structured events.
 */

const START_DELIMITERS = [
    { start: '<<<DB_ACTION>>>', end: '<<<END_DB_ACTION>>>', type: 'DB_ACTION' },
    { start: '<CONFIRMATION_REQUIRED>', end: '</CONFIRMATION_REQUIRED>', type: 'CONFIRMATION_REQUIRED' }
];

class SlidingWindowTokenParser {
    constructor({ onToken, onAction, onDone, onError }) {
        this.onToken = onToken || (() => {});
        this.onAction = onAction || (() => {});
        this.onDone = onDone || (() => {});
        this.onError = onError || (() => {});

        this.state = 'TEXT'; // 'TEXT' or 'INSIDE_DELIMITER'
        this.pendingBuffer = '';
        this.delimiterBuffer = '';
        this.activeDelimiter = null;
        this.accumulatedText = '';
        this.accumulatedRaw = '';
    }

    feed(token) {
        if (!token) return;
        this.accumulatedRaw += token;

        if (this.state === 'INSIDE_DELIMITER') {
            this.delimiterBuffer += token;
            const endTag = this.activeDelimiter.end;
            const endIdx = this.delimiterBuffer.indexOf(endTag);
            if (endIdx !== -1) {
                const payload = this.delimiterBuffer.slice(0, endIdx).trim();
                const remainder = this.delimiterBuffer.slice(endIdx + endTag.length);

                try {
                    this.onAction({
                        type: this.activeDelimiter.type,
                        startTag: this.activeDelimiter.start,
                        endTag: this.activeDelimiter.end,
                        rawPayload: payload
                    });
                } catch (err) {
                    this.onError(err);
                }

                this.state = 'TEXT';
                this.activeDelimiter = null;
                this.delimiterBuffer = '';

                if (remainder) {
                    this.feed(remainder);
                }
            }
            return;
        }

        this.pendingBuffer += token;

        while (this.pendingBuffer.length > 0) {
            const ltIdx = this.pendingBuffer.indexOf('<');

            if (ltIdx === -1) {
                this.emitText(this.pendingBuffer);
                this.pendingBuffer = '';
                break;
            }

            if (ltIdx > 0) {
                this.emitText(this.pendingBuffer.slice(0, ltIdx));
                this.pendingBuffer = this.pendingBuffer.slice(ltIdx);
            }

            let isExactMatch = false;
            let isPrefixMatch = false;
            let matchedDelim = null;

            for (const d of START_DELIMITERS) {
                if (this.pendingBuffer === d.start) {
                    isExactMatch = true;
                    matchedDelim = d;
                    break;
                } else if (d.start.startsWith(this.pendingBuffer)) {
                    isPrefixMatch = true;
                    matchedDelim = d;
                } else if (this.pendingBuffer.startsWith(d.start)) {
                    isExactMatch = true;
                    matchedDelim = d;
                    break;
                }
            }

            if (isExactMatch && matchedDelim) {
                this.state = 'INSIDE_DELIMITER';
                this.activeDelimiter = matchedDelim;
                const remainder = this.pendingBuffer.slice(matchedDelim.start.length);
                this.pendingBuffer = '';
                this.delimiterBuffer = remainder;

                const endTag = this.activeDelimiter.end;
                const endIdx = this.delimiterBuffer.indexOf(endTag);
                if (endIdx !== -1) {
                    const payload = this.delimiterBuffer.slice(0, endIdx).trim();
                    const afterClose = this.delimiterBuffer.slice(endIdx + endTag.length);
                    try {
                        this.onAction({
                            type: this.activeDelimiter.type,
                            startTag: this.activeDelimiter.start,
                            endTag: this.activeDelimiter.end,
                            rawPayload: payload
                        });
                    } catch (err) {
                        this.onError(err);
                    }
                    this.state = 'TEXT';
                    this.activeDelimiter = null;
                    this.delimiterBuffer = '';
                    if (afterClose) {
                        this.feed(afterClose);
                    }
                }
                break;
            } else if (isPrefixMatch) {
                // Potential delimiter prefix - keep buffered until disambiguated
                break;
            } else {
                // Not a delimiter prefix - emit single character and advance
                this.emitText(this.pendingBuffer[0]);
                this.pendingBuffer = this.pendingBuffer.slice(1);
            }
        }
    }

    emitText(text) {
        if (!text) return;
        this.accumulatedText += text;
        this.onToken(text);
    }

    end() {
        if (this.state === 'TEXT') {
            if (this.pendingBuffer.length > 0) {
                this.emitText(this.pendingBuffer);
                this.pendingBuffer = '';
            }
        } else if (this.state === 'INSIDE_DELIMITER') {
            if (this.delimiterBuffer.length > 0 && this.activeDelimiter) {
                try {
                    this.onAction({
                        type: this.activeDelimiter.type,
                        startTag: this.activeDelimiter.start,
                        endTag: this.activeDelimiter.end,
                        rawPayload: this.delimiterBuffer.trim()
                    });
                } catch (e) {
                    this.onError(e);
                }
            }
        }

        this.onDone({
            fullResponse: this.accumulatedText.trim(),
            rawResponse: this.accumulatedRaw
        });
    }
}

function initSseStream(res) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }
}

function writeSseEvent(res, eventName, data) {
    if (res.writableEnded || res.destroyed) return;
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    res.write(`event: ${eventName}\ndata: ${payload}\n\n`);
    if (typeof res.flush === 'function') {
        res.flush();
    }
}

module.exports = {
    SlidingWindowTokenParser,
    initSseStream,
    writeSseEvent
};
