const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'mock_wallet_db.json');

const INITIAL_DB = {
  "user": {
    "id": "usr_1001",
    "name": "محمد",
    "phone": "+9647801234567",
    "balance": 2200000,
    "currency": "IQD",
    "wallet_provider": "VI"
  },
  "contacts": [
    {
      "id": "cnt_2001",
      "name": "أحمد",
      "alias": "أحمد كمال (صديق الجامعة)",
      "phone": "+9647801122334",
      "wallet_provider": "VI"
    },
    {
      "id": "cnt_2002",
      "name": "أحمد",
      "alias": "أحمد جاسم (الفيترجي / المصلح)",
      "phone": "+9647802233445",
      "wallet_provider": "VI"
    },
    {
      "id": "cnt_2003",
      "name": "أم مصطفى",
      "alias": "الوالدة",
      "phone": "+9647803344556",
      "wallet_provider": "VI"
    },
    {
      "id": "cnt_2004",
      "name": "سيف",
      "alias": "سيف الدين",
      "phone": "+9647804455667",
      "wallet_provider": "VI"
    },
    {
      "id": "cnt_2005",
      "name": "حسين",
      "alias": "حسين",
      "phone": "+9647807778899",
      "wallet_provider": "VI"
    },
    {
      "id": "cnt_2006",
      "name": "علاوي",
      "alias": "علاوي",
      "phone": "+9647709998877",
      "wallet_provider": "VI"
    },
    {
      "id": "cnt_2007",
      "name": "مرتضى",
      "alias": "مرتضى",
      "phone": "+9647819919952",
      "wallet_provider": "VI"
    }
  ],
  "bills": [
    {
      "id": "bill_phone_01",
      "biller": "فاتورة خط الهاتف المحمول",
      "account_number": "07801234567",
      "amount": 25000,
      "status": "unpaid"
    },
    {
      "id": "bill_net_01",
      "biller": "فاتورة شبكة الإنترنت المنزلي (Fiber/4G)",
      "account_number": "NET-884920",
      "amount": 40000,
      "status": "unpaid"
    },
    {
      "id": "bill_elec_01",
      "biller": "كهرباء الكرخ",
      "account_number": "9812450012",
      "amount": 50000,
      "status": "unpaid"
    },
    {
      "id": "bill_water_01",
      "biller": "مياه البصرة",
      "account_number": "1234567899",
      "amount": 35000,
      "status": "unpaid"
    }
  ],
  "recent_transactions": [
    {
      "id": "trx_319298",
      "type": "TRANSFER",
      "recipient": "كرار حيدر",
      "phone": "+9647845645621",
      "amount": 700000,
      "currency": "IQD",
      "status": "SUCCESS",
      "date": "2026-10-05"
    },
    {
      "id": "trx_027987",
      "type": "TRANSFER",
      "recipient": "الوالدة",
      "phone": "+9647803344556",
      "amount": 100000,
      "currency": "IQD",
      "status": "SUCCESS",
      "date": "2026-10-05"
    }
  ]
};

function resetDatabase() {
    fs.writeFileSync(DB_PATH, JSON.stringify(INITIAL_DB, null, 2), 'utf8');
    return INITIAL_DB;
}

if (require.main === module) {
    resetDatabase();
    console.log('✅ [Database Reset]: mock_wallet_db.json successfully reset to initial default values (Balance: 2,200,000 IQD).');
}

module.exports = { resetDatabase, INITIAL_DB };
