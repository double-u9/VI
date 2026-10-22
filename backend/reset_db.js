const fs = require('fs');
const path = require('path');
const { INITIAL_DB } = require('./src/config/initialDb');

const DB_PATH = path.join(__dirname, 'mock_wallet_db.json');

function resetDatabase() {
    fs.writeFileSync(DB_PATH, JSON.stringify(INITIAL_DB, null, 2), 'utf8');
    try {
        const { resetSqliteDatabase } = require('./src/services/sqliteDb');
        resetSqliteDatabase(INITIAL_DB);
    } catch (_) {}
    return INITIAL_DB;
}

if (require.main === module) {
    resetDatabase();
    console.log('✅ [Database Reset]: mock_wallet_db.json successfully reset to initial default values (Balance: 3,000,000 IQD).');
}

module.exports = { resetDatabase, INITIAL_DB };
