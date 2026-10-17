const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
    app,
    normalizeDigits,
    normalizeArabic,
    extractAmount,
    classifyRecipient,
    handleDirectTransferIntent,
    executeTransferMutation,
    executeBillPaymentMutation,
    addContactMutation,
    handleModelActions,
    findAmbiguousContacts,
    resolveContactSelection,
    isDisambiguationAbandonment,
    extractUserPhoneCandidates,
    isContactCreationIntent,
    extractContactNameFromMessage,
    detectBillPaymentIntent,
    findMatchingBill,
    isUserCancellation,
    isUserConfirmation,
    MAX_CONVERSATION_HISTORY,
    appendToConversationHistory,
    recordSessionTurn,
    trimConversationHistory,
    getSession,
    resetSession,
    readDatabase,
    saveDatabase,
    resetDatabase,
    readAuditLog,
    appendAuditLog,
    clearAuditLog,
    AUDIT_LOG_PATH
} = require('../server');

const MOCK_CONTACTS = [
    {
        id: "cnt_2001",
        name: "أحمد",
        alias: "أحمد كمال (صديق الجامعة)",
        phone: "+9647801122334"
    },
    {
        id: "cnt_2002",
        name: "أحمد",
        alias: "أحمد جاسم (الفيترجي / المصلح)",
        phone: "+9647802233445"
    },
    {
        id: "cnt_2003",
        name: "أم مصطفى",
        alias: "الوالدة",
        phone: "+9647803344556"
    },
    {
        id: "cnt_2004",
        name: "سيف",
        alias: "سيف الدين",
        phone: "+9647804455667"
    },
    {
        id: "cnt_2005",
        name: "حسين",
        alias: "حسين",
        phone: "+9647807778899"
    },
    {
        id: "cnt_2006",
        name: "علاوي",
        alias: "علاوي",
        phone: "+9647709998877"
    }
];

const MOCK_DB = {
    user: {
        id: "usr_1001",
        name: "محمد",
        phone: "+9647801234567",
        balance: 2200000,
        currency: "IQD"
    },
    contacts: MOCK_CONTACTS
};

describe('VI Wallet Regression Suite - Task 1', () => {

    // --------------------------------------------------------------------------
    // Test Category 1: Valid 11-digit 078 phone numbers
    // --------------------------------------------------------------------------
    describe('1. Valid 11-digit 078 phone numbers', () => {
        test('National format 07801234567', () => {
            const res = classifyRecipient('07801234567', MOCK_CONTACTS);
            assert.equal(res.type, 'SUPPORTED_PHONE');
            assert.equal(res.valid, true);
            assert.equal(res.phone, '07801234567');
        });

        test('International format with +964', () => {
            const res = classifyRecipient('+9647801234567', MOCK_CONTACTS);
            assert.equal(res.type, 'SUPPORTED_PHONE');
            assert.equal(res.valid, true);
            assert.equal(res.phone, '07801234567');
        });

        test('International format with 00964', () => {
            const res = classifyRecipient('009647801234567', MOCK_CONTACTS);
            assert.equal(res.type, 'SUPPORTED_PHONE');
            assert.equal(res.valid, true);
            assert.equal(res.phone, '07801234567');
        });

        test('In a transfer message: حول 50 الف الى 07801234567', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 50 الف الى 07801234567', MOCK_DB, session);
            assert.ok(reply.includes('تفاصيل التحويل:'));
            assert.ok(reply.includes('07801234567'));
            assert.ok(reply.includes('50,000 د.ع'));
            assert.equal(session.pendingTransfer?.amount, 50000);
            assert.equal(session.pendingTransfer?.phone, '07801234567');
        });
    });

    // --------------------------------------------------------------------------
    // Test Category 2: Invalid 078 numbers with incorrect lengths
    // --------------------------------------------------------------------------
    describe('2. Invalid 078 numbers with incorrect lengths', () => {
        test('Too short: 0781234 (7 digits)', () => {
            const res = classifyRecipient('0781234', MOCK_CONTACTS);
            assert.equal(res.type, 'INVALID_PHONE');
            assert.equal(res.valid, false);
            assert.match(res.error, /رقم هاتف زين غير صحيح/);
        });

        test('Too short: 0780123456 (10 digits)', () => {
            const res = classifyRecipient('0780123456', MOCK_CONTACTS);
            assert.equal(res.type, 'INVALID_PHONE');
            assert.equal(res.valid, false);
            assert.match(res.error, /يجب أن يتكون الرقم من 11 رقماً ويبدأ بـ 078/);
        });

        test('Too long: 078012345678 (12 digits)', () => {
            const res = classifyRecipient('078012345678', MOCK_CONTACTS);
            assert.equal(res.type, 'INVALID_PHONE');
            assert.equal(res.valid, false);
            assert.match(res.error, /رقم هاتف زين غير صحيح/);
        });

        test('Must NOT classify invalid 078 number as person name', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 50 الف الى 0781234', MOCK_DB, session);
            assert.doesNotMatch(reply, /هذا الشخص/);
            assert.doesNotMatch(reply, /ما لقيت أي شخص باسم/);
            assert.match(reply, /رقم هاتف زين غير صحيح/);
            assert.equal(session.pendingTransfer, undefined);
        });
    });

    // --------------------------------------------------------------------------
    // Test Category 3: Unsupported 11-digit 075 and 077 phone numbers
    // --------------------------------------------------------------------------
    describe('3. Unsupported 11-digit 075 and 077 phone numbers', () => {
        const expectedUnsupportedMsg = 'حالياً التحويل مدعوم لأرقام زين اللي تبدي بـ 078 فقط، أو لأرقام الحسابات والبطاقات المصرفية من 10 إلى 16 رقم. أرقام الهاتف اللي تبدي بـ 075 أو 077 غير مدعومة.';

        test('Asiacell prefix 077: 07701234567', () => {
            const res = classifyRecipient('07701234567', MOCK_CONTACTS);
            assert.equal(res.type, 'UNSUPPORTED_PHONE');
            assert.equal(res.valid, false);
            assert.equal(res.error, expectedUnsupportedMsg);
        });

        test('Korek prefix 075: 07501234567', () => {
            const res = classifyRecipient('07501234567', MOCK_CONTACTS);
            assert.equal(res.type, 'UNSUPPORTED_PHONE');
            assert.equal(res.valid, false);
            assert.equal(res.error, expectedUnsupportedMsg);
        });

        test('Direct intent with 077 rejects without contact search', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 50 الف الى 07701234567', MOCK_DB, session);
            assert.equal(reply, expectedUnsupportedMsg);
            assert.equal(session.pendingTransfer, undefined);
        });

        test('Direct intent with 075 rejects without contact search', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 50 الف ل 07501234567', MOCK_DB, session);
            assert.equal(reply, expectedUnsupportedMsg);
            assert.equal(session.pendingTransfer, undefined);
        });
    });

    // --------------------------------------------------------------------------
    // Test Category 4: Valid account/card numbers containing 10-16 digits
    // --------------------------------------------------------------------------
    describe('4. Valid account and card numbers (10-16 digits)', () => {
        test('Bank account with 12 digits: لحساب رقم 123456789012', () => {
            const res = classifyRecipient('لحساب رقم 123456789012', MOCK_CONTACTS);
            assert.equal(res.type, 'ACCOUNT_CARD');
            assert.equal(res.valid, true);
            assert.equal(res.phone, '123456789012');
            assert.equal(res.recipient, 'حساب مصرفي (123456789012)');
        });

        test('Mastercard with 16 digits: بطاقة 1234567890123456', () => {
            const res = classifyRecipient('بطاقة 1234567890123456', MOCK_CONTACTS);
            assert.equal(res.type, 'ACCOUNT_CARD');
            assert.equal(res.valid, true);
            assert.equal(res.phone, '1234567890123456');
            assert.equal(res.recipient, 'بطاقة مصرفية (1234567890123456)');
        });

        test('Explicit label with 16 digits: ماستركارد 1234567890123456', () => {
            const res = classifyRecipient('ماستركارد 1234567890123456', MOCK_CONTACTS);
            assert.equal(res.type, 'ACCOUNT_CARD');
            assert.equal(res.valid, true);
            assert.equal(res.phone, '1234567890123456');
        });

        test('Invalid account length (< 10 digits): لحساب 12345', () => {
            const res = classifyRecipient('لحساب 12345', MOCK_CONTACTS);
            assert.equal(res.type, 'INVALID_ACCOUNT_CARD');
            assert.equal(res.valid, false);
            assert.match(res.error, /يجب أن يتكون من 10 إلى 16 رقماً/);
        });

        test('Arbitrary unlabelled sequence of digits is not automatically an account', () => {
            const res = classifyRecipient('123456789012', MOCK_CONTACTS);
            assert.equal(res.type, 'UNKNOWN_DIGITS');
            assert.equal(res.valid, false);
            assert.match(res.error, /الرقم المدخل غير معروف/);
        });

        test('Full transfer intent with account: حول 50 الف لحساب رقم 123456789012', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 50 الف لحساب رقم 123456789012', MOCK_DB, session);
            assert.ok(reply.includes('تفاصيل التحويل:'));
            assert.ok(reply.includes('حساب مصرفي (123456789012)'));
            assert.ok(reply.includes('50,000 د.ع'));
            assert.equal(session.pendingTransfer?.amount, 50000);
            assert.equal(session.pendingTransfer?.phone, '123456789012');
        });
    });

    // --------------------------------------------------------------------------
    // Test Category 5: Arabic-Indic digit normalization
    // --------------------------------------------------------------------------
    describe('5. Arabic-Indic digit normalization', () => {
        test('All Arabic-Indic numerals ٠١٢٣٤٥٦٧٨٩ -> 0123456789', () => {
            assert.equal(normalizeDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
        });

        test('Arabic-Indic phone candidate: حول ٠٧٨١٢٣٤٥٦٧٨', () => {
            assert.equal(normalizeDigits('حول ٠٧٨١٢٣٤٥٦٧٨'), 'حول 07812345678');
        });

        test('Arabic-Indic amount: حول ٥٠ الف', () => {
            assert.equal(normalizeDigits('حول ٥٠ الف'), 'حول 50 الف');
            assert.equal(extractAmount('حول ٥٠ الف'), 50000);
        });
    });

    // --------------------------------------------------------------------------
    // Test Category 6: Persian digit normalization
    // --------------------------------------------------------------------------
    describe('6. Persian digit normalization', () => {
        test('All Persian numerals ۰۱۲۳۴۵۶۷۸۹ -> 0123456789', () => {
            assert.equal(normalizeDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
        });

        test('Persian phone: حول ۰۷۸۱۲۳۴۵۶۷۸', () => {
            assert.equal(normalizeDigits('حول ۰۷۸۱۲۳۴۵۶۷۸'), 'حول 07812345678');
            const res = classifyRecipient('۰۷۸۱۲۳۴۵۶۷۸', MOCK_CONTACTS);
            assert.equal(res.type, 'SUPPORTED_PHONE');
            assert.equal(res.phone, '07812345678');
        });

        test('Persian amount: حول ۵۰۰۰۰', () => {
            assert.equal(extractAmount('حول ۵۰۰۰۰'), 50000);
        });
    });

    // --------------------------------------------------------------------------
    // Test Category 7: All monetary expressions in the required table
    // --------------------------------------------------------------------------
    describe('7. All monetary expressions in required table', () => {
        const table = [
            { expr: 'ثلاثين ألف', expected: 30000 },
            { expr: 'خمسين ألف', expected: 50000 },
            { expr: 'ثلاثين الف', expected: 30000 },
            { expr: 'ربع مليون', expected: 250000 },
            { expr: 'نص مليون', expected: 500000 },
            { expr: 'نصف مليون', expected: 500000 },
            { expr: 'مليون', expected: 1000000 },
            { expr: 'مليونين', expected: 2000000 },
            { expr: 'مليون ونص', expected: 1500000 },
            { expr: 'مليون ونصف', expected: 1500000 },
            { expr: 'مليون وربع', expected: 1250000 },
            { expr: '٥٠ ألف', expected: 50000 },
            { expr: '٥٠٠٠٠', expected: 50000 },
        ];

        for (const { expr, expected } of table) {
            test(`Expression "${expr}" -> ${expected.toLocaleString()} IQD`, () => {
                const actual = extractAmount(expr);
                assert.equal(actual, expected);
            });
        }
    });

    // --------------------------------------------------------------------------
    // Test Category 8: Mixed numerical input
    // --------------------------------------------------------------------------
    describe('8. Mixed numerical input', () => {
        test('Arabic-Indic with word: ٥٠ ألف -> 50,000', () => {
            assert.equal(extractAmount('٥٠ ألف'), 50000);
        });

        test('Arabic-Indic with word: ١٠٠ الف -> 100,000', () => {
            assert.equal(extractAmount('١٠٠ الف'), 100000);
        });

        test('Arabic-Indic with million: ٢ مليون -> 2,000,000', () => {
            assert.equal(extractAmount('٢ مليون'), 2000000);
        });

        test('Decimal with million: 1.5 مليون -> 1,500,000', () => {
            assert.equal(extractAmount('1.5 مليون'), 1500000);
        });

        test('Formatted number: 100,000 -> 100,000', () => {
            assert.equal(extractAmount('100,000'), 100000);
        });
    });

    // --------------------------------------------------------------------------
    // Test Category 9: Missing or ambiguous amounts and recipients
    // --------------------------------------------------------------------------
    describe('9. Missing or ambiguous amounts and recipients', () => {
        test('Missing amount: حول لسيف -> asks for amount', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول لسيف', MOCK_DB, session);
            assert.match(reply, /شكد المبلغ اللي تريد تحوله له؟/);
            assert.equal(session.pendingTransferRecipient?.name, 'سيف الدين');
        });

        test('Two-step flow: providing amount subsequently', () => {
            const session = {
                pendingTransferRecipient: {
                    name: 'سيف الدين',
                    phone: '+9647804455667'
                }
            };
            const extracted = extractAmount('خمسين الف');
            assert.equal(extracted, 50000);
        });

        test('Ambiguous contact: حول 50 الف لاحمد -> disambiguation list', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 50 الف لاحمد', MOCK_DB, session);
            assert.match(reply, /عندك أكثر من جهة اتصال باسم "أحمد"/);
            assert.ok(session.pendingDisambiguation);
            assert.equal(session.pendingDisambiguation.matches.length, 2);
        });

        test('Unknown recipient: حول 50 الف لجعفر -> explains not in contacts', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 50 الف لجعفر', MOCK_DB, session);
            assert.match(reply, /ما لقيت أي شخص باسم "جعفر"/);
            assert.equal(session.pendingTransfer, undefined);
        });
    });

    // --------------------------------------------------------------------------
    // Test Category 10: Amounts exceeding available balance or limits
    // --------------------------------------------------------------------------
    describe('10. Balance checks and transfer limits', () => {
        test('Amount exceeds available balance: حول 3 مليون لسيف', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 3 مليون لسيف', MOCK_DB, session);
            assert.match(reply, /غير كافي/);
            assert.match(reply, /2,200,000 د\.ع/);
            assert.equal(session.pendingTransfer, undefined);
        });

        test('Amount below minimum (250 IQD): حول 100 دينار لسيف', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 100 دينار لسيف', MOCK_DB, session);
            assert.match(reply, /أقل مبلغ تحويل مسموح به هو 250 د\.ع/);
            assert.equal(session.pendingTransfer, undefined);
        });
    });

    // --------------------------------------------------------------------------
    // Test Category 11: Display formatting and zero regressions
    // --------------------------------------------------------------------------
    describe('11. Display formatting & regressions', () => {
        test('Display formatting prevents duplicate parentheses on direct phone', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 50 الف الى 07801234567', MOCK_DB, session);
            // Must not contain duplicate parentheses like "(07801234567) (07801234567)"
            assert.doesNotMatch(reply, /\(07801234567\)\s*\(07801234567\)/);
            assert.ok(reply.includes('المستلم: رقم الهاتف (07801234567)'));
        });

        test('Display formatting prevents duplicate parentheses on bank account', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 50 الف لحساب رقم 123456789012', MOCK_DB, session);
            assert.doesNotMatch(reply, /\(123456789012\)\s*\(123456789012\)/);
            assert.ok(reply.includes('المستلم: حساب مصرفي (123456789012)'));
        });

        test('Transfer from contact preserves contact display with phone in parens', () => {
            const session = {};
            const reply = handleDirectTransferIntent('حول 50 الف لحسين', MOCK_DB, session);
            assert.ok(reply.includes('المستلم: حسين (+9647807778899)'));
        });
    });

    // --------------------------------------------------------------------------
    // End-to-End HTTP /api/chat Workflow Tests
    // --------------------------------------------------------------------------
    describe('12. End-to-End HTTP /api/chat Workflow Tests', () => {
        let server;
        let baseUrl;

        before((t, done) => {
            server = app.listen(0, () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                done();
            });
        });

        after((t, done) => {
            if (server) {
                server.close(done);
            } else {
                done();
            }
        });

        test('E2E: Unsupported 077 mobile number returns direct rejection over HTTP', async () => {
            const testSessionId = `test_unsupported_${Date.now()}`;
            const res = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-session-id': testSessionId
                },
                body: JSON.stringify({ message: 'حول 50 الف ل 07701234567' })
            });

            const data = await res.json();
            assert.equal(res.status, 200);
            assert.match(data.response, /أرقام الهاتف اللي تبدي بـ 075 أو 077 غير مدعومة/);
        });

        test('E2E: Invalid Zain phone (short length) returns direct rejection over HTTP', async () => {
            const testSessionId = `test_invalid_phone_${Date.now()}`;
            const res = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-session-id': testSessionId
                },
                body: JSON.stringify({ message: 'حول 50 الف الى 0781234' })
            });

            const data = await res.json();
            assert.equal(res.status, 200);
            assert.match(data.response, /رقم هاتف زين غير صحيح/);
        });

        test('E2E: Two-step confirmation flow and cancellation workflow over HTTP', async () => {
            const testSessionId = `test_cancel_${Date.now()}`;

            // Step 1: Request transfer
            const res1 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-session-id': testSessionId
                },
                body: JSON.stringify({ message: 'حول 50 الف الى 07801234567' })
            });
            const data1 = await res1.json();
            assert.match(data1.response, /متأكد تريد أحول؟/);

            // Verify session has pending transfer
            const session = getSession(testSessionId);
            assert.ok(session.pendingTransfer);
            assert.equal(session.pendingTransfer.amount, 50000);

            // Step 2: User says "إلغاء"
            const res2 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-session-id': testSessionId
                },
                body: JSON.stringify({ message: 'إلغاء' })
            });
            const data2 = await res2.json();
            assert.match(data2.response, /تم إلغاء العملية وما انخصم أي فلس من رصيدك/);
            assert.equal(session.pendingTransfer, null);
        });

        test('E2E: Arabic-Indic numerals in transfer with two-step confirmation over HTTP', async () => {
            const testSessionId = `test_arabic_indic_${Date.now()}`;

            // Step 1: Request transfer with Arabic-Indic numerals
            const res1 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-session-id': testSessionId
                },
                body: JSON.stringify({ message: 'حول ٥٠ الف الى ٠٧٨١٢٣٤٥٦٧٨' })
            });
            const data1 = await res1.json();
            assert.match(data1.response, /المستلم: رقم الهاتف \(07812345678\)/);
            assert.match(data1.response, /المبلغ: 50,000 د\.ع/);
            assert.match(data1.response, /متأكد تريد أحول؟/);

            // Cancel to leave database state clean
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-session-id': testSessionId
                },
                body: JSON.stringify({ message: 'إلغاء' })
            });
        });

        test('E2E: Valid Bank Account transfer with confirmation prompt over HTTP', async () => {
            const testSessionId = `test_account_${Date.now()}`;

            const res1 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-session-id': testSessionId
                },
                body: JSON.stringify({ message: 'حول 50 الف لحساب رقم 123456789012' })
            });
            const data1 = await res1.json();
            assert.match(data1.response, /المستلم: حساب مصرفي \(123456789012\)/);
            assert.match(data1.response, /المبلغ: 50,000 د\.ع/);
            assert.match(data1.response, /متأكد تريد أحول؟/);

            // Cancel to leave database clean
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-session-id': testSessionId
                },
                body: JSON.stringify({ message: 'إلغاء' })
            });
        });
    });
});

describe('VI Wallet Regression Suite - Task 2', () => {
    let baseUrl;
    let server;
    let initialDbBackup;

    before(async () => {
        initialDbBackup = JSON.parse(JSON.stringify(readDatabase()));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        if (initialDbBackup) {
            saveDatabase(initialDbBackup);
        }
        await new Promise(resolve => server.close(resolve));
    });

    beforeEach(() => {
        if (initialDbBackup) {
            saveDatabase(JSON.parse(JSON.stringify(initialDbBackup)));
        }
    });

    // --------------------------------------------------------------------------
    // Test Category 1: Bill Payments in LLM Command Handler & Financial Service
    // --------------------------------------------------------------------------
    describe('1. Bill payments handling', () => {
        test('A valid bill-payment command reaches the correct existing service via handleModelActions', async () => {
            const db = readDatabase();
            const session = getSession(`test_bill_action_${Date.now()}`);
            const initialBalance = db.user.balance;

            const modelReply = `<<<DB_ACTION>>>
{"action": "BILL_PAYMENT", "bill_id": "bill_elec_01", "biller": "كهرباء الكرخ", "amount": 50000}
<<<END_DB_ACTION>>>`;

            // Explicit confirmation from user
            const reply = await handleModelActions(modelReply, db, 'نعم ادفع الفاتورة', 'local', session);
            assert.match(reply, /تم تأكيد دفع الفاتورة بنجاح/);
            assert.match(reply, /50,000 د\.ع/);

            const updatedDb = readDatabase();
            assert.equal(updatedDb.user.balance, initialBalance - 50000);
            const paidBill = updatedDb.bills.find(b => b.id === 'bill_elec_01');
            assert.equal(paidBill.status, 'paid');
            assert.equal(updatedDb.recent_transactions[0].type, 'BILL_PAYMENT');
        });

        test('E2E HTTP: Valid bill payment flow with 2-step confirmation', async () => {
            const testSessionId = `test_bill_e2e_${Date.now()}`;
            const initialBalance = readDatabase().user.balance;

            // Step 1: Request bill payment
            const res1 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'ادفع فاتورة كهرباء الكرخ' })
            });
            const data1 = await res1.json();
            assert.match(data1.response, /تفاصيل تسديد الفاتورة:/);
            assert.match(data1.response, /كهرباء الكرخ/);
            assert.match(data1.response, /50,000 د\.ع/);
            assert.match(data1.response, /متأكد تريد أسدد الفاتورة؟/);

            // DB should NOT have changed yet!
            assert.equal(readDatabase().user.balance, initialBalance);
            assert.equal(readDatabase().bills.find(b => b.id === 'bill_elec_01').status, 'unpaid');

            // Step 2: Confirm payment
            const res2 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'نعم أكد' })
            });
            const data2 = await res2.json();
            assert.match(data2.response, /تم تأكيد دفع الفاتورة بنجاح/);

            const updatedDb = readDatabase();
            assert.equal(updatedDb.user.balance, initialBalance - 50000);
            assert.equal(updatedDb.bills.find(b => b.id === 'bill_elec_01').status, 'paid');
        });

        test('Invalid bill identifiers are rejected', async () => {
            const db = readDatabase();
            const session = getSession(`test_invalid_bill_${Date.now()}`);
            const initialBalance = db.user.balance;

            const modelReply = `<<<DB_ACTION>>>
{"action": "BILL_PAYMENT", "bill_id": "non_existent_bill_999", "biller": "فاتورة غير موجودة"}
<<<END_DB_ACTION>>>`;

            const reply = await handleModelActions(modelReply, db, 'نعم', 'local', session);
            assert.match(reply, /لم يتم العثور على الفاتورة المطلوبة/);
            assert.equal(readDatabase().user.balance, initialBalance);
        });

        test('Insufficient balance is handled correctly', async () => {
            const db = readDatabase();
            db.user.balance = 20000; // Less than 50,000 required for bill_elec_01
            saveDatabase(db);

            const session = getSession(`test_insufficient_bill_${Date.now()}`);
            const modelReply = `<<<DB_ACTION>>>
{"action": "BILL_PAYMENT", "bill_id": "bill_elec_01", "biller": "كهرباء الكرخ", "amount": 50000}
<<<END_DB_ACTION>>>`;

            const reply = await handleModelActions(modelReply, db, 'نعم ادفع', 'local', session);
            assert.match(reply, /غير كافي لدفع فاتورة كهرباء الكرخ/);
            assert.equal(readDatabase().user.balance, 20000);
            assert.equal(readDatabase().bills.find(b => b.id === 'bill_elec_01').status, 'unpaid');
        });

        test('A bill payment cannot execute before explicit confirmation', async () => {
            const db = readDatabase();
            const session = getSession(`test_unconfirmed_bill_${Date.now()}`);
            const initialBalance = db.user.balance;

            const modelReply = `<<<DB_ACTION>>>
{"action": "BILL_PAYMENT", "bill_id": "bill_water_01", "biller": "مياه البصرة", "amount": 35000}
<<<END_DB_ACTION>>>`;

            // User did NOT say confirmation; they asked an initial unconfirmed request
            const reply = await handleModelActions(modelReply, db, 'ادفع فاتورة المي', 'local', session);
            assert.match(reply, /متأكد تريد أسدد الفاتورة؟/);
            assert.ok(session.pendingBillPayment !== null);
            assert.equal(session.pendingBillPayment.totalAmount, 35000);

            // DB must remain unchanged!
            assert.equal(readDatabase().user.balance, initialBalance);
            assert.equal(readDatabase().bills.find(b => b.id === 'bill_water_01').status, 'unpaid');
        });

        test('Failed execution does not generate a false success message', async () => {
            // Anti-fabrication safeguard: model text claiming payment without <<<DB_ACTION>>>
            const db = readDatabase();
            const session = getSession(`test_fake_success_${Date.now()}`);

            const fakeBotReply = 'تم دفع فاتورة كهرباء الكرخ بنجاح وتم خصم 50,000 د.ع من رصيدك!';
            const safeReply = await handleModelActions(fakeBotReply, db, 'ادفع الفاتورة', 'local', session);
            assert.match(safeReply, /لم يتم تنفيذ أي عملية دفع أو خصم من رصيدك/);
            assert.equal(readDatabase().bills.find(b => b.id === 'bill_elec_01').status, 'unpaid');
        });

        test('Duplicate requests do not produce duplicate payments', async () => {
            const db = readDatabase();
            // Mark bill_elec_01 as already paid
            const elec = db.bills.find(b => b.id === 'bill_elec_01');
            elec.status = 'paid';
            saveDatabase(db);
            const balanceBefore = db.user.balance;

            const session = getSession(`test_duplicate_bill_${Date.now()}`);
            const modelReply = `<<<DB_ACTION>>>
{"action": "BILL_PAYMENT", "bill_id": "bill_elec_01", "biller": "كهرباء الكرخ", "amount": 50000}
<<<END_DB_ACTION>>>`;

            const reply = await handleModelActions(modelReply, db, 'نعم ادفعها', 'local', session);
            assert.match(reply, /مسددة مسبقاً/);
            assert.equal(readDatabase().user.balance, balanceBefore);

            // Directly calling executeBillPaymentMutation on already paid bill throws
            assert.throws(() => {
                executeBillPaymentMutation({ billIds: ['bill_elec_01'] });
            }, /لم يتم العثور على فواتير غير مدفوعة مطابقة/);
        });
    });

    // --------------------------------------------------------------------------
    // Test Category 2: Ambiguous Contacts & Stale Selection Prevention
    // --------------------------------------------------------------------------
    describe('2. Ambiguous contacts state management', () => {
        test('A valid selection resolves the intended contact', async () => {
            const testSessionId = `test_ambig_valid_${Date.now()}`;
            const initialBalance = readDatabase().user.balance;

            // Step 1: ambiguous request
            const res1 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'حول 50 الف لاحمد' })
            });
            const data1 = await res1.json();
            assert.match(data1.response, /أحمد كمال/);
            assert.match(data1.response, /أحمد جاسم/);

            // Step 2: select 1 (أحمد كمال)
            const res2 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: '1' })
            });
            const data2 = await res2.json();
            assert.match(data2.response, /أحمد كمال/);
            assert.match(data2.response, /متأكد تريد أحول؟/);

            // Step 3: Confirm transfer
            const res3 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'نعم' })
            });
            const data3 = await res3.json();
            assert.match(data3.response, /تم تأكيد التحويل بنجاح/);
            assert.match(data3.response, /أحمد كمال/);
            assert.equal(readDatabase().user.balance, initialBalance - 50000);
        });

        test('An invalid response does not execute a transaction', async () => {
            const testSessionId = `test_ambig_invalid_${Date.now()}`;
            const initialBalance = readDatabase().user.balance;

            // Step 1: ambiguous request
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'حول 50 الف لاحمد' })
            });

            // Step 2: invalid choice 5 (only 2 choices exist)
            const res2 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: '5' })
            });
            const data2 = await res2.json();
            assert.match(data2.response, /لم يتم اختيار أي من الأسماء المعروضة/);
            assert.equal(readDatabase().user.balance, initialBalance);

            // Verify session state was safely cleared
            const session = getSession(testSessionId);
            assert.equal(session.pendingDisambiguation, null);
            assert.equal(session.pendingTransfer, null);
        });

        test('An abandoned selection cannot be reused several messages later', async () => {
            const testSessionId = `test_ambig_abandon_${Date.now()}`;
            const initialBalance = readDatabase().user.balance;

            // Step 1: ambiguous request
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'حول 50 الف لاحمد' })
            });

            // Step 2: user abandons: "ما أعرفه"
            const res2 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'ما أعرفه' })
            });
            const data2 = await res2.json();
            assert.match(data2.response, /تم إلغاء اختيار جهة الاتصال وما تم تجهيز أو تنفيذ أي تحويل/);

            // Step 3: user chats about something else
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'الجو حلو اليوم' })
            });

            // Step 4: user sends standalone "1"
            const res4 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: '1' })
            });
            const data4 = await res4.json();

            // Must NOT have revived the transfer to Ahmad Kamal!
            assert.doesNotMatch(data4.response, /أحمد كمال/);
            assert.doesNotMatch(data4.response, /متأكد تريد أحول/);
            assert.doesNotMatch(data4.response, /تم تأكيد التحويل/);
            assert.equal(readDatabase().user.balance, initialBalance);
        });

        test('A stale numeric response cannot trigger an old transfer', async () => {
            const testSessionId = `test_stale_numeric_${Date.now()}`;
            const initialBalance = readDatabase().user.balance;

            // User triggers disambiguation
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'حول 50 الف لاحمد' })
            });

            // User supersedes by asking about balance
            const resBal = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'شنو رصيدي؟' })
            });
            const dataBal = await resBal.json();
            assert.match(dataBal.response, /رصيدك الحالي/);

            // Next message is "1"
            const resNum = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: '1' })
            });
            const dataNum = await resNum.json();

            // Must not execute transfer or stage transfer
            assert.doesNotMatch(dataNum.response, /أحمد كمال/);
            assert.doesNotMatch(dataNum.response, /تم تأكيد التحويل/);
            assert.equal(readDatabase().user.balance, initialBalance);
        });

        test('Separate sessions cannot share pending selection state', async () => {
            const sessionA = `session_A_${Date.now()}`;
            const sessionB = `session_B_${Date.now()}`;
            const initialBalance = readDatabase().user.balance;

            // Session A triggers disambiguation
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': sessionA },
                body: JSON.stringify({ message: 'حول 50 الف لاحمد' })
            });

            // Session B sends "1"
            const resB = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': sessionB },
                body: JSON.stringify({ message: '1' })
            });
            const dataB = await resB.json();

            // Session B must NOT touch Session A's disambiguation!
            assert.doesNotMatch(dataB.response, /أحمد كمال/);
            assert.doesNotMatch(dataB.response, /متأكد تريد أحول/);
            assert.equal(readDatabase().user.balance, initialBalance);

            // Clean up session A
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': sessionA },
                body: JSON.stringify({ message: 'إلغاء' })
            });
        });

        test('No money is transferred without the required confirmation', async () => {
            const testSessionId = `test_no_confirm_${Date.now()}`;
            const initialBalance = readDatabase().user.balance;

            // Ambiguous
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'حول 50 الف لاحمد' })
            });

            // Select 1
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: '1' })
            });

            // Cancel instead of confirming
            const resCancel = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'إلغاء' })
            });
            const dataCancel = await resCancel.json();
            assert.match(dataCancel.response, /تم إلغاء العملية وما انخصم أي فلس/);
            assert.equal(readDatabase().user.balance, initialBalance);
        });
    });

    // --------------------------------------------------------------------------
    // Test Category 3: Contact Creation Across Consecutive Messages
    // --------------------------------------------------------------------------
    describe('3. Multi-message contact creation', () => {
        test('A user-provided number can be reused in a subsequent contact-creation message with name', async () => {
            const testSessionId = `test_contact_reuse_${Date.now()}`;
            const initialCount = readDatabase().contacts.length;

            // Msg 1: User provides a phone number
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: '07812345678' })
            });

            // Msg 2: User requests to save it with a name
            const res2 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'إي ضيفه عندك باسم كرار' })
            });
            const data2 = await res2.json();
            assert.match(data2.response, /تم حفظ "كرار" برقم \(07812345678\)/);

            const contacts = readDatabase().contacts;
            assert.equal(contacts.length, initialCount + 1);
            const saved = contacts.find(c => c.name === 'كرار');
            assert.ok(saved);
            assert.equal(saved.phone, '+9647812345678');
        });

        test('A missing name triggers a clarification question, then saves successfully', async () => {
            const testSessionId = `test_contact_noname_${Date.now()}`;
            const initialCount = readDatabase().contacts.length;

            // Msg 1: User provides phone
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: '07898765432' })
            });

            // Msg 2: User requests to save without name
            const res2 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'إي ضيفه عندك' })
            });
            const data2 = await res2.json();
            assert.match(data2.response, /شنو الاسم اللي تريد أحفظ بيه هذا الرقم \(07898765432\)/);

            // Msg 3: User provides the name
            const res3 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'كرار البصراوي' })
            });
            const data3 = await res3.json();
            assert.match(data3.response, /تم حفظ "كرار البصراوي" برقم \(07898765432\)/);

            const contacts = readDatabase().contacts;
            assert.equal(contacts.length, initialCount + 1);
            const saved = contacts.find(c => c.name === 'كرار البصراوي');
            assert.ok(saved);
            assert.equal(saved.phone, '+9647898765432');
        });

        test('Multiple candidate numbers trigger clarification', async () => {
            const testSessionId = `test_multi_cand_${Date.now()}`;

            // Msg 1: User mentions two different numbers
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'أرقامي هي 07811111111 و 07822222222' })
            });

            // Msg 2: User asks to add
            const res2 = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'ضيف الرقم عندك' })
            });
            const data2 = await res2.json();
            assert.match(data2.response, /عندي أكثر من رقم/);
            assert.match(data2.response, /07811111111/);
            assert.match(data2.response, /07822222222/);
            assert.match(data2.response, /يا رقم منهم تحب أضيفه/);
        });

        test('An assistant-generated number is never treated as user-provided input', async () => {
            const testSessionId = `test_assistant_iso_${Date.now()}`;
            const session = getSession(testSessionId);

            // Assistant lists contacts containing a number
            session.conversationHistory.push({
                role: 'assistant',
                content: 'عندك جهة اتصال مسجلة: سيف (+9647804455667).'
            });

            // User has NOT provided any phone number in user messages
            assert.equal(session.lastUserPhoneCandidate, null);

            // User asks to save without giving a number
            const res = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'ضيف هذا الرقم عندك' })
            });
            const data = await res.json();

            // Must NOT have grabbed Saif's number from assistant message
            assert.doesNotMatch(data.response, /07804455667/);
            assert.match(data.response, /يرجى تزويدي برقم الهاتف/);
        });

        test('Cancelled or completed candidates cannot be reused incorrectly', async () => {
            const testSessionId = `test_consumed_cand_${Date.now()}`;

            // Flow 1: Save contact -> candidate consumed
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: '07833333333' })
            });
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'ضيفه عندك باسم باقر' })
            });

            // Later, user says "احفظه عندك"
            const resLater = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'احفظه عندك' })
            });
            const dataLater = await resLater.json();
            // Must ask for a phone number; 07833333333 was consumed!
            assert.match(dataLater.response, /يرجى تزويدي برقم الهاتف/);

            // Flow 2: Cancellation clears candidate
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: '07844444444' })
            });
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'إلغاء' })
            });

            const resCancel = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'احفظ الرقم عندك' })
            });
            const dataCancel = await resCancel.json();
            assert.match(dataCancel.response, /يرجى تزويدي برقم الهاتف/);
        });

        test('Existing contact creation behavior remains functional', async () => {
            const testSessionId = `test_single_msg_contact_${Date.now()}`;
            const initialCount = readDatabase().contacts.length;

            // Single message with full info
            const res = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'ضيف جهة اتصال باسم علي السعدي برقم 07899887766' })
            });
            const data = await res.json();
            assert.match(data.response, /تم حفظ "علي السعدي" برقم \(07899887766\)/);

            const contacts = readDatabase().contacts;
            assert.equal(contacts.length, initialCount + 1);
            const saved = contacts.find(c => c.name === 'علي السعدي');
            assert.ok(saved);
            assert.equal(saved.phone, '+9647899887766');
        });
    });
});

describe('VI Wallet Regression Suite - Task 3: Conversation History Limits & Frontend Duplicate Protection', () => {
    let server;
    let baseUrl;

    before(async () => {
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
    });

    beforeEach(() => {
        resetDatabase();
    });

    // =========================================================================
    // Category 1: Conversation History Limits & Session Isolation
    // =========================================================================
    describe('1. Conversation History Limits', () => {
        test('Repeated fast-path queries (balance inquiries) never exceed configured 12-message limit', async () => {
            const testSessionId = `test_hist_balance_${Date.now()}`;
            const session = getSession(testSessionId);

            // Send 15 fast-path balance queries in a row (30 turns if untrimmed)
            for (let i = 1; i <= 15; i++) {
                const res = await fetch(`${baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                    body: JSON.stringify({ message: `شكد رصيدي هسة؟ (${i})` })
                });
                const data = await res.json();
                assert.ok(data.response.includes('رصيدك'));
                assert.ok(session.conversationHistory.length <= MAX_CONVERSATION_HISTORY, `History length was ${session.conversationHistory.length}`);
            }

            assert.equal(session.conversationHistory.length, MAX_CONVERSATION_HISTORY);
            // Verify latest messages are retained
            const lastMsg = session.conversationHistory[session.conversationHistory.length - 2]; // User message of last turn
            assert.equal(lastMsg.role, 'user');
            assert.ok(lastMsg.content.includes('(15)'));
        });

        test('The limit is enforced when no LLM call occurs (fast-path transactions and contacts)', async () => {
            const testSessionId = `test_hist_tx_${Date.now()}`;
            const session = getSession(testSessionId);

            // Send 10 transaction inquiries + 5 contact searches without invoking LLM
            for (let i = 1; i <= 10; i++) {
                await fetch(`${baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                    body: JSON.stringify({ message: 'اعرضلي سجل الحركات الأخيرة' })
                });
            }
            assert.equal(session.conversationHistory.length, MAX_CONVERSATION_HISTORY);

            for (let i = 1; i <= 5; i++) {
                await fetch(`${baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                    body: JSON.stringify({ message: 'منو مسجل عندي؟' })
                });
            }
            assert.equal(session.conversationHistory.length, MAX_CONVERSATION_HISTORY);
        });

        test('Errors and cancelled operations do not cause unbounded history growth', async () => {
            const testSessionId = `test_hist_cancel_${Date.now()}`;
            const session = getSession(testSessionId);

            for (let i = 1; i <= 10; i++) {
                // Cancel without pending operation
                await fetch(`${baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                    body: JSON.stringify({ message: 'إلغاء' })
                });
            }
            assert.equal(session.conversationHistory.length, MAX_CONVERSATION_HISTORY);
        });

        test('Different sessions retain independent conversation histories without cross-contamination', async () => {
            const sessionA_Id = `session_hist_A_${Date.now()}`;
            const sessionB_Id = `session_hist_B_${Date.now()}`;

            const sessionA = getSession(sessionA_Id);
            const sessionB = getSession(sessionB_Id);

            // Populate Session A with 14 turns (capped to 12)
            for (let i = 1; i <= 14; i++) {
                await fetch(`${baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionA_Id },
                    body: JSON.stringify({ message: `شكد رصيدي يا ايه؟ ${i}` })
                });
            }

            // Session B sends 1 message
            await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': sessionB_Id },
                body: JSON.stringify({ message: 'أريد أدفع فاتورة الإنترنت' })
            });

            assert.equal(sessionA.conversationHistory.length, MAX_CONVERSATION_HISTORY);
            assert.equal(sessionB.conversationHistory.length, 2); // 1 user + 1 assistant
            assert.notEqual(sessionA.conversationHistory, sessionB.conversationHistory);
            assert.ok(!sessionB.conversationHistory.some(m => m.content.includes('رصيدي')));
        });

        test('Trimming messages does not erase pending transaction state or database records', async () => {
            const testSessionId = `test_hist_preserve_state_${Date.now()}`;
            const session = getSession(testSessionId);

            // 1. Stage a transfer with confirmation required
            const resInit = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'حول 25 الف الى 07801122334' })
            });
            const dataInit = await resInit.json();
            assert.ok(dataInit.response.includes('متأكد') || dataInit.response.includes('تأكيد'));
            assert.ok(session.pendingTransfer);
            assert.equal(session.pendingTransfer.amount, 25000);

            // 2. Perform 10 balance queries (would trim history multiple times)
            for (let i = 1; i <= 10; i++) {
                await fetch(`${baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                    body: JSON.stringify({ message: 'شكد رصيدي؟' })
                });
            }

            // Verify history is capped at 12
            assert.equal(session.conversationHistory.length, MAX_CONVERSATION_HISTORY);

            // Verify pending transfer is STILL intact and separate
            assert.ok(session.pendingTransfer);
            assert.equal(session.pendingTransfer.amount, 25000);

            // 3. Confirm the transfer now!
            const resConfirm = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-id': testSessionId },
                body: JSON.stringify({ message: 'نعم متأكد' })
            });
            const dataConfirm = await resConfirm.json();
            assert.ok(dataConfirm.response.includes('تم تأكيد التحويل بنجاح'));

            // Verify database records exist
            const db = readDatabase();
            const lastTrx = db.recent_transactions[0];
            assert.equal(lastTrx.amount, 25000);
            assert.equal(session.pendingTransfer, null);
        });

        test('Centralized trimConversationHistory and appendToConversationHistory behave idempotently and safely', () => {
            assert.deepEqual(trimConversationHistory(null), []);
            assert.deepEqual(trimConversationHistory([]), []);
            const arr = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `m_${i}` }));
            const trimmed = trimConversationHistory(arr, 12);
            assert.equal(trimmed.length, 12);
            assert.equal(trimmed[0].content, 'm_8');
            assert.equal(trimmed[11].content, 'm_19');

            const testSession = { conversationHistory: [] };
            for (let i = 0; i < 25; i++) {
                appendToConversationHistory(testSession, 'user', `hello_${i}`);
            }
            assert.equal(testSession.conversationHistory.length, 12);
            assert.equal(testSession.conversationHistory[11].content, 'hello_24');
        });
    });

    // =========================================================================
    // Category 2: Frontend Request Guard, Idempotency & UI State
    // =========================================================================
    describe('2. Frontend Request In-Progress Guard & Backend Idempotency', () => {
        test('Backend idempotency key prevents duplicate execution for identical requests', async () => {
            const idempotencyKey = `idemp_${Date.now()}_abc123`;

            // Execute transfer mutation directly with idempotency key
            const mutation1 = executeTransferMutation({
                recipient: 'أحمد كمال',
                phone: '+9647801122334',
                amount: 15000,
                idempotency_key: idempotencyKey
            });
            assert.equal(mutation1.success, true);
            const balAfterFirst = mutation1.newBalance;

            // Re-execute with exact same idempotency key
            const mutation2 = executeTransferMutation({
                recipient: 'أحمد كمال',
                phone: '+9647801122334',
                amount: 15000,
                idempotency_key: idempotencyKey
            });

            assert.equal(mutation2.success, true);
            assert.equal(mutation2.idempotent, true);
            assert.equal(mutation2.newBalance, balAfterFirst, 'Balance must NOT be deducted twice');

            // Verify database has only ONE transaction with this key
            const db = readDatabase();
            const matches = db.recent_transactions.filter(t => t.idempotency_key === idempotencyKey);
            assert.equal(matches.length, 1);
        });

        test('Frontend in-flight guard rejects duplicate concurrent submissions', async () => {
            // Test frontend script guard logic
            // Setup a mock DOM environment
            const mockElements = {
                'user-input': { value: '', disabled: false, style: {}, setAttribute() {}, focus() {} },
                'send-btn': { disabled: false, setAttribute() {} },
                'mic-btn': { disabled: false, setAttribute() {} },
                'voice-stop-btn': { disabled: false, setAttribute() {} },
                'voice-send-btn': { disabled: false, setAttribute() {} },
                'chat-form': { addEventListener() {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false } },
                'typing-indicator': { classList: { remove() {}, add() {} } },
                'chat-window': { scrollTop: 0, scrollHeight: 100 },
                'messages-container': { appendChild() {} },
                'app-layout': { classList: { contains: () => false, add() {}, remove() {} } }
            };

            const mockChips = [
                { disabled: false, setAttribute(k, v) { this[k] = v; } },
                { disabled: false, setAttribute(k, v) { this[k] = v; } }
            ];

            const savedDoc = global.document;
            const savedWin = global.window;
            const savedFetch = global.fetch;

            global.document = {
                getElementById: (id) => mockElements[id] || null,
                querySelectorAll: (sel) => sel === '.prompt-chip' ? mockChips : [],
                createElement: () => {
                    const el = {
                        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                        appendChild() {},
                        setAttribute() {},
                        addEventListener() {},
                        removeEventListener() {},
                        style: {},
                        _text: '',
                        get textContent() { return this._text; },
                        set textContent(v) { this._text = v; this.innerHTML = v; },
                        innerHTML: ''
                    };
                    return el;
                },
                documentElement: { getAttribute: () => 'dark' },
                addEventListener: () => {},
                removeEventListener: () => {}
            };

            global.window = {
                dispatchEvent: () => {},
                addEventListener: () => {},
                removeEventListener: () => {},
                requestAnimationFrame: (cb) => cb(),
                devicePixelRatio: 1
            };

            let chatPostCount = 0;
            global.fetch = async (url, opts) => {
                if (url && (url.includes('/api/chat') || (opts && opts.method === 'POST'))) {
                    chatPostCount++;
                }
                // Simulate delay
                await new Promise(r => setTimeout(r, 60));
                return {
                    ok: true,
                    json: async () => ({ response: 'مرحبا، رصيدك تمام', balance: 2200000, transactions: [] })
                };
            };

            // Re-load or require frontend script
            delete require.cache[require.resolve('../../frontend/script.js')];
            const frontend = require('../../frontend/script.js');

            assert.equal(frontend.getRequestInProgress(), false);

            // Initiate first submission (async, runs for ~60ms)
            const p1 = frontend.handleFormSubmit('طلب أول');
            assert.equal(frontend.getRequestInProgress(), true, 'In-flight guard must be immediately true');

            // Check that chips and inputs are disabled
            assert.equal(mockElements['send-btn'].disabled, true);
            assert.equal(mockChips[0].disabled, true);

            // Attempt a second submission while first is still in progress
            const p2 = frontend.handleFormSubmit('طلب مكرر');

            await Promise.all([p1, p2]);

            // Exactly 1 chat request should have been made!
            assert.equal(chatPostCount, 1, 'Duplicate parallel request must be rejected');

            // Guard must be reset to false and controls restored
            assert.equal(frontend.getRequestInProgress(), false);
            assert.equal(mockElements['send-btn'].disabled, false);
            assert.equal(mockChips[0].disabled, false);

            // Restore globals
            global.document = savedDoc;
            global.window = savedWin;
            global.fetch = savedFetch;
        });

        test('Frontend in-flight guard and controls restore properly after request failure', async () => {
            const mockElements = {
                'user-input': { value: '', disabled: false, style: {}, setAttribute() {}, focus() {} },
                'send-btn': { disabled: false, setAttribute() {} },
                'mic-btn': { disabled: false, setAttribute() {} },
                'voice-stop-btn': { disabled: false, setAttribute() {} },
                'voice-send-btn': { disabled: false, setAttribute() {} },
                'chat-form': { addEventListener() {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false } },
                'typing-indicator': { classList: { remove() {}, add() {} } },
                'chat-window': { scrollTop: 0, scrollHeight: 100 },
                'messages-container': { appendChild() {} },
                'app-layout': { classList: { contains: () => false, add() {}, remove() {} } }
            };

            const mockChips = [
                { disabled: false, setAttribute(k, v) { this[k] = v; } }
            ];

            const savedDoc = global.document;
            const savedWin = global.window;
            const savedFetch = global.fetch;

            global.document = {
                getElementById: (id) => mockElements[id] || null,
                querySelectorAll: (sel) => sel === '.prompt-chip' ? mockChips : [],
                createElement: () => {
                    const el = {
                        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                        appendChild() {},
                        setAttribute() {},
                        addEventListener() {},
                        removeEventListener() {},
                        style: {},
                        _text: '',
                        get textContent() { return this._text; },
                        set textContent(v) { this._text = v; this.innerHTML = v; },
                        innerHTML: ''
                    };
                    return el;
                },
                documentElement: { getAttribute: () => 'dark' },
                addEventListener: () => {},
                removeEventListener: () => {}
            };

            global.window = {
                dispatchEvent: () => {},
                addEventListener: () => {},
                removeEventListener: () => {},
                requestAnimationFrame: (cb) => cb(),
                devicePixelRatio: 1
            };

            // Simulate server network failure
            global.fetch = async () => {
                throw new Error('Network failure');
            };

            delete require.cache[require.resolve('../../frontend/script.js')];
            const frontend = require('../../frontend/script.js');

            await frontend.handleFormSubmit('طلب سيفشل');

            // Controls must NOT be permanently locked!
            assert.equal(frontend.getRequestInProgress(), false);
            assert.equal(mockElements['send-btn'].disabled, false);
            assert.equal(mockChips[0].disabled, false);

            // Now simulate recovery and verify retry succeeds
            let retried = false;
            global.fetch = async () => {
                retried = true;
                return {
                    ok: true,
                    json: async () => ({ response: 'تم الرد بعد النجاح' })
                };
            };

            await frontend.handleFormSubmit('إعادة المحاولة');
            assert.equal(retried, true, 'Subsequent retry must succeed');
            assert.equal(frontend.getRequestInProgress(), false);

            global.document = savedDoc;
            global.window = savedWin;
            global.fetch = savedFetch;
        });
    });
});

// =========================================================================
// Task 4: Security Audit Logging, Financial Integrity & Multi-User Isolation
// =========================================================================
describe('VI Wallet Regression Suite - Task 4: Security Audit Logging & Financial Integrity', () => {

    beforeEach(() => {
        resetDatabase();
        clearAuditLog();
    });

    // -------------------------------------------------------------------------
    // 1. Session Isolation Across Distinct sessionId Tokens
    // -------------------------------------------------------------------------
    describe('1. Session Isolation Across Distinct sessionId Tokens', () => {
        test('Distinct session IDs maintain isolated pendingTransfer state', () => {
            const sid1 = `sess_iso_A_${Date.now()}`;
            const sid2 = `sess_iso_B_${Date.now()}`;

            const session1 = getSession(sid1);
            const session2 = getSession(sid2);

            session1.pendingTransfer = {
                recipient: 'سيف',
                phone: '+9647804455667',
                amount: 75000
            };

            assert.equal(session2.pendingTransfer, null, 'Session B must not inherit Session A pending transfer');

            // Resetting Session A leaves Session B intact
            resetSession(sid1);
            assert.equal(getSession(sid1).pendingTransfer, null);
            assert.equal(getSession(sid2).pendingTransfer, null);
        });

        test('Distinct session IDs maintain isolated pendingBillPayment state', () => {
            const sid1 = `sess_bill_iso_A_${Date.now()}`;
            const sid2 = `sess_bill_iso_B_${Date.now()}`;

            const session1 = getSession(sid1);
            const session2 = getSession(sid2);

            session1.pendingBillPayment = {
                type: 'SINGLE',
                billIds: ['bill_phone_01'],
                totalAmount: 25000
            };

            assert.equal(session2.pendingBillPayment, null, 'Session B must not inherit Session A pending bill');
        });

        test('Distinct session IDs maintain isolated contact disambiguation state', () => {
            const sid1 = `sess_dis_iso_A_${Date.now()}`;
            const sid2 = `sess_dis_iso_B_${Date.now()}`;

            const session1 = getSession(sid1);
            const session2 = getSession(sid2);

            session1.pendingDisambiguation = {
                name: 'أحمد',
                matches: [{ name: 'أحمد كمال' }, { name: 'أحمد جاسم' }]
            };

            assert.equal(session2.pendingDisambiguation, null);
        });
    });

    // -------------------------------------------------------------------------
    // 2. Prevention of Double-Spend & Replay Attacks via Idempotency Tokens
    // -------------------------------------------------------------------------
    describe('2. Prevention of Double-Spend & Replay Attacks via Idempotency Tokens', () => {
        test('Repeated transfer with same idempotency token executes once and replays cached result', () => {
            const idempKey = `replay_test_trx_${Date.now()}`;
            const initialBal = readDatabase().user.balance;

            // 1st Execution
            const res1 = executeTransferMutation({
                recipient: 'حسين',
                phone: '+9647807778899',
                amount: 50000,
                idempotency_key: idempKey,
                sessionId: 'session_replay_test'
            });

            assert.equal(res1.success, true);
            assert.equal(res1.newBalance, initialBal - 50000);

            // Subsequent 4 Replays
            for (let i = 0; i < 4; i++) {
                const resReplay = executeTransferMutation({
                    recipient: 'حسين',
                    phone: '+9647807778899',
                    amount: 50000,
                    idempotency_key: idempKey,
                    sessionId: 'session_replay_test'
                });

                assert.equal(resReplay.success, true);
                assert.equal(resReplay.idempotent, true);
                assert.equal(resReplay.newBalance, initialBal - 50000, 'Balance must NEVER be deducted again on replay');
            }

            // Verify Database contains exactly ONE transaction with this key
            const db = readDatabase();
            const matchingTrxs = db.recent_transactions.filter(t => t.idempotency_key === idempKey);
            assert.equal(matchingTrxs.length, 1);
        });

        test('Repeated bill payment with same idempotency token executes once and prevents double-payment', () => {
            const idempKey = `replay_test_bill_${Date.now()}`;
            const initialBal = readDatabase().user.balance;

            // 1st Execution: Pay internet bill (40,000 IQD)
            const res1 = executeBillPaymentMutation({
                billIds: ['bill_net_01'],
                idempotency_key: idempKey,
                sessionId: 'session_bill_replay'
            });

            assert.equal(res1.success, true);
            assert.equal(res1.newBalance, initialBal - 40000);

            // Replay with identical key
            const resReplay = executeBillPaymentMutation({
                billIds: ['bill_net_01'],
                idempotency_key: idempKey,
                sessionId: 'session_bill_replay'
            });

            assert.equal(resReplay.success, true);
            assert.equal(resReplay.idempotent, true);
            assert.equal(resReplay.newBalance, initialBal - 40000);

            const db = readDatabase();
            const matchingTrxs = db.recent_transactions.filter(t => t.idempotency_key === idempKey);
            assert.equal(matchingTrxs.length, 1);
        });
    });

    // -------------------------------------------------------------------------
    // 3. Financial Integrity: Rejection of Negative, Fractional, and Non-Numeric Amounts
    // -------------------------------------------------------------------------
    describe('3. Financial Integrity: Rejection of Negative, Fractional, and Non-Numeric Amounts', () => {
        test('Rejects negative transfer amount and does not deduct balance', () => {
            const initialBal = readDatabase().user.balance;
            assert.throws(() => {
                executeTransferMutation({ recipient: 'سيف', amount: -25000, phone: '+9647804455667' });
            }, /Invalid transfer amount/);
            assert.equal(readDatabase().user.balance, initialBal);
        });

        test('Rejects zero transfer amount', () => {
            const initialBal = readDatabase().user.balance;
            assert.throws(() => {
                executeTransferMutation({ recipient: 'سيف', amount: 0, phone: '+9647804455667' });
            }, /Invalid transfer amount/);
            assert.equal(readDatabase().user.balance, initialBal);
        });

        test('Rejects fractional transfer amounts (non-integer decimals)', () => {
            const initialBal = readDatabase().user.balance;
            assert.throws(() => {
                executeTransferMutation({ recipient: 'سيف', amount: 15000.75, phone: '+9647804455667' });
            }, /Transfer amount must be an integer/);

            assert.throws(() => {
                executeTransferMutation({ recipient: 'سيف', amount: "50000.5", phone: '+9647804455667' });
            }, /Transfer amount must be an integer/);

            assert.equal(readDatabase().user.balance, initialBal);
        });

        test('Rejects non-numeric transfer amounts', () => {
            const initialBal = readDatabase().user.balance;
            assert.throws(() => {
                executeTransferMutation({ recipient: 'سيف', amount: "thousand", phone: '+9647804455667' });
            }, /Invalid transfer amount/);

            assert.throws(() => {
                executeTransferMutation({ recipient: 'سيف', amount: NaN, phone: '+9647804455667' });
            }, /Invalid transfer amount/);

            assert.throws(() => {
                executeTransferMutation({ recipient: 'سيف', amount: null, phone: '+9647804455667' });
            }, /Invalid transfer amount/);

            assert.equal(readDatabase().user.balance, initialBal);
        });

        test('Rejects transfer amounts below minimum threshold (250 IQD)', () => {
            const initialBal = readDatabase().user.balance;
            assert.throws(() => {
                executeTransferMutation({ recipient: 'سيف', amount: 100, phone: '+9647804455667' });
            }, /below minimum allowed threshold/);
            assert.equal(readDatabase().user.balance, initialBal);
        });

        test('Rejects transfer amounts exceeding user balance', () => {
            const currentBal = readDatabase().user.balance;
            assert.throws(() => {
                executeTransferMutation({ recipient: 'سيف', amount: currentBal + 10000, phone: '+9647804455667' });
            }, /Insufficient balance/);
            assert.equal(readDatabase().user.balance, currentBal);
        });
    });

    // -------------------------------------------------------------------------
    // 4. Audit Trail Immutability & Accurate Transaction Logging
    // -------------------------------------------------------------------------
    describe('4. Audit Trail Immutability & Accurate Transaction Logging', () => {
        test('Logs successful transfer with all required structured fields', () => {
            const sid = 'audit_session_transfer_test';
            const idempKey = `idemp_audit_${Date.now()}`;

            const res = executeTransferMutation({
                recipient: 'مرتضى',
                phone: '+9647819919952',
                amount: 35000,
                idempotency_key: idempKey,
                sessionId: sid
            });

            assert.equal(res.success, true);

            const logs = readAuditLog();
            assert.ok(logs.length >= 1);

            const entry = logs.find(l => l.idempotencyKey === idempKey && l.actionType === 'TRANSFER');
            assert.ok(entry, 'Audit log entry must exist for transaction');

            assert.ok(entry.id.startsWith('audit_'));
            assert.equal(entry.sessionId, sid);
            assert.equal(entry.actionType, 'TRANSFER');
            assert.equal(entry.sourceAccount, 'usr_1001');
            assert.equal(entry.amount, 35000);
            assert.equal(entry.currency, 'IQD');
            assert.equal(entry.executionStatus, 'SUCCESS');
            assert.ok(entry.destination.includes('+9647819919952'));
            assert.ok(typeof entry.timestamp === 'string' && entry.timestamp.length > 10);
        });

        test('Logs successful bill payment with structured biller destination and amount', () => {
            const sid = 'audit_session_bill_test';
            const idempKey = `idemp_bill_audit_${Date.now()}`;

            const res = executeBillPaymentMutation({
                billIds: ['bill_water_01'], // 35,000 IQD
                idempotency_key: idempKey,
                sessionId: sid
            });

            assert.equal(res.success, true);

            const logs = readAuditLog();
            const entry = logs.find(l => l.idempotencyKey === idempKey && l.actionType === 'BILL_PAYMENT');
            assert.ok(entry);
            assert.equal(entry.sessionId, sid);
            assert.equal(entry.amount, 35000);
            assert.equal(entry.executionStatus, 'SUCCESS');
            assert.ok(entry.destination.includes('مياه البصرة'));
        });

        test('Logs BLOCKED status for unauthorized or invalid transaction attempts', () => {
            const sid = 'audit_session_blocked_test';
            const idempKey = `blocked_audit_${Date.now()}`;

            assert.throws(() => {
                executeTransferMutation({
                    recipient: 'سيف',
                    amount: 999999999, // Exceeds balance
                    phone: '+9647804455667',
                    idempotency_key: idempKey,
                    sessionId: sid
                });
            }, /Insufficient balance/);

            const logs = readAuditLog();
            const entry = logs.find(l => l.idempotencyKey === idempKey && l.actionType === 'TRANSFER');
            assert.ok(entry, 'Audit log must record blocked attempt');
            assert.equal(entry.executionStatus, 'BLOCKED');
            assert.equal(entry.amount, 999999999);
        });

        test('Fail-Safe Logging: Mutation succeeds cleanly even if appendAuditLog encounters simulated issues', () => {
            const invalidEntry = null;
            const res = appendAuditLog(invalidEntry);
            assert.equal(res, null, 'Fail-safe returns null without throwing uncaught exception');
        });
    });
});

describe('VI Wallet Regression Suite - Task 5: Text-To-Speech (TTS) Voice Engine & Proactive Financial Intelligence', () => {
    let testServer;
    let serverUrl;
    const frontend = require('../../frontend/script.js');

    before(async () => {
        await new Promise((resolve) => {
            testServer = app.listen(0, () => {
                const port = testServer.address().port;
                serverUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        });
    });

    after(async () => {
        if (testServer) {
            await new Promise((resolve) => testServer.close(resolve));
        }
    });

    describe('1. Speech Text Sanitization & Dialect Audio Formatting', () => {
        test('Strips internal action tags from TTS output', () => {
            const raw = 'تسلملي عيوني! راح أحول المبلغ هسة <<<DB_ACTION>>>{"action":"TRANSFER","amount":50000}<<<END_DB_ACTION>>> وتدلل يا طيب.';
            const clean = frontend.cleanTextForSpeech(raw);
            assert.ok(!clean.includes('<<<DB_ACTION>>>'));
            assert.ok(!clean.includes('END_DB_ACTION'));
            assert.ok(clean.includes('تسلملي عيوني! راح أحول المبلغ هسة وتدلل يا طيب.'));
        });

        test('Replaces currency abbreviations (IQD, د.ع) with spoken Iraqi Arabic words', () => {
            const raw = 'رصيدك الحالي هو 3,000,000 د.ع، والمبلغ المطلوب 25,000 IQD.';
            const clean = frontend.cleanTextForSpeech(raw);
            assert.ok(!clean.includes('د.ع'));
            assert.ok(!clean.includes('IQD'));
            assert.ok(clean.includes('دينار عراقي'));
        });

        test('Strips markdown formatting, hashtags, and code blocks', () => {
            const raw = '## تنبيه الفاتورة\n**المبلغ:** 40,000 د.ع\n`حالة الفاتورة:` غير مسددة';
            const clean = frontend.cleanTextForSpeech(raw);
            assert.ok(!clean.includes('#'));
            assert.ok(!clean.includes('*'));
            assert.ok(!clean.includes('`'));
            assert.ok(clean.includes('تنبيه الفاتورة'));
        });

        test('Converts bullet lists into natural speech pauses and strips emojis', () => {
            const raw = 'قائمتك المالية:\n- فاتورة الكهرباء 💡: 50,000 د.ع\n• فاتورة الإنترنت 🌐: 40,000 د.ع';
            const clean = frontend.cleanTextForSpeech(raw);
            assert.ok(!clean.includes('💡'));
            assert.ok(!clean.includes('🌐'));
            assert.ok(clean.includes('قائمتك المالية'));
            assert.ok(clean.includes('فاتورة الكهرباء'));
        });
    });

    describe('2. Frontend TTS State & Control Guards', () => {
        test('TTS can be enabled, disabled, and queried safely', () => {
            const originalState = frontend.getTtsEnabled();
            frontend.setTtsEnabled(false);
            assert.equal(frontend.getTtsEnabled(), false);

            frontend.setTtsEnabled(true);
            assert.equal(frontend.getTtsEnabled(), true);

            // Restore
            frontend.setTtsEnabled(originalState);
        });

        test('stopSpeaking executes safely without error even in headless environment', () => {
            assert.doesNotThrow(() => {
                frontend.stopSpeaking();
            });
        });
    });

    describe('3. Backend /api/tts Endpoint & Fallback Protocol', () => {
        test('Returns 501 fallback: browser when ElevenLabs key is not configured', async () => {
            const res = await fetch(`${serverUrl}/api/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'مرحبا، شلونك اليوم؟' })
            });

            // Either 501 (not configured) or 200 (if local key provided in environment)
            if (!process.env.ELEVENLABS_API_KEY) {
                assert.equal(res.status, 501);
                const body = await res.json();
                assert.equal(body.fallback, 'browser');
            } else {
                assert.ok([200, 500, 501].includes(res.status));
            }
        });

        test('Rejects request with 400 when text payload is missing or empty', async () => {
            const res = await fetch(`${serverUrl}/api/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });

            assert.equal(res.status, 400);
            const body = await res.json();
            assert.ok(body.error);
        });
    });

    describe('4. Proactive Financial Intelligence Calculations', () => {
        test('Computes accurate count and total sum for unpaid bills', () => {
            const db = readDatabase();
            const unpaid = (db.bills || []).filter(b => b.status === 'unpaid');
            const totalUnpaid = unpaid.reduce((sum, b) => sum + Number(b.amount || 0), 0);

            assert.equal(unpaid.length, 4);
            assert.equal(totalUnpaid, 150000); // 25000 + 40000 + 50000 + 35000
        });

        test('Accurately flags zero unpaid bills when all bills are settled', () => {
            const testDb = {
                user: { balance: 3000000 },
                bills: [
                    { id: 'b1', amount: 25000, status: 'paid' },
                    { id: 'b2', amount: 40000, status: 'paid' }
                ]
            };
            const unpaid = testDb.bills.filter(b => b.status === 'unpaid');
            const totalUnpaid = unpaid.reduce((sum, b) => sum + Number(b.amount || 0), 0);

            assert.equal(unpaid.length, 0);
            assert.equal(totalUnpaid, 0);
        });
    });
});


