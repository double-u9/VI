const { readAuditLog } = require('../services/auditLogger');

function getAuditLogsHandler(req, res) {
    try {
        const logs = readAuditLog();
        res.json({ total: logs.length, logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    getAuditLogsHandler
};
