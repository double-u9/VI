const { readDatabase } = require('../services/walletService');

function getBillsHandler(req, res) {
    try {
        const db = readDatabase();
        res.json({
            bills: db.bills || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    getBillsHandler
};
