const { readDatabase } = require('../services/walletService');

function getContactsHandler(req, res) {
    try {
        const db = readDatabase();
        res.json({
            contacts: db.contacts || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    getContactsHandler
};
