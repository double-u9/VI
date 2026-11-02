const { readDatabase, addContactMutation } = require('../services/walletService');

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

function addContactHandler(req, res) {
    try {
        const { name, phone, alias, wallet_provider } = req.body || {};
        if (!name || !phone) {
            return res.status(400).json({ error: 'Name and phone are required.' });
        }
        const result = addContactMutation({
            name,
            phone,
            alias: alias || name,
            wallet_provider: wallet_provider || 'VI'
        });
        res.status(201).json({
            success: true,
            contact: result.contact
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    getContactsHandler,
    addContactHandler
};
