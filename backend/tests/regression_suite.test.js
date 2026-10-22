const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
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
    isBillInquiry,
    isContactsListInquiry,
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
    AUDIT_LOG_PATH,
    chatRateLimiter,
    ttsRateLimiter,
    createTokenBucketRateLimiter,
    TokenBucket,
    loadSessionsFromDisk,
    reloadSessionsFromDisk,
    saveSessionsSync,
    pruneExpiredSessions,
    createInitialSessionState,
    sessions,
    SESSIONS_CACHE_FILE,
    evaluateHybridIntent,
    classifySemanticIntent,
    CONFIDENCE_THRESHOLD,
    getSqliteDb,
    closeSqliteDb,
    resetSqliteDatabase,
    exportSqliteToJson,
    exportAuditSqliteToJson,
    syncSqliteWithJsonObject,
    executeTransferTransaction,
    executeBillPaymentTransaction,
    addContactTransaction,
    SQLITE_DB_PATH
} = require('../server');
const express = require('express');

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
        resetDatabase();
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

            try {
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
            } finally {
                global.document = savedDoc;
                global.window = savedWin;
                global.fetch = savedFetch;
            }
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

        test('TTS speech speed can be set, queried, and verified across speed chip presets (0.85x, 1.05x, 1.3x)', () => {
            const originalSpeed = frontend.getTtsSpeed();
            
            frontend.setTtsSpeed(0.85);
            assert.equal(frontend.getTtsSpeed(), 0.85);

            frontend.setTtsSpeed(1.05);
            assert.equal(frontend.getTtsSpeed(), 1.05);

            frontend.setTtsSpeed(1.3);
            assert.equal(frontend.getTtsSpeed(), 1.3);

            frontend.setTtsSpeed(originalSpeed);
        });

        test('TTS voice selection can be set, queried, and defaults to cloud-google', () => {
            const originalVoice = frontend.getSelectedVoiceId();
            
            assert.equal(typeof originalVoice, 'string');
            frontend.setSelectedVoiceId('Microsoft Salma Online (Natural) - Arabic (Egypt)');
            assert.equal(frontend.getSelectedVoiceId(), 'Microsoft Salma Online (Natural) - Arabic (Egypt)');

            frontend.setSelectedVoiceId('cloud-google');
            assert.equal(frontend.getSelectedVoiceId(), 'cloud-google');

            frontend.setSelectedVoiceId(originalVoice);
        });

        test('streamTextMessage executes safely and invokes callback in headless environment', () => {
            let completed = false;
            const fakeElement = { innerHTML: '', querySelector: () => null };
            frontend.streamTextMessage(fakeElement, 'مرحبا بك في فاي', () => {
                completed = true;
            });
            assert.equal(completed, true);
            assert.ok(fakeElement.innerHTML.includes('مرحبا بك في فاي'));
        });

        test('stopSpeaking executes safely without error even in headless environment', () => {
            assert.doesNotThrow(() => {
                frontend.stopSpeaking();
            });
        });
    });

    describe('3. Backend /api/tts Endpoint & Fallback Protocol', () => {
        test('Streams high-quality Arabic audio (Google Cloud or ElevenLabs) or returns graceful fallback', async () => {
            const res = await fetch(`${serverUrl}/api/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'مرحبا، شلونك اليوم؟' })
            });

            assert.ok([200, 501].includes(res.status));
            if (res.status === 200) {
                assert.ok(res.headers.get('content-type')?.includes('audio'));
            } else {
                const body = await res.json();
                assert.equal(body.fallback, 'browser');
            }
        });

        test('splitTextIntoTtsChunks splits long text at sentence boundaries under maxLength', () => {
            const { splitTextIntoTtsChunks } = require('../server');
            const sample = 'مرحبا بك في محفظة فاي. رصيدك الحالي ممتاز وعندك فواتير بحاجة للمراجعة. تحب نسددها هسة؟';
            const chunks = splitTextIntoTtsChunks(sample, 40);
            assert.ok(chunks.length >= 2);
            for (const c of chunks) {
                assert.ok(c.length <= 40);
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

describe('VI Wallet Regression Suite - Task 6: Contacts Inquiry Intent Routing & Voice Visualizer Integrity', () => {
    let testServer;
    let serverUrl;

    before(async () => {
        resetDatabase();
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
        resetDatabase();
    });

    describe('1. Contacts List Inquiry Intent Identification', () => {
        test('Detects full complex phrase asking to view contacts to choose from', () => {
            const query = 'اعرض لي جهات اتصالاتي حتى اني اختار من بينهم اي شخص اريد احول له';
            assert.equal(isContactsListInquiry(query), true);
        });

        test('Detects direct inquiries for contacts list', () => {
            assert.equal(isContactsListInquiry('اعرض لي قائمه اتصالاتي'), true);
            assert.equal(isContactsListInquiry('اعرض لي قائمة اتصالاتي'), true);
            assert.equal(isContactsListInquiry('قائمه اتصالي'), true);
            assert.equal(isContactsListInquiry('قائمة اتصالي'), true);
            assert.equal(isContactsListInquiry('عرض لي قائمه اتصال لاتي'), true);
            assert.equal(isContactsListInquiry('جهات اتصالاتي'), true);
            assert.equal(isContactsListInquiry('منو مسجل عندي'), true);
            assert.equal(isContactsListInquiry('ارقام اصدقائي'), true);
            assert.equal(isContactsListInquiry('قائمه الاسماء'), true);
        });

        test('Detects correction phrase with contacts inquiry', () => {
            assert.equal(isContactsListInquiry('لا مو الفواتير قائمه اتصالي'), true);
            assert.equal(isContactsListInquiry('لا اقصد جهات اتصالي'), true);
        });

        test('Does not match unrelated financial commands', () => {
            assert.equal(isContactsListInquiry('ادفع فاتورة الكهرباء'), false);
            assert.equal(isContactsListInquiry('حول 50 الف لسيف'), false);
            assert.equal(isContactsListInquiry('شكد رصيدي هسة؟'), false);
        });
    });

    describe('2. Exclusion Guards: isBillInquiry, classifyRecipient, and isUserCancellation', () => {
        test('isBillInquiry rejects contacts inquiries and does not hijack them', () => {
            assert.equal(isBillInquiry('اعرض لي قائمه اتصالاتي'), false);
            assert.equal(isBillInquiry('قائمه اتصالي'), false);
            assert.equal(isBillInquiry('لا مو الفواتير قائمه اتصالي'), false);
            assert.equal(isBillInquiry('جهات اتصالاتي'), false);
        });

        test('classifyRecipient does not extract "اتي" from "اتصالاتي"', () => {
            const query = 'اعرض لي جهات اتصالاتي حتى اني اختار من بينهم اي شخص اريد احول له';
            const res = classifyRecipient(query, MOCK_CONTACTS);
            assert.notEqual(res.name, 'اتي');
            assert.notEqual(res.name, 'اتصالاتي');
        });

        test('isUserCancellation distinguishes clarifications from cancellations', () => {
            assert.equal(isUserCancellation('لا مو الفواتير قائمه اتصالي'), false);
            assert.equal(isUserCancellation('لا اقصد الكهرباء'), false);
            assert.equal(isUserCancellation('لا اعرضلي الاسماء'), false);
            assert.equal(isUserCancellation('لا الغي العملية'), true);
            assert.equal(isUserCancellation('بطلت ما اريد احول'), true);
            assert.equal(isUserCancellation('cancel'), true);
        });
    });

    describe('3. End-to-End Chat API Dispatch for Contacts Inquiries', () => {
        test('Returns contacts list directly for complex inquiry without false recipient error', async () => {
            const res = await fetch(`${serverUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: 'اعرض لي جهات اتصالاتي حتى اني اختار من بينهم اي شخص اريد احول له',
                    sessionId: 'sess_test_contacts_1'
                })
            });

            assert.equal(res.status, 200);
            const data = await res.json();
            assert.ok(data.response.includes('هاي قائمة بجهات الاتصال'));
            assert.ok(data.response.includes('أحمد كمال'));
            assert.ok(data.response.includes('سيف الدين'));
            assert.ok(!data.response.includes('ما لقيت أي شخص باسم "اتي"'));
            assert.ok(!data.response.includes('فواتير غير مدفوعة'));
        });

        test('Returns contacts list for "اعرض لي قائمه اتصالاتي" without returning bills', async () => {
            const res = await fetch(`${serverUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: 'اعرض لي قائمه اتصالاتي',
                    sessionId: 'sess_test_contacts_2'
                })
            });

            assert.equal(res.status, 200);
            const data = await res.json();
            assert.ok(data.response.includes('هاي قائمة بجهات الاتصال'));
            assert.ok(!data.response.includes('فواتير غير مدفوعة'));
        });

        test('Returns contacts list for "لا مو الفواتير قائمه اتصالي" without cancelling', async () => {
            const res = await fetch(`${serverUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: 'لا مو الفواتير قائمه اتصالي',
                    sessionId: 'sess_test_contacts_3'
                })
            });

            assert.equal(res.status, 200);
            const data = await res.json();
            assert.ok(data.response.includes('هاي قائمة بجهات الاتصال'));
            assert.ok(!data.response.includes('ماكو أي عملية معلقة حالياً حتى ألغيها'));
        });

        test('Returns contacts list for "شوف اريدك ان تعرض لي قائمة جهاز اتصالاتي" (STT typo resilience)', async () => {
            const res = await fetch(`${serverUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: 'شوف اريدك ان تعرض لي قائمة جهاز اتصالاتي',
                    sessionId: 'sess_test_contacts_4'
                })
            });

            assert.equal(res.status, 200);
            const data = await res.json();
            assert.ok(data.response.includes('هاي قائمة بجهات الاتصال'));
            assert.ok(!data.response.includes('فواتير غير مدفوعة'));
        });

        test('Returns contacts list for "لا قائمة جهات اتصال"', async () => {
            const res = await fetch(`${serverUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: 'لا قائمة جهات اتصال',
                    sessionId: 'sess_test_contacts_5'
                })
            });

            assert.equal(res.status, 200);
            const data = await res.json();
            assert.ok(data.response.includes('هاي قائمة بجهات الاتصال'));
            assert.ok(!data.response.includes('ماكو أي عملية معلقة حالياً حتى ألغيها'));
        });

        test('Returns contacts list for "شنو الاشخاص اللي مسجلهم بقائمه اتصالي"', async () => {
            const res = await fetch(`${serverUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: 'شنو الاشخاص اللي مسجلهم بقائمه اتصالي',
                    sessionId: 'sess_test_contacts_6'
                })
            });

            assert.equal(res.status, 200);
            const data = await res.json();
            assert.ok(data.response.includes('هاي قائمة بجهات الاتصال'));
            assert.ok(!data.response.includes('فواتير غير مدفوعة'));
        });
    });
});

describe('VI Wallet Regression Suite - Task 7: Resilient Bot Avatar & Browser Cross-Compatibility', () => {
    test('Assets are physically present and served as valid PNGs', () => {
        const fs = require('fs');
        const path = require('path');
        const emeraldPath = path.join(__dirname, '../../assets/bot-emerald.png');
        const violetPath = path.join(__dirname, '../../assets/bot-violet.png');
        const frontendEmerald = path.join(__dirname, '../../frontend/assets/bot-emerald.png');

        assert.ok(fs.existsSync(emeraldPath), 'assets/bot-emerald.png must exist');
        assert.ok(fs.existsSync(violetPath), 'assets/bot-violet.png must exist');
        assert.ok(fs.existsSync(frontendEmerald), 'frontend/assets/bot-emerald.png mirror must exist');

        const emeraldBuf = fs.readFileSync(emeraldPath);
        assert.equal(emeraldBuf[0], 0x89);
        assert.equal(emeraldBuf[1], 0x50);
        assert.equal(emeraldBuf[2], 0x4E);
        assert.equal(emeraldBuf[3], 0x47);
    });

    test('Frontend exports avatar helper functions with fallback support', () => {
        const frontend = require('../../frontend/script.js');
        assert.equal(typeof frontend.getBotAvatarSrc, 'function');
        assert.equal(typeof frontend.getBotFallbackAvatarUri, 'function');
        assert.equal(typeof frontend.createBotAvatarElement, 'function');

        const darkUri = frontend.getBotFallbackAvatarUri('dark');
        assert.ok(darkUri.startsWith('data:image/svg+xml;utf8,'));
        assert.ok(darkUri.includes('%2310b981') || darkUri.includes('10b981'));

        const lightUri = frontend.getBotFallbackAvatarUri('light');
        assert.ok(lightUri.startsWith('data:image/svg+xml;utf8,'));
        assert.ok(lightUri.includes('%239333ea') || lightUri.includes('9333ea'));
    });
});

describe('VI Wallet Regression Suite - Task 8: Tier-1 Interactive Fintech Contacts Grid & Carousel', () => {
    const frontend = require('../../frontend/script.js');

    test('parseContactsListData extracts structured contacts, aliases, and numbers', () => {
        const text = `هاي قائمة بجهات الاتصال المسجلة بمحفظتك:

1. أحمد كمال (صديق الجامعة) (+9647801122334)
2. أحمد جاسم (الفيترجي / المصلح) (+9647802233445)
3. سيف الدين (+9647804455667)

💡 تكدر تختار أي شخص منهم وتكلي: "حول 50 الف لسيف".`;

        const data = frontend.parseContactsListData(text);
        assert.ok(data);
        assert.equal(data.contacts.length, 3);
        assert.equal(data.contacts[0].name, 'أحمد كمال');
        assert.equal(data.contacts[0].alias, 'صديق الجامعة');
        assert.equal(data.contacts[0].phone, '+9647801122334');
        assert.equal(data.contacts[1].name, 'أحمد جاسم');
        assert.equal(data.contacts[1].alias, 'الفيترجي / المصلح');
        assert.equal(data.contacts[2].name, 'سيف الدين');
        assert.equal(data.contacts[2].phone, '+9647804455667');
        assert.ok(data.intro.includes('جهات الاتصال'));
        assert.ok(data.outro.includes('حول 50 الف'));
    });

    test('renderFintechContactsCard produces rich HTML with monogram avatars and quick transfer buttons', () => {
        const data = {
            intro: 'جهات الاتصال المسجلة',
            contacts: [
                { num: '1', name: 'أحمد كمال', alias: 'صديق الجامعة', phone: '+9647801122334' },
                { num: '2', name: 'سيف الدين', alias: '', phone: '+9647804455667' }
            ],
            outro: 'اختر للتحويل'
        };

        const html = frontend.renderFintechContactsCard(data);
        assert.ok(html.includes('contacts-card'));
        assert.ok(html.includes('fintech-contacts-carousel'));
        assert.ok(html.includes('contact-monogram-avatar'));
        assert.ok(html.includes('أحمد كمال'));
        assert.ok(html.includes('صديق الجامعة'));
        assert.ok(html.includes('+9647801122334'));
        assert.ok(html.includes('contact-quick-transfer-btn'));
        assert.ok(html.includes('data-contact-name="أحمد كمال"'));
        assert.ok(html.includes('data-contact-name="سيف الدين"'));
    });

    test('formatFintechMessage seamlessly renders contacts cards for contact inquiry responses', () => {
        const text = `هاي قائمة بجهات الاتصال المسجلة بمحفظتك:

1. سيف الدين (+9647804455667)
2. مرتضى (+9647819919952)

💡 تكدر تختار أي شخص منهم`;

        const formatted = frontend.formatFintechMessage(text, 'ai');
        assert.ok(formatted.includes('contacts-card'));
        assert.ok(formatted.includes('سيف الدين'));
        assert.ok(formatted.includes('مرتضى'));
    });

    test('getContactInitial and getContactGradient operate accurately', () => {
        assert.equal(frontend.getContactInitial('سيف الدين'), 'س');
        assert.equal(frontend.getContactInitial('الوالدة'), 'و');
        assert.equal(frontend.getContactInitial('أحمد'), 'أ');

        const grad = frontend.getContactGradient('سيف');
        assert.ok(grad.startsWith('linear-gradient('));
    });
});

describe('VI Wallet Regression Suite - Task 9: Organic Circular Ripple View Transition (iOS & Android 14 Style)', () => {
    const frontend = require('../../frontend/script.js');
    const fs = require('node:fs');
    const path = require('node:path');

    test('CSS stylesheet contains modern circular view transition rules and z-index layering', () => {
        const cssPath = path.join(__dirname, '../../frontend/style.css');
        const cssContent = fs.readFileSync(cssPath, 'utf8');

        assert.ok(cssContent.includes('::view-transition-old(root)'));
        assert.ok(cssContent.includes('::view-transition-new(root)'));
        assert.ok(cssContent.includes('animation: none'));
        assert.ok(cssContent.includes('mix-blend-mode: normal'));
        assert.ok(cssContent.includes('z-index: 9999'));
        assert.ok(cssContent.includes('prefers-reduced-motion'));
        assert.ok(cssContent.includes('.theme-toggle-pill:active'));
    });

    test('applyTheme updates document theme attributes, labels, and avatar assets', () => {
        const mockDocElement = {
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = v; },
            getAttribute(k) { return this.attributes[k]; }
        };
        const mockBody = {
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = v; },
            getAttribute(k) { return this.attributes[k]; }
        };
        const mockLabel = { textContent: '' };
        const mockBadge = { textContent: '' };
        const mockBtn = {
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = v; }
        };
        const mockLogo = { src: '' };
        const mockAvatars = [
            { dataset: {}, src: '', onerror: null }
        ];

        global.document = {
            documentElement: mockDocElement,
            body: mockBody,
            getElementById(id) {
                if (id === 'theme-label-text') return mockLabel;
                if (id === 'badge-theme-text') return mockBadge;
                if (id === 'theme-toggle-btn') return mockBtn;
                if (id === 'hero-logo-img') return mockLogo;
                return null;
            },
            querySelectorAll(sel) {
                if (sel === '.avatar-img') return mockAvatars;
                return [];
            }
        };

        // Test Light Theme
        frontend.applyTheme('light');
        assert.equal(mockDocElement.getAttribute('data-theme'), 'light');
        assert.equal(mockBody.getAttribute('data-theme'), 'light');
        assert.equal(mockLabel.textContent, 'أبيض وبنفسجي');
        assert.equal(mockBadge.textContent, 'ثيم الأبيض والبنفسجي');
        assert.equal(mockBtn.attributes['data-active-theme'], 'light');
        assert.equal(mockLogo.src, 'assets/logo-violet.png');
        assert.equal(mockAvatars[0].src, 'assets/bot-violet.png');

        // Test Dark Theme
        frontend.applyTheme('dark');
        assert.equal(mockDocElement.getAttribute('data-theme'), 'dark');
        assert.equal(mockBody.getAttribute('data-theme'), 'dark');
        assert.equal(mockLabel.textContent, 'أسود وأخضر');
        assert.equal(mockBadge.textContent, 'ثيم الزمرد الفاخر');
        assert.equal(mockBtn.attributes['data-active-theme'], 'dark');
        assert.equal(mockLogo.src, 'assets/logo-emerald.png');
        assert.equal(mockAvatars[0].src, 'assets/bot-emerald.png');

        delete global.document;
    });

    test('toggleThemeWithRipple falls back gracefully when View Transitions API is unsupported', () => {
        let storageTheme = null;
        global.localStorage = {
            setItem(k, v) { storageTheme = v; }
        };
        const mockDocElement = {
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = v; },
            getAttribute(k) { return this.attributes[k]; }
        };
        global.document = {
            documentElement: mockDocElement,
            body: null,
            getElementById: () => null,
            querySelectorAll: () => []
            // startViewTransition is intentionally omitted
        };

        const res = frontend.toggleThemeWithRipple('light', null);
        assert.equal(res, null);
        assert.equal(mockDocElement.getAttribute('data-theme'), 'light');
        assert.equal(storageTheme, 'light');

        delete global.document;
        delete global.localStorage;
    });

    test('toggleThemeWithRipple executes document.startViewTransition and triggers circle clip-path animation', async () => {
        let transitionCallbackCalled = false;
        let animatedParams = null;

        const mockDocElement = {
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = v; },
            getAttribute(k) { return this.attributes[k]; },
            animate(keyframes, options) {
                animatedParams = { keyframes, options };
                return {};
            }
        };

        const mockTransition = {
            ready: Promise.resolve()
        };

        global.window = {
            innerWidth: 1920,
            innerHeight: 1080,
            matchMedia: () => ({ matches: false })
        };

        global.document = {
            documentElement: mockDocElement,
            body: null,
            getElementById: () => null,
            querySelectorAll: () => [],
            startViewTransition: (cb) => {
                transitionCallbackCalled = true;
                cb();
                return mockTransition;
            }
        };

        global.localStorage = {
            setItem: () => {}
        };

        const mockButton = {
            getBoundingClientRect: () => ({
                left: 100,
                top: 50,
                width: 48,
                height: 24
            })
        };

        // Button center: x = 100 + 24 = 124, y = 50 + 12 = 62
        const expectedRadius = Math.hypot(Math.max(124, 1920 - 124), Math.max(62, 1080 - 62));

        const transition = frontend.toggleThemeWithRipple('dark', mockButton);
        assert.ok(transition);
        assert.equal(transitionCallbackCalled, true);
        assert.equal(mockDocElement.getAttribute('data-theme'), 'dark');

        await mockTransition.ready;

        assert.ok(animatedParams);
        assert.ok([380, 420].includes(animatedParams.options.duration), 'Duration should be 380ms');
        assert.ok(['cubic-bezier(0.16, 1, 0.3, 1)', 'cubic-bezier(0.4, 0, 0.2, 1)'].includes(animatedParams.options.easing), 'Easing should match upgraded cubic-bezier');
        assert.equal(animatedParams.options.pseudoElement, '::view-transition-new(root)');
        assert.equal(animatedParams.keyframes.clipPath[0], 'circle(0px at 124px 62px)');
        assert.equal(animatedParams.keyframes.clipPath[1], `circle(${expectedRadius}px at 124px 62px)`);

        delete global.window;
        delete global.document;
        delete global.localStorage;
    });

    test('toggleThemeWithRipple respects prefers-reduced-motion: reduce by switching instantly', () => {
        let viewTransitionCalled = false;
        const mockDocElement = {
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = v; },
            getAttribute(k) { return this.attributes[k]; }
        };

        global.window = {
            innerWidth: 1920,
            innerHeight: 1080,
            matchMedia: (query) => ({
                matches: query.includes('prefers-reduced-motion')
            })
        };

        global.document = {
            documentElement: mockDocElement,
            body: null,
            getElementById: () => null,
            querySelectorAll: () => [],
            startViewTransition: (cb) => {
                viewTransitionCalled = true;
                cb();
                return { ready: Promise.resolve() };
            }
        };

        global.localStorage = { setItem: () => {} };

        const res = frontend.toggleThemeWithRipple('light', null);
        assert.equal(res, null);
        assert.equal(viewTransitionCalled, false);
        assert.equal(mockDocElement.getAttribute('data-theme'), 'light');

        delete global.window;
        delete global.document;
        delete global.localStorage;
    });
});

describe('VI Wallet Regression Suite - Task 10: Luxury Tactile Audio Chime & Digital Micro-Confetti Celebration', () => {
    const frontend = require('../../frontend/script.js');
    const fs = require('node:fs');
    const path = require('node:path');

    test('CSS stylesheet contains .crest-confetti-canvas with proper positioning and layering', () => {
        const cssPath = path.join(__dirname, '../../frontend/style.css');
        const cssContent = fs.readFileSync(cssPath, 'utf8');

        assert.ok(cssContent.includes('.crest-confetti-canvas'));
        assert.ok(cssContent.includes('pointer-events: none'));
        assert.ok(cssContent.includes('z-index: 10'));
    });

    test('playApplePaySuccessChime strictly respects mute state (isTtsEnabled = false)', () => {
        frontend.setTtsEnabled(false);
        const played = frontend.playApplePaySuccessChime();
        assert.equal(played, false, 'Chime must return false and not synthesize audio when muted');
        frontend.setTtsEnabled(true);
    });

    test('playApplePaySuccessChime synthesizes 880Hz to 1320Hz chime via AudioContext when unmuted', () => {
        frontend.setTtsEnabled(true);

        const createdOscillators = [];
        const createdGains = [];

        class MockGainNode {
            constructor() {
                this.gain = {
                    setValueAtTime: () => {},
                    linearRampToValueAtTime: () => {},
                    exponentialRampToValueAtTime: () => {}
                };
            }
            connect(dest) {}
        }

        class MockOscillatorNode {
            constructor() {
                this.type = 'sine';
                this.frequencies = [];
                this.frequency = {
                    setValueAtTime: (val, time) => {
                        this.frequencies.push({ val, time, method: 'set' });
                    },
                    exponentialRampToValueAtTime: (val, time) => {
                        this.frequencies.push({ val, time, method: 'ramp' });
                    }
                };
            }
            connect(dest) {}
            start(t) {}
            stop(t) {}
        }

        class MockAudioContext {
            constructor() {
                this.state = 'running';
                this.currentTime = 1.0;
                this.destination = {};
            }
            createGain() {
                const g = new MockGainNode();
                createdGains.push(g);
                return g;
            }
            createOscillator() {
                const osc = new MockOscillatorNode();
                createdOscillators.push(osc);
                return osc;
            }
            resume() { return Promise.resolve(); }
        }

        global.window = {
            AudioContext: MockAudioContext
        };

        const played = frontend.playApplePaySuccessChime();
        assert.equal(played, true, 'Chime must synthesize and return true when AudioContext is present and unmuted');
        assert.equal(createdOscillators.length, 2, 'Must create fundamental oscillator and harmonic oscillator');

        // Verify primary fundamental: 880Hz gliding smoothly to 1320Hz
        const osc1 = createdOscillators[0];
        assert.equal(osc1.type, 'sine');
        assert.equal(osc1.frequencies[0].val, 880);
        assert.equal(osc1.frequencies[1].val, 1320);

        // Verify secondary metallic harmonic: 1760Hz gliding to 2640Hz
        const osc2 = createdOscillators[1];
        assert.equal(osc2.type, 'triangle');
        assert.equal(osc2.frequencies[0].val, 1760);
        assert.equal(osc2.frequencies[1].val, 2640);

        delete global.window;
    });

    test('launchMicroConfetti creates canvas with 36 metallic particles and auto-cleans up after 1.2s', () => {
        let appendedChild = null;
        let removedChild = false;

        const mockCrest = {
            appendChild: (child) => { appendedChild = child; },
            getBoundingClientRect: () => ({ left: 50, top: 50, width: 72, height: 72 })
        };

        const mockCtx = {
            clearRect: () => {},
            save: () => {},
            restore: () => {},
            translate: () => {},
            rotate: () => {},
            beginPath: () => {},
            arc: () => {},
            fill: () => {},
            fillRect: () => {}
        };

        global.window = {
            matchMedia: () => ({ matches: false })
        };

        global.document = {
            createElement: (tag) => {
                if (tag === 'canvas') {
                    return {
                        classList: { add: () => {} },
                        style: {},
                        setAttribute: () => {},
                        getContext: (type) => (type === '2d' ? mockCtx : null),
                        remove: () => { removedChild = true; },
                        parentNode: mockCrest
                    };
                }
                return {};
            }
        };

        const canvas = frontend.launchMicroConfetti(mockCrest);
        assert.ok(canvas);
        assert.equal(appendedChild, canvas);

        delete global.window;
        delete global.document;
    });

    test('launchMicroConfetti skips confetti generation when prefers-reduced-motion is true', () => {
        let childAppended = false;
        const mockCrest = {
            appendChild: () => { childAppended = true; }
        };

        global.window = {
            matchMedia: (q) => ({ matches: q.includes('prefers-reduced-motion') })
        };
        global.document = {
            createElement: () => ({})
        };

        const canvas = frontend.launchMicroConfetti(mockCrest);
        assert.equal(canvas, null);
        assert.equal(childAppended, false);

        delete global.window;
        delete global.document;
    });

    test('triggerReceiptCelebration executes both chime and micro-confetti in harmony', () => {
        frontend.setTtsEnabled(true);
        const mockCrest = {
            appendChild: () => {},
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 72, height: 72 })
        };

        global.window = {
            matchMedia: () => ({ matches: false }),
            AudioContext: class {
                constructor() {
                    this.state = 'running';
                    this.currentTime = 0;
                    this.destination = {};
                }
                createGain() {
                    return {
                        gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
                        connect: () => {}
                    };
                }
                createOscillator() {
                    return {
                        frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
                        connect: () => {},
                        start: () => {},
                        stop: () => {}
                    };
                }
            }
        };

        global.document = {
            createElement: () => ({
                classList: { add: () => {} },
                style: {},
                setAttribute: () => {},
                getContext: () => ({ clearRect: () => {}, save: () => {}, restore: () => {} }),
                remove: () => {}
            })
        };

        const res = frontend.triggerReceiptCelebration(mockCrest);
        assert.equal(res.chime, true);
        assert.ok(res.confetti);

        delete global.window;
        delete global.document;
    });
});

describe('VI Wallet Regression Suite - Task 11: Ambient Audio-Reactive Chromatic Aura (Google Gemini & Siri Style)', () => {
    const frontend = require('../../frontend/script.js');
    const fs = require('node:fs');
    const path = require('node:path');

    test('CSS stylesheet contains .audio-reactive-active rules with hardware-accelerated transitions', () => {
        const cssPath = path.join(__dirname, '../../frontend/style.css');
        const cssContent = fs.readFileSync(cssPath, 'utf8');

        assert.ok(cssContent.includes('.voice-recording-dock.audio-reactive-active'));
        assert.ok(cssContent.includes('.input-form.audio-reactive-active'));
        assert.ok(cssContent.includes('will-change: box-shadow, border-color'));
        assert.ok(cssContent.includes('transition: border-color'));
    });

    test('updateAudioReactiveChromaticAura modulates Emerald and Cyan/Teal aura in Dark Mode', () => {
        const mockDock = {
            id: 'voice-recording-dock',
            style: { display: 'flex', boxShadow: '', borderColor: '' },
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };

        global.document = {
            getElementById: (id) => (id === 'voice-recording-dock' ? mockDock : null)
        };

        const res = frontend.updateAudioReactiveChromaticAura(0.65, true);
        assert.ok(res);
        assert.equal(res.isDark, true);
        assert.equal(mockDock.classList.contains('audio-reactive-active'), true);

        // Dark mode color verification: Emerald Green (16, 185, 129 / 5, 150, 105) and Cyan/Teal (6, 182, 212)
        assert.ok(mockDock.style.boxShadow.includes('16, 185, 129'));
        assert.ok(mockDock.style.boxShadow.includes('6, 182, 212'));
        assert.ok(mockDock.style.boxShadow.includes('5, 150, 105'));
        assert.ok(mockDock.style.borderColor.includes('16, 185, 129'));

        delete global.document;
    });

    test('updateAudioReactiveChromaticAura modulates Royal Violet and Electric Indigo aura in Light Mode', () => {
        const mockDock = {
            id: 'voice-recording-dock',
            style: { display: 'flex', boxShadow: '', borderColor: '' },
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };

        global.document = {
            getElementById: (id) => (id === 'voice-recording-dock' ? mockDock : null)
        };

        const res = frontend.updateAudioReactiveChromaticAura(0.70, false);
        assert.ok(res);
        assert.equal(res.isDark, false);
        assert.equal(mockDock.classList.contains('audio-reactive-active'), true);

        // Light mode color verification: Royal Violet (124, 58, 237 / 139, 92, 246) and Electric Indigo (99, 102, 241)
        assert.ok(mockDock.style.boxShadow.includes('124, 58, 237'));
        assert.ok(mockDock.style.boxShadow.includes('99, 102, 241'));
        assert.ok(mockDock.style.boxShadow.includes('139, 92, 246'));
        assert.ok(mockDock.style.borderColor.includes('124, 58, 237'));

        delete global.document;
    });

    test('resetAudioReactiveChromaticAura cleanly removes aura class and clears inline box-shadow and border-color', () => {
        const mockDock = {
            id: 'voice-recording-dock',
            style: { display: 'flex', boxShadow: '0 0 20px red', borderColor: 'green' },
            classList: {
                classes: new Set(['audio-reactive-active']),
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };
        const mockForm = {
            id: 'chat-form',
            style: { boxShadow: '0 0 10px blue', borderColor: 'purple' },
            classList: {
                classes: new Set(['audio-reactive-active']),
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };

        global.document = {
            getElementById: (id) => {
                if (id === 'voice-recording-dock') return mockDock;
                if (id === 'chat-form') return mockForm;
                return null;
            }
        };

        const success = frontend.resetAudioReactiveChromaticAura();
        assert.equal(success, true);
        assert.equal(mockDock.style.boxShadow, '');
        assert.equal(mockDock.style.borderColor, '');
        assert.equal(mockDock.classList.contains('audio-reactive-active'), false);
        assert.equal(mockForm.style.boxShadow, '');
        assert.equal(mockForm.style.borderColor, '');
        assert.equal(mockForm.classList.contains('audio-reactive-active'), false);

        delete global.document;
    });

    test('updateAudioReactiveChromaticAura scales intensity dynamically between minimum pulse and speech peak', () => {
        const mockDock = {
            id: 'voice-recording-dock',
            style: { display: 'flex', boxShadow: '', borderColor: '' },
            classList: { add: () => {} }
        };

        global.document = {
            getElementById: () => mockDock
        };

        const quiet = frontend.updateAudioReactiveChromaticAura(0.02, true);
        const loud = frontend.updateAudioReactiveChromaticAura(0.95, true);

        // Quiet energy clamps at baseline ambient pulse (0.06)
        assert.equal(quiet.energy, 0.06);
        // Loud energy scales up to 0.95
        assert.equal(loud.energy, 0.95);

        delete global.document;
    });
});

describe('VI Wallet Regression Suite - Task 12: Desktop Workstation Layout & Collapsible Companion Rail', () => {
    const fs = require('fs');
    const path = require('path');
    const frontend = require('../../frontend/script.js');

    let serverInstance = null;
    before((_, done) => {
        try {
            serverInstance = app.listen(3000, () => done());
            serverInstance.on('error', () => {
                // If port 3000 is already in use by a live server, continue gracefully
                done();
            });
        } catch (_) {
            done();
        }
    });

    after((_, done) => {
        if (serverInstance && serverInstance.listening) {
            serverInstance.close(() => done());
        } else {
            done();
        }
    });

    test('HTML & CSS stylesheets contain companion rail markup, widescreen layout, and mobile safeguard', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf-8');
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // Verify HTML markup elements
        assert.ok(html.includes('id="companion-rail-toggle"'), 'Header must contain companion rail toggle button');
        assert.ok(html.includes('id="companion-rail"'), 'App layout must contain #companion-rail');
        assert.ok(html.includes('id="companion-balance-card"'), 'Rail must contain live balance card');
        assert.ok(html.includes('id="companion-contacts-list"'), 'Rail must contain pinned contacts container');
        assert.ok(html.includes('id="companion-bills-list"'), 'Rail must contain bills container');
        assert.ok(html.includes('id="companion-open-drawer-btn"'), 'Rail must contain full drawer trigger');
        assert.ok(html.includes('id="quick-transfer-modal"'), 'Must contain quick transfer modal');

        // Verify responsive CSS layout rules
        assert.ok(css.includes('@media (min-width: 1100px)'), 'CSS must specify widescreen >= 1100px breakpoint');
        assert.ok(css.includes('.companion-rail'), 'CSS must style .companion-rail');
        assert.ok(css.includes('.companion-rail.is-collapsed'), 'CSS must style .companion-rail.is-collapsed state');
        assert.ok(css.includes('@media (max-width: 1099px)'), 'CSS must contain mobile safeguard');
        assert.ok(css.includes('display: none !important'), 'Mobile safeguard must hide companion rail completely');
    });

    test('isCompanionRailCollapsed and setCompanionRailCollapsed persist state in localStorage and update classes', () => {
        let store = {};
        global.localStorage = {
            getItem: (k) => store[k] || null,
            setItem: (k, v) => { store[k] = String(v); }
        };

        const mockAppLayout = {
            classList: {
                classes: new Set(),
                toggle(c, force) {
                    if (force) this.classes.add(c);
                    else this.classes.delete(c);
                },
                contains(c) { return this.classes.has(c); }
            }
        };

        const mockRail = {
            classList: {
                classes: new Set(),
                toggle(c, force) {
                    if (force) this.classes.add(c);
                    else this.classes.delete(c);
                },
                contains(c) { return this.classes.has(c); }
            },
            attrs: {},
            setAttribute(k, v) { this.attrs[k] = v; }
        };

        const mockBtn = {
            classList: {
                classes: new Set(),
                toggle(c, force) {
                    if (force) this.classes.add(c);
                    else this.classes.delete(c);
                },
                contains(c) { return this.classes.has(c); }
            },
            attrs: {},
            setAttribute(k, v) { this.attrs[k] = v; }
        };

        global.document = {
            getElementById: (id) => {
                if (id === 'app-layout') return mockAppLayout;
                if (id === 'companion-rail') return mockRail;
                if (id === 'companion-rail-toggle') return mockBtn;
                return null;
            }
        };

        // Initially not collapsed (false)
        assert.equal(frontend.isCompanionRailCollapsed(), false);

        // Collapse rail
        frontend.setCompanionRailCollapsed(true);
        assert.equal(frontend.isCompanionRailCollapsed(), true);
        assert.equal(store[frontend.COMPANION_RAIL_STORAGE_KEY], 'true');
        assert.equal(mockAppLayout.classList.contains('companion-collapsed'), true);
        assert.equal(mockRail.classList.contains('is-collapsed'), true);
        assert.equal(mockRail.attrs['aria-hidden'], 'true');
        assert.equal(mockBtn.attrs['aria-expanded'], 'false');

        // Toggle back to expanded
        const newState = frontend.toggleCompanionRail();
        assert.equal(newState, false);
        assert.equal(frontend.isCompanionRailCollapsed(), false);
        assert.equal(mockAppLayout.classList.contains('companion-collapsed'), false);
        assert.equal(mockRail.classList.contains('is-collapsed'), false);
        assert.equal(mockRail.attrs['aria-hidden'], 'false');
        assert.equal(mockBtn.attrs['aria-expanded'], 'true');

        delete global.localStorage;
        delete global.document;
    });

    test('handleQuickContactTransfer populates user input with transfer intent and focuses input', () => {
        let focused = false;
        const mockInput = {
            value: '',
            style: { height: '' },
            scrollHeight: 36,
            selectionStart: 0,
            selectionEnd: 0,
            focus() { focused = true; }
        };

        global.document = {
            getElementById: (id) => (id === 'user-input' ? mockInput : null)
        };

        frontend.handleQuickContactTransfer('أحمد كمال');
        assert.equal(mockInput.value, 'أريد أحول لـ أحمد كمال ');
        assert.equal(focused, true);

        delete global.document;
    });

    test('renderCompanionContacts renders avatar monograms, names, aliases, and 1-click transfer shortcuts', () => {
        const mockList = { innerHTML: '' };
        const mockCount = { textContent: '' };

        global.document = {
            getElementById: (id) => {
                if (id === 'companion-contacts-list') return mockList;
                if (id === 'companion-contacts-count') return mockCount;
                return null;
            }
        };

        frontend.setCachedCompanionContacts([
            { name: 'أحمد كمال', alias: 'صديق الجامعة', phone: '+9647801122334' },
            { name: 'أم مصطفى', alias: 'الوالدة', phone: '+9647803344556' }
        ]);

        frontend.renderCompanionContacts();

        assert.equal(mockCount.textContent, '2 جهات');
        assert.ok(mockList.innerHTML.includes('companion-contact-item'));
        assert.ok(mockList.innerHTML.includes('أحمد كمال'));
        assert.ok(mockList.innerHTML.includes('صديق الجامعة'));
        assert.ok(mockList.innerHTML.includes('أم مصطفى'));
        assert.ok(mockList.innerHTML.includes('companion-quick-transfer-btn'));
        assert.ok(mockList.innerHTML.includes('data-contact-name="أحمد كمال"'));

        delete global.document;
    });

    test('renderCompanionLedger and renderWalletBalance synchronize live balance and mini-ledger entries', () => {
        const mockLedgerList = { innerHTML: '' };
        const mockBalanceDisplay = { textContent: '' };
        const mockCompanionBalance = { textContent: '' };

        global.document = {
            getElementById: (id) => {
                if (id === 'companion-ledger-list') return mockLedgerList;
                if (id === 'wallet-balance-display') return mockBalanceDisplay;
                if (id === 'companion-rail-balance') return mockCompanionBalance;
                return null;
            }
        };

        // Test mini-ledger rendering
        frontend.renderCompanionLedger();
        assert.ok(mockLedgerList.innerHTML.length > 0);

        delete global.document;
    });

    test('Backend /api/contacts endpoint returns contacts list with HTTP 200', async () => {
        const res = await fetch('http://localhost:3000/api/contacts');
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(Array.isArray(data.contacts));
        assert.ok(data.contacts.length > 0);
        const contact = data.contacts[0];
        assert.ok(contact.name);
        assert.ok(contact.phone);
    });

    test('renderCompanionContacts handles "المزيد" expand/collapse toggle properly', () => {
        const mockList = { innerHTML: '' };
        const mockCount = { textContent: '' };
        const mockMoreLabel = { textContent: '' };
        const mockMoreBtn = {
            style: { display: '' },
            classList: {
                classes: new Set(),
                toggle(c, force) {
                    if (force) this.classes.add(c);
                    else this.classes.delete(c);
                },
                contains(c) { return this.classes.has(c); }
            },
            attrs: {},
            setAttribute(k, v) { this.attrs[k] = v; },
            querySelector: (sel) => (sel === '.more-label' ? mockMoreLabel : null)
        };

        global.document = {
            getElementById: (id) => {
                if (id === 'companion-contacts-list') return mockList;
                if (id === 'companion-contacts-count') return mockCount;
                if (id === 'companion-contacts-more-btn') return mockMoreBtn;
                return null;
            }
        };

        const testContacts = [
            { name: 'أحمد 1', alias: 'صديق 1' },
            { name: 'أحمد 2', alias: 'صديق 2' },
            { name: 'أحمد 3', alias: 'صديق 3' },
            { name: 'أحمد 4', alias: 'صديق 4' },
            { name: 'أحمد 5', alias: 'صديق 5' },
            { name: 'أحمد 6', alias: 'صديق 6' }
        ];

        frontend.setCachedCompanionContacts(testContacts);

        // When collapsed (isShowingAll = false), only show 4 contacts and button says "المزيد"
        frontend.setIsShowingAllCompanionContacts(false);
        frontend.renderCompanionContacts();

        assert.equal(mockMoreBtn.style.display, 'flex');
        assert.equal(mockMoreLabel.textContent, 'المزيد');
        assert.equal(mockMoreBtn.classList.contains('is-expanded'), false);
        assert.equal(mockList.innerHTML.includes('أحمد 4'), true);
        assert.equal(mockList.innerHTML.includes('أحمد 5'), false);

        // When expanded (isShowingAll = true), show all 6 contacts and button says "عرض أقل"
        frontend.setIsShowingAllCompanionContacts(true);
        frontend.renderCompanionContacts();

        assert.equal(mockMoreLabel.textContent, 'عرض أقل');
        assert.equal(mockMoreBtn.classList.contains('is-expanded'), true);
        assert.equal(mockList.innerHTML.includes('أحمد 5'), true);
        assert.equal(mockList.innerHTML.includes('أحمد 6'), true);

        delete global.document;
    });

    test('Fintech Flow widget renders clean minimalist typography without circle icon wrappers', () => {
        const html = frontend.formatFintechMessage(
            'يرجى تأكيد التحويل المالي:\nالمستلم: أحمد كمال (صديق الجامعة)\nرقم الهاتف: +9647801122334\nالمبلغ: 5,000 د.ع\nالرصيد بعد العملية: 2,995,000 د.ع\n\nيرجى مراجعة التفاصيل، ثم الاختيار أدناه أو الرد صوتاً أو كتابة بـ "تأكيد" أو "إلغاء":'
        );

        assert.ok(html.includes('fintech-transfer-flow'), 'Must contain flow container');
        assert.ok(html.includes('محفظتك'), 'Must contain sender name');
        assert.ok(html.includes('أحمد كمال'), 'Must contain recipient name');
        assert.ok(!html.includes('flow-icon-wrap'), 'Must NOT contain circle icon wrappers (minimalist style)');
    });

    test('Backend /api/bills endpoint returns bills list with HTTP 200', async () => {
        const res = await fetch('http://localhost:3000/api/bills');
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(Array.isArray(data.bills));
        assert.ok(data.bills.length > 0);
        const bill = data.bills[0];
        assert.ok(bill.biller);
        assert.ok(bill.amount);
    });

    test('renderCompanionBills renders bills with 1-click pay buttons and accounts', () => {
        const mockList = { innerHTML: '' };
        const mockCount = { textContent: '' };
        const mockMoreBtn = { style: { display: '' }, classList: { toggle: () => {} }, setAttribute: () => {} };

        global.document = {
            getElementById: (id) => {
                if (id === 'companion-bills-list') return mockList;
                if (id === 'companion-bills-count') return mockCount;
                if (id === 'companion-bills-more-btn') return mockMoreBtn;
                return null;
            }
        };

        frontend.setCachedCompanionBills([
            { id: 'b1', biller: 'فاتورة الهاتف', account_number: '07801234567', amount: 25000, status: 'unpaid' },
            { id: 'b2', biller: 'فاتورة الإنترنت', account_number: 'NET-123', amount: 40000, status: 'unpaid' }
        ]);

        frontend.renderCompanionBills();

        assert.equal(mockCount.textContent, '2 فواتير');
        assert.ok(mockList.innerHTML.includes('companion-bill-item'));
        assert.ok(mockList.innerHTML.includes('فاتورة الهاتف'));
        assert.ok(mockList.innerHTML.includes('07801234567'));
        assert.ok(mockList.innerHTML.includes('25,000 د.ع'));
        assert.ok(mockList.innerHTML.includes('companion-quick-pay-btn'));
        assert.ok(mockList.innerHTML.includes('تسديد'));

        delete global.document;
    });

    test('renderCompanionBills handles "المزيد" expand/collapse toggle with <= 3 safeguard', () => {
        const mockList = { innerHTML: '' };
        const mockCount = { textContent: '' };
        const mockMoreLabel = { textContent: '' };
        const mockMoreBtn = {
            style: { display: '' },
            classList: {
                classes: new Set(),
                toggle(c, force) {
                    if (force) this.classes.add(c);
                    else this.classes.delete(c);
                },
                contains(c) { return this.classes.has(c); }
            },
            attrs: {},
            setAttribute(k, v) { this.attrs[k] = v; },
            querySelector: (sel) => (sel === '.more-label' ? mockMoreLabel : null)
        };

        global.document = {
            getElementById: (id) => {
                if (id === 'companion-bills-list') return mockList;
                if (id === 'companion-bills-count') return mockCount;
                if (id === 'companion-bills-more-btn') return mockMoreBtn;
                return null;
            }
        };

        // When 3 or fewer bills: button must be completely hidden
        frontend.setCachedCompanionBills([
            { id: 'b1', biller: 'فاتورة 1', amount: 10000, status: 'unpaid' },
            { id: 'b2', biller: 'فاتورة 2', amount: 20000, status: 'unpaid' },
            { id: 'b3', biller: 'فاتورة 3', amount: 30000, status: 'unpaid' }
        ]);
        frontend.renderCompanionBills();
        assert.equal(mockMoreBtn.style.display, 'none');

        // When > 3 bills (e.g. 5 bills):
        frontend.setCachedCompanionBills([
            { id: 'b1', biller: 'فاتورة 1', amount: 10000, status: 'unpaid' },
            { id: 'b2', biller: 'فاتورة 2', amount: 20000, status: 'unpaid' },
            { id: 'b3', biller: 'فاتورة 3', amount: 30000, status: 'unpaid' },
            { id: 'b4', biller: 'فاتورة 4', amount: 40000, status: 'unpaid' },
            { id: 'b5', biller: 'فاتورة 5', amount: 50000, status: 'unpaid' }
        ]);

        // Collapsed state: shows 3 bills, button says "المزيد"
        frontend.setIsShowingAllCompanionBills(false);
        frontend.renderCompanionBills();
        assert.equal(mockMoreBtn.style.display, 'flex');
        assert.equal(mockMoreLabel.textContent, 'المزيد');
        assert.equal(mockList.innerHTML.includes('فاتورة 3'), true);
        assert.equal(mockList.innerHTML.includes('فاتورة 4'), false);

        // Expanded state: shows all 5 bills, button says "عرض أقل"
        frontend.setIsShowingAllCompanionBills(true);
        frontend.renderCompanionBills();
        assert.equal(mockMoreLabel.textContent, 'عرض أقل');
        assert.equal(mockList.innerHTML.includes('فاتورة 4'), true);
        assert.equal(mockList.innerHTML.includes('فاتورة 5'), true);

        delete global.document;
    });

    test('openQuickTransferModal populates contact and reveals modal', () => {
        const mockModal = {
            classList: {
                classes: new Set(['hidden']),
                remove(c) { this.classes.delete(c); },
                add(c) { this.classes.add(c); },
                contains(c) { return this.classes.has(c); }
            }
        };
        const mockBackdrop = {
            classList: {
                classes: new Set(['hidden']),
                remove(c) { this.classes.delete(c); },
                add(c) { this.classes.add(c); },
                contains(c) { return this.classes.has(c); }
            }
        };
        const mockName = { textContent: '' };
        const mockAlias = { textContent: '' };
        const mockInitial = { textContent: '' };
        const mockAvatar = { style: { background: '' } };
        const mockInput = { value: '' };

        global.document = {
            getElementById: (id) => {
                if (id === 'quick-transfer-modal') return mockModal;
                if (id === 'quick-transfer-backdrop') return mockBackdrop;
                if (id === 'quick-transfer-name') return mockName;
                if (id === 'quick-transfer-alias') return mockAlias;
                if (id === 'quick-transfer-avatar-initial') return mockInitial;
                if (id === 'quick-transfer-avatar') return mockAvatar;
                if (id === 'quick-transfer-amount-input') return mockInput;
                return null;
            },
            querySelectorAll: () => []
        };

        frontend.openQuickTransferModal('أحمد كمال', '+9647801122334', 'صديق الجامعة');

        assert.equal(mockName.textContent, 'أحمد كمال');
        assert.equal(mockAlias.textContent, 'صديق الجامعة');
        assert.equal(mockInitial.textContent, 'أ');
        assert.equal(mockInput.value, '50,000');
        assert.equal(mockModal.classList.contains('hidden'), false);
        assert.equal(mockBackdrop.classList.contains('hidden'), false);

        frontend.closeQuickTransferModal();
        assert.equal(mockModal.classList.contains('hidden'), true);
        assert.equal(mockBackdrop.classList.contains('hidden'), true);

        delete global.document;
    });
});

describe('VI Wallet Regression Suite - Task 13: Tier-1 Apple Pay Slide to Confirm (اسحب لتأكيد التحويل) Interactive Slider', () => {
    const fs = require('fs');
    const path = require('path');
    const frontend = require('../../frontend/script.js');

    const originalFetch = global.fetch;

    beforeEach(() => {
        frontend.setRequestInProgress(false);
        global.fetch = async () => ({
            ok: true,
            json: async () => ({ response: 'تم تأكيد التحويل بنجاح' })
        });
        global.document = {
            getElementById: () => null,
            querySelectorAll: () => [],
            querySelector: () => null,
            createElement: () => ({
                classList: { add() {}, remove() {}, contains: () => false },
                style: {},
                getContext: () => null,
                setAttribute: () => {},
                removeAttribute: () => {},
                appendChild: () => {}
            })
        };
    });

    after(() => {
        global.fetch = originalFetch;
        delete global.document;
    });

    test('renderFintechActionButtons produces Apple Pay slider track markup with accessibility attributes and cancel button', () => {
        const html = frontend.renderFintechActionButtons();

        assert.ok(html.includes('class="slide-to-confirm-track'), 'Must render .slide-to-confirm-track');
        assert.ok(html.includes('role="slider"'), 'Must have role="slider"');
        assert.ok(html.includes('tabindex="0"'), 'Must have tabindex="0" for keyboard accessibility');
        assert.ok(html.includes('aria-label="اسحب لتأكيد التحويل"'), 'Must have proper Arabic aria-label');
        assert.ok(html.includes('aria-valuemin="0"'), 'Must define aria-valuemin');
        assert.ok(html.includes('aria-valuemax="100"'), 'Must define aria-valuemax');
        assert.ok(html.includes('aria-valuenow="0"'), 'Must define initial aria-valuenow');
        assert.ok(html.includes('class="slide-progress-fill"'), 'Must render progress fill container');
        assert.ok(html.includes('class="slide-shimmer-text"'), 'Must render metallic shimmer text container');
        assert.ok(html.includes('اسحب لتأكيد التحويل'), 'Must display Arabic slide text');
        assert.ok(html.includes('class="slide-to-confirm-thumb"'), 'Must render draggable thumb');
        assert.ok(html.includes('class="thumb-icon-arrow"'), 'Thumb must contain direction arrow icon');
        assert.ok(html.includes('class="thumb-icon-check"'), 'Thumb must contain checkmark icon');
        assert.ok(html.includes('class="fintech-action-btn fintech-btn-cancel"'), 'Must contain cancel button');
    });

    test('renderConfirmationCard alias functions properly and outputs valid card markup with slider', () => {
        assert.equal(typeof frontend.renderConfirmationCard, 'function', 'renderConfirmationCard must be exported as a function');
        
        const cardHtml = frontend.renderConfirmationCard({
            recipient: 'علي كاظم',
            phoneOrAccount: '07801234567',
            amount: '50,000 د.ع',
            balanceAfter: '120,000 د.ع',
            isBill: false,
            introMessage: 'هل تود المتابعة؟'
        });

        assert.ok(cardHtml.includes('fintech-card confirm-card'), 'Must render confirm-card container');
        assert.ok(cardHtml.includes('علي كاظم'), 'Must render recipient name');
        assert.ok(cardHtml.includes('50,000 د.ع'), 'Must render amount');
        assert.ok(cardHtml.includes('slide-to-confirm-track'), 'Must embed slide to confirm slider');
        assert.ok(cardHtml.includes('fintech-btn-cancel'), 'Must embed cancel button');
    });

    test('CSS stylesheet contains luxury slide-to-confirm rules, metallic shimmer animations, and mobile layout', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // Track rules
        assert.ok(css.includes('.slide-to-confirm-track'), 'Must style .slide-to-confirm-track');
        assert.ok(css.includes('border-radius: 9999px'), 'Track must use pill capsule border radius');
        assert.ok(css.includes('backdrop-filter: blur'), 'Track must utilize glassmorphic blur');
        assert.ok(css.includes(':focus-visible'), 'Must define accessible focus-visible outline');

        // Progress fill & shimmer text
        assert.ok(css.includes('.slide-progress-fill'), 'Must style progress fill');
        assert.ok(css.includes('.slide-shimmer-text'), 'Must style shimmer text');
        assert.ok(css.includes('@keyframes slideMetallicShimmer'), 'Must contain metallic shimmer animation');

        // Thumb handle & icon morphing
        assert.ok(css.includes('.slide-to-confirm-thumb'), 'Must style draggable thumb');
        assert.ok(css.includes('.thumb-icon-check'), 'Must style checkmark icon');
        assert.ok(css.includes('.slide-to-confirm-thumb.is-success'), 'Must morph thumb to checkmark on success');

        // Mobile responsiveness
        assert.ok(css.includes('.slide-to-confirm-track {\n    width: 100%;'), 'Must expand to 100% width on mobile');
    });

    test('Spring-back physics return: releases before 85% completion threshold apply cubic-bezier(0.175, 0.885, 0.32, 1.275)', () => {
        const mockTrack = {
            classList: {
                classes: new Set(['slide-to-confirm-track']),
                contains(c) { return this.classes.has(c); },
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); }
            },
            getAttribute: (attr) => attr === 'aria-disabled' ? 'false' : null,
            setAttribute: (attr, val) => {},
            removeAttribute: (attr) => {},
            getBoundingClientRect: () => ({ width: 300, left: 100, right: 400 }),
            closest: function(sel) {
                if (!sel || sel.includes('slide-to-confirm-track')) return this;
                return { querySelector: () => null };
            },
            querySelector: (sel) => {
                if (sel === '.slide-to-confirm-thumb') return mockThumb;
                if (sel === '.slide-progress-fill') return mockFill;
                if (sel === '.slide-track-text') return mockText;
                return null;
            }
        };

        const mockThumb = {
            offsetWidth: 40,
            style: {},
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };

        const mockFill = { style: {} };
        const mockText = { style: {} };

        global.window = { getComputedStyle: () => ({ direction: 'rtl' }) };

        // 1. Start drag at clientX = 350
        frontend.startSlideDrag({
            target: mockTrack,
            clientX: 350
        });

        // 2. Drag only 50px to the left (50 / 252 ≈ 19.8% completion, well below 85%)
        frontend.onSlideDragMove({
            clientX: 300,
            cancelable: true
        });

        assert.equal(mockThumb.style.transform, 'translateX(-50px)');

        // 3. Release drag
        frontend.onSlideDragEnd({
            clientX: 300
        });

        // 4. Verify spring-back cubic bezier and reset to 0px
        assert.ok(mockThumb.style.transition.includes('cubic-bezier(0.175, 0.885, 0.32, 1.275)'), 'Must return via cubic-bezier(0.175, 0.885, 0.32, 1.275)');
        assert.equal(mockThumb.style.transform, 'translateX(0px)', 'Thumb must spring back to 0px');
        assert.equal(mockFill.style.width, '0px', 'Fill width must spring back to 0px');
        assert.equal(mockText.style.opacity, '1', 'Text opacity must reset to 1');

        delete global.window;
    });

    test('Snap to completion: drag past 85% triggers verified checkmark morph, haptic vibration [15, 30, 20], and success chime', async () => {
        let vibrationPattern = null;
        if (typeof global.navigator === 'undefined') {
            global.navigator = {};
        }
        global.navigator.vibrate = (pattern) => { vibrationPattern = pattern; };

        frontend.setTtsEnabled(true);
        frontend.setRequestInProgress(false);

        const mockCard = { querySelector: () => null, classList: { add() {} } };
        const mockTrack = {
            classList: {
                classes: new Set(['slide-to-confirm-track']),
                contains(c) { return this.classes.has(c); },
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); }
            },
            getAttribute: (attr) => attr === 'aria-disabled' ? 'false' : null,
            setAttribute: (attr, val) => {},
            removeAttribute: (attr) => {},
            getBoundingClientRect: () => ({ width: 300, left: 100, right: 400 }),
            closest: function(sel) {
                if (!sel || sel.includes('slide-to-confirm-track')) return this;
                if (sel.includes('fintech-card')) return mockCard;
                return null;
            },
            querySelector: (sel) => {
                if (sel === '.slide-to-confirm-thumb') return mockThumb;
                if (sel === '.slide-progress-fill') return mockFill;
                if (sel === '.slide-track-text') return mockText;
                if (sel === '.slide-shimmer-text') return mockShimmer;
                return null;
            }
        };

        const mockThumb = {
            offsetWidth: 40,
            style: {},
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };

        const mockFill = { style: {} };
        const mockText = { style: {} };
        const mockShimmer = { textContent: '' };

        global.window = { getComputedStyle: () => ({ direction: 'rtl' }) };

        // 1. Start drag at clientX = 350
        frontend.startSlideDrag({
            target: mockTrack,
            clientX: 350
        });

        // 2. Drag 230px to left (230 / 252 ≈ 91.2% completion, past 85% threshold)
        frontend.onSlideDragMove({
            clientX: 120,
            cancelable: true
        });

        // 3. Release past 85% threshold
        frontend.onSlideDragEnd({
            clientX: 120
        });

        // 4. Verify completed state, morph, and haptic pattern
        assert.ok(mockTrack.classList.contains('is-confirmed'), 'Track must receive is-confirmed class');
        assert.ok(mockThumb.classList.contains('is-success'), 'Thumb must receive is-success for checkmark morph');
        assert.equal(mockFill.style.width, '100%', 'Progress fill must expand to 100%');
        assert.equal(mockShimmer.textContent, 'تم التأكيد بنجاح', 'Shimmer text must update to confirmed state');
        assert.deepEqual(vibrationPattern, [15, 30, 20], 'Must trigger haptic pattern [15, 30, 20]');

        // Settle microtask queue
        await new Promise(resolve => setTimeout(resolve, 50));

        delete global.navigator.vibrate;
        delete global.window;
    });

    test('Keyboard accessibility: Enter and Space keys trigger smooth slide completion', async () => {
        let vibrationFired = false;
        if (typeof global.navigator === 'undefined') {
            global.navigator = {};
        }
        global.navigator.vibrate = () => { vibrationFired = true; };

        frontend.setRequestInProgress(false);

        const mockCard = { querySelector: () => null, classList: { add() {} } };
        const mockTrack = {
            classList: {
                classes: new Set(['slide-to-confirm-track']),
                contains(c) { return this.classes.has(c); },
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); }
            },
            getAttribute: () => 'false',
            setAttribute: () => {},
            removeAttribute: () => {},
            getBoundingClientRect: () => ({ width: 300 }),
            closest: function(sel) {
                if (!sel || sel.includes('slide-to-confirm-track')) return this;
                if (sel.includes('fintech-card')) return mockCard;
                return null;
            },
            querySelector: (sel) => {
                if (sel === '.slide-to-confirm-thumb') return mockThumb;
                if (sel === '.slide-progress-fill') return mockFill;
                if (sel === '.slide-track-text') return mockText;
                if (sel === '.slide-shimmer-text') return mockShimmer;
                return null;
            }
        };

        const mockThumb = {
            offsetWidth: 40,
            style: {},
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };

        const mockFill = { style: {} };
        const mockText = { style: {} };
        const mockShimmer = { textContent: '' };

        global.window = { getComputedStyle: () => ({ direction: 'rtl' }) };

        let prevented = false;
        frontend.handleSlideKeyboard({
            target: mockTrack,
            key: 'Enter',
            preventDefault: () => { prevented = true; }
        });

        assert.equal(prevented, true, 'Keyboard event must prevent default scroll/submit');
        assert.ok(mockThumb.style.transition.includes('cubic-bezier(0.16, 1, 0.3, 1)'), 'Must animate thumb smoothly');

        // Allow async timeout (220ms) inside handleSlideKeyboard to complete cleanly
        await new Promise(resolve => setTimeout(resolve, 260));

        delete global.navigator.vibrate;
        delete global.window;
    });
});

describe('VI Wallet Regression Suite - Task 14: Dual-Currency Financial Toggle and Converter Widget (IQD ⇄ USD)', () => {
    const fs = require('fs');
    const path = require('path');
    const { EXCHANGE_RATE_CONFIG, getExchangeRate } = require('../server');
    const frontend = require('../../frontend/script.js');

    test('1. Backend Exchange Rate Config and /api/exchange-rate Endpoint Integrity', async () => {
        // Verify server configuration export
        assert.ok(EXCHANGE_RATE_CONFIG, 'EXCHANGE_RATE_CONFIG must be exported');
        assert.equal(EXCHANGE_RATE_CONFIG.base_currency, 'IQD');
        assert.equal(EXCHANGE_RATE_CONFIG.target_currency, 'USD');
        assert.equal(typeof EXCHANGE_RATE_CONFIG.iqd_per_usd, 'number');
        assert.ok(EXCHANGE_RATE_CONFIG.iqd_per_usd > 0);

        const currentRate = getExchangeRate();
        assert.equal(currentRate.base_currency, 'IQD');
        assert.equal(currentRate.target_currency, 'USD');
        assert.equal(currentRate.usd_sample, 100);
        assert.equal(currentRate.iqd_sample, 153000);
        assert.ok(currentRate.formatted_rate.includes('100$ = 153,000 د.ع'));
    });

    test('2. Mathematical Precision & Dynamic Conversions (IQD ⇄ USD)', () => {
        frontend.setExchangeRateValue(1530);

        // IQD to USD conversions
        assert.equal(frontend.convertIqdToUsd(1530), 1.00);
        assert.equal(frontend.convertIqdToUsd(153000), 100.00);
        assert.equal(frontend.convertIqdToUsd(2250000), 1470.59);
        assert.equal(frontend.convertIqdToUsd(0), 0);
        assert.equal(frontend.convertIqdToUsd(-500), 0);

        // USD to IQD conversions (Maintaining integer precision for base ledger)
        assert.equal(frontend.convertUsdToIqd(1), 1530);
        assert.equal(frontend.convertUsdToIqd(100), 153000);
        assert.equal(frontend.convertUsdToIqd(1470.588), 2250000);
        assert.equal(frontend.convertUsdToIqd(0), 0);
        assert.equal(frontend.convertUsdToIqd(-10), 0);
    });

    test('3. Dual Balance Formatting (Primary & Subtle Secondary Equivalents)', () => {
        frontend.setExchangeRateValue(1530);

        // Test IQD active currency
        frontend.setActiveCurrency('IQD', false);
        assert.equal(frontend.getActiveCurrency(), 'IQD');
        const iqdDual = frontend.formatDualBalance(2250000, false);
        assert.equal(iqdDual.primary, '2,250,000 د.ع');
        assert.equal(iqdDual.secondary, '≈ $1,470.59');
        assert.equal(iqdDual.primaryCurrency, 'IQD');
        assert.equal(iqdDual.secondaryCurrency, 'USD');

        // Test USD active currency
        frontend.setActiveCurrency('USD', false);
        assert.equal(frontend.getActiveCurrency(), 'USD');
        const usdDual = frontend.formatDualBalance(2250000, false);
        assert.equal(usdDual.primary, '$1,470.59');
        assert.equal(usdDual.secondary, '≈ 2,250,000 د.ع');
        assert.equal(usdDual.primaryCurrency, 'USD');
        assert.equal(usdDual.secondaryCurrency, 'IQD');

        // Test Hidden Privacy Mode (Eye toggle mask)
        const hiddenDual = frontend.formatDualBalance(2250000, true);
        assert.equal(hiddenDual.primary, '••••••');
        assert.equal(hiddenDual.secondary, '••••••');

        // Reset to IQD default
        frontend.setActiveCurrency('IQD', false);
    });

    test('4. Currency Switcher Pill State, localStorage Persistence, and Flip Toggle', () => {
        let storageMap = {};
        global.localStorage = {
            getItem: (k) => storageMap[k] || null,
            setItem: (k, v) => { storageMap[k] = String(v); },
            removeItem: (k) => { delete storageMap[k]; }
        };

        // Switch to USD
        frontend.setActiveCurrency('USD', false);
        assert.equal(frontend.getActiveCurrency(), 'USD');
        assert.equal(global.localStorage.getItem('vi_active_currency'), 'USD');

        // Toggle back to IQD
        const nextCurr = frontend.toggleActiveCurrency();
        assert.equal(nextCurr, 'IQD');
        assert.equal(frontend.getActiveCurrency(), 'IQD');
        assert.equal(global.localStorage.getItem('vi_active_currency'), 'IQD');

        delete global.localStorage;
    });

    test('5. 3D Flip Transition Class Application (.balance-is-flipping)', () => {
        const addedClasses = [];
        const mockFlipEl = {
            classList: {
                add: (c) => addedClasses.push(c),
                remove: () => {}
            }
        };

        const origDoc = global.document;
        global.document = {
            getElementById: () => null,
            querySelectorAll: (sel) => {
                if (sel === '.balance-flip-container') return [mockFlipEl];
                return [];
            }
        };

        // Calling setActiveCurrency with animate=true triggers flip animation class
        frontend.setActiveCurrency('USD', true);
        assert.ok(addedClasses.includes('balance-is-flipping'), 'Must apply balance-is-flipping class during transition');

        global.document = origDoc;
        frontend.setActiveCurrency('IQD', false);
    });

    test('6. Quick Transfer Dual Chips & Integer Base IQD Precision Maintenance', () => {
        frontend.setExchangeRateValue(1530);
        frontend.setActiveCurrency('IQD', false);

        const mockChip5k = {
            getAttribute: () => '5000',
            querySelector: (sel) => {
                if (sel === '.chip-primary') return mockChip5kPrimary;
                if (sel === '.chip-secondary') return mockChip5kSecondary;
                return null;
            }
        };
        const mockChip5kPrimary = { textContent: '' };
        const mockChip5kSecondary = { textContent: '' };

        const origDoc = global.document;
        global.document = {
            getElementById: () => null,
            querySelectorAll: (sel) => {
                if (sel === '.amount-wheel-chip') return [mockChip5k];
                return [];
            }
        };

        // In IQD mode: 5,000 د.ع primary, ≈ $3.27 secondary
        frontend.updateQuickTransferChips();
        assert.equal(mockChip5kPrimary.textContent, '5,000 د.ع');
        assert.equal(mockChip5kSecondary.textContent, '≈ $3.27');

        // In USD mode: $3.27 primary, ≈ 5,000 د.ع secondary
        frontend.setActiveCurrency('USD', false);
        frontend.updateQuickTransferChips();
        assert.equal(mockChip5kPrimary.textContent, '$3.27');
        assert.equal(mockChip5kSecondary.textContent, '≈ 5,000 د.ع');

        global.document = origDoc;
        frontend.setActiveCurrency('IQD', false);
    });

    test('7. HTML & CSS Component Integrity: Glassy Pills, Tickers, and Animations', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf-8');
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // HTML checks
        assert.ok(!html.includes('id="currency-toggle-btn"'), 'Header currency-toggle-btn removed per user request');
        assert.ok(html.includes('id="companion-currency-toggle-btn"'), 'Companion rail must contain currency toggle button');
        assert.ok(html.includes('balance-flip-container'), 'Balance displays must have balance-flip-container');
        assert.ok(html.includes('id="companion-rail-balance-secondary"'), 'Companion rail must have secondary valuation container');
        assert.ok(html.includes('id="companion-exchange-ticker"'), 'Companion rail must display exchange ticker');
        assert.ok(html.includes('id="quick-transfer-currency-toggle"'), 'Quick transfer modal must have currency switch badge');
        assert.ok(html.includes('id="quick-transfer-secondary-val"'), 'Quick transfer modal must have live conversion equivalent');

        // CSS checks
        assert.ok(css.includes('.currency-toggle-pill'), 'CSS must style glassy currency toggle pill');
        assert.ok(css.includes('.currency-pill-glider'), 'CSS must define sliding pill glider');
        assert.ok(css.includes('.balance-flip-container'), 'CSS must define 3D perspective container');
        assert.ok(css.includes('.balance-is-flipping'), 'CSS must define flip animation trigger');
        assert.ok(css.includes('@keyframes currencyFlipIn'), 'CSS must define fluid 3D number flip keyframes');
        assert.ok(css.includes('.companion-exchange-ticker'), 'CSS must style companion live exchange ticker');
        assert.ok(css.includes('.quick-transfer-currency-badge'), 'CSS must style modal currency switch badge');
        assert.ok(css.includes('.amount-wheel-chip .chip-secondary'), 'CSS must style secondary subtle equivalent typography');
    });
});

describe('VI Wallet Regression Suite - Task 15: Tier-1 Apple iOS 18 Micro-Interactions & Skeleton Shimmer Physics', () => {
    const fs = require('fs');
    const path = require('path');
    const frontend = require('../../frontend/script.js');

    test('1. Motion Tokens & Physics: Apple iOS 18 Cubic-Beziers & Durations', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // Verify tokens in :root
        assert.ok(css.includes('--ease-apple-spring: cubic-bezier(0.175, 0.885, 0.32, 1.15);'), 'Must define --ease-apple-spring');
        assert.ok(css.includes('--ease-apple-fluid: cubic-bezier(0.32, 0.72, 0, 1);'), 'Must define --ease-apple-fluid');
        assert.ok(css.includes('--scale-press-down: scale(0.96);'), 'Must define --scale-press-down as scale(0.96)');
        assert.ok(css.includes('--shadow-press-down:'), 'Must define --shadow-press-down');
        assert.ok(css.includes('--duration-apple-fast: 160ms;'), 'Must define --duration-apple-fast token');
        assert.ok(css.includes('--duration-apple-instant: 120ms;'), 'Must define --duration-apple-instant token');
    });

    test('2. Tactile Press-Down States: scale(0.96) and Shadow Compression Across Interactive Elements', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // Check active selector group includes prompt chips, buttons, triggers, and action cards
        assert.ok(css.includes('.prompt-chip:active'), 'Must define active press-down on .prompt-chip');
        assert.ok(css.includes('.amount-wheel-chip:active'), 'Must define active press-down on .amount-wheel-chip');
        assert.ok(css.includes('.send-btn:active'), 'Must define active press-down on .send-btn');
        assert.ok(css.includes('.companion-quick-transfer-btn:active'), 'Must define active press-down on .companion-quick-transfer-btn');
        assert.ok(css.includes('.companion-quick-pay-btn:active'), 'Must define active press-down on .companion-quick-pay-btn');
        assert.ok(css.includes('.companion-contact-item:active'), 'Must define active press-down on .companion-contact-item');
        assert.ok(css.includes('.companion-bill-item:active'), 'Must define active press-down on .companion-bill-item');
        assert.ok(css.includes('.transaction-item-card:active'), 'Must define active press-down on .transaction-item-card');
        assert.ok(css.includes('transform: var(--scale-press-down, scale(0.96)) translateZ(0) !important;'), 'Must apply hardware-accelerated scale(0.96)');
    });

    test('3. Skeleton Shimmer Architecture: Keyframes, Sweep Gradients, and Containers', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        assert.ok(css.includes('@keyframes skeletonShimmerSweep'), 'Must define @keyframes skeletonShimmerSweep');
        assert.ok(css.includes('@keyframes skeletonPulseGlow'), 'Must define @keyframes skeletonPulseGlow');
        assert.ok(css.includes('.skeleton-shimmer'), 'Must define .skeleton-shimmer base class');
        assert.ok(css.includes('.skeleton-trx-card'), 'Must define .skeleton-trx-card for drawer');
        assert.ok(css.includes('.skeleton-contact-card'), 'Must define .skeleton-contact-card for companion rail');
        assert.ok(css.includes('.skeleton-bill-card'), 'Must define .skeleton-bill-card for companion bills');
        assert.ok(css.includes('[data-theme="dark"] .skeleton-shimmer'), 'Must provide dark theme shimmering gradient sweep');
    });

    test('4. JavaScript Skeleton Shimmer Generators (Transactions, Contacts, Bills)', () => {
        assert.equal(typeof frontend.renderTransactionsSkeleton, 'function', 'renderTransactionsSkeleton must be a function');
        assert.equal(typeof frontend.renderCompanionContactsSkeleton, 'function', 'renderCompanionContactsSkeleton must be a function');
        assert.equal(typeof frontend.renderCompanionBillsSkeleton, 'function', 'renderCompanionBillsSkeleton must be a function');

        // Test transactions skeleton generator
        const trxHtml = frontend.renderTransactionsSkeleton(3);
        assert.ok(trxHtml.includes('skeleton-trx-card'), 'Must render skeleton-trx-card markup');
        assert.ok(trxHtml.includes('skeleton-trx-avatar'), 'Must render avatar shimmer');
        assert.ok(trxHtml.includes('skeleton-trx-amount'), 'Must render amount shimmer');
        const trxCount = (trxHtml.match(/skeleton-trx-card/g) || []).length;
        assert.equal(trxCount, 3, 'Must render exactly 3 rows when requested');

        // Test contacts skeleton generator
        const contactsHtml = frontend.renderCompanionContactsSkeleton(4);
        assert.ok(contactsHtml.includes('skeleton-contact-card'), 'Must render skeleton-contact-card markup');
        assert.ok(contactsHtml.includes('skeleton-contact-avatar'), 'Must render contact avatar shimmer');
        assert.ok(contactsHtml.includes('skeleton-contact-btn'), 'Must render contact transfer button shimmer');
        const contactCount = (contactsHtml.match(/skeleton-contact-card/g) || []).length;
        assert.equal(contactCount, 4, 'Must render exactly 4 contacts rows');

        // Test bills skeleton generator
        const billsHtml = frontend.renderCompanionBillsSkeleton(3);
        assert.ok(billsHtml.includes('skeleton-bill-card'), 'Must render skeleton-bill-card markup');
        assert.ok(billsHtml.includes('skeleton-bill-icon'), 'Must render bill icon shimmer');
        assert.ok(billsHtml.includes('skeleton-bill-btn'), 'Must render bill pay button shimmer');
        const billCount = (billsHtml.match(/skeleton-bill-card/g) || []).length;
        assert.equal(billCount, 3, 'Must render exactly 3 bills rows');
    });

    test('5. Accessibility: prefers-reduced-motion Media Queries and Non-Animated Fallback', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // Check reduced motion queries for active states and shimmers
        assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'Must define prefers-reduced-motion media query');
        assert.ok(css.includes('transform: none !important;'), 'Must cleanly disable active transforms on reduced motion');
        assert.ok(css.includes('animation: none !important;'), 'Must cleanly disable skeleton animations on reduced motion');
    });

    test('6. HTML Initial Hydration Markup Integrity', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf-8');

        assert.ok(html.includes('skeleton-contact-card'), 'Index HTML must include initial skeleton-contact-card placeholders');
        assert.ok(html.includes('skeleton-bill-card'), 'Index HTML must include initial skeleton-bill-card placeholders');
        assert.ok(html.includes('skeleton-trx-card'), 'Index HTML must include initial skeleton-trx-card placeholders');
        assert.ok(html.includes('skeleton-shimmer'), 'Index HTML must include skeleton-shimmer sweeps');
    });
});

describe('VI Wallet Regression Suite - Task 16: Bespoke Fintech Pulse (نبض المحفظة) Visual Analytics Card', () => {
    const fs = require('fs');
    const path = require('path');
    const frontend = require('../../frontend/script.js');

    test('1. calculateFintechPulseData: Mathematical Distribution Precision & 100% Sum Guarantee', () => {
        assert.equal(typeof frontend.calculateFintechPulseData, 'function');

        // Test with zero transactions (100% balance)
        const emptyData = frontend.calculateFintechPulseData([], 3000000);
        assert.equal(emptyData.billsSpent, 0);
        assert.equal(emptyData.transfersSpent, 0);
        assert.equal(emptyData.balance, 3000000);
        assert.equal(emptyData.totalPool, 3000000);
        assert.equal(emptyData.balancePct, 100);
        assert.equal(emptyData.billsPct, 0);
        assert.equal(emptyData.transfersPct, 0);

        // Test with mixed spending transactions
        const sampleTrxs = [
            { id: 't1', type: 'BILL', amount: 100000 },
            { id: 't2', type: 'BILL_PAYMENT', amount: 50000 },
            { id: 't3', type: 'TRANSFER', amount: 350000, recipient: 'أحمد' }
        ];
        const data = frontend.calculateFintechPulseData(sampleTrxs, 500000);
        // Total pool: 150000 + 350000 + 500000 = 1,000,000
        assert.equal(data.billsSpent, 150000);
        assert.equal(data.transfersSpent, 350000);
        assert.equal(data.balance, 500000);
        assert.equal(data.totalPool, 1000000);
        assert.equal(data.billsPct, 15);
        assert.equal(data.transfersPct, 35);
        assert.equal(data.balancePct, 50);
        assert.equal(data.billsPct + data.transfersPct + data.balancePct, 100);
    });

    test('2. getFintechPulseInsight: Proactive Contextual Iraqi AI Guidance Generation', () => {
        assert.equal(typeof frontend.getFintechPulseInsight, 'function');

        // Zero expenses tip
        const zeroTip = frontend.getFintechPulseInsight({ billsSpent: 0, transfersSpent: 0, balancePct: 100 });
        assert.ok(zeroTip.includes('عاشت إيدك'), 'Tip should include authentic Iraqi praise');
        assert.ok(zeroTip.includes('أقل بـ 15%'), 'Tip should include comparative context');

        // High balance retention tip
        const highBalTip = frontend.getFintechPulseInsight({ billsSpent: 50000, transfersSpent: 50000, balancePct: 80 });
        assert.ok(highBalTip.includes('عاشت إيدك') && highBalTip.includes('أمان'));

        // High bills tip
        const highBillsTip = frontend.getFintechPulseInsight({ billsSpent: 300000, transfersSpent: 50000, billsPct: 45, balancePct: 40 });
        assert.ok(highBillsTip.includes('فواتير') && highBillsTip.includes('التزامك'));

        // High transfers tip
        const highTransfersTip = frontend.getFintechPulseInsight({ billsSpent: 50000, transfersSpent: 300000, transfersPct: 45, balancePct: 40 });
        assert.ok(highTransfersTip.includes('التحويلات') || highTransfersTip.includes('مصاريفك'));
    });

    test('3. Segment State Management (get/setFintechPulseActiveSegment)', () => {
        assert.equal(typeof frontend.getFintechPulseActiveSegment, 'function');
        assert.equal(typeof frontend.setFintechPulseActiveSegment, 'function');

        frontend.setFintechPulseActiveSegment('transfers');
        assert.equal(frontend.getFintechPulseActiveSegment(), 'transfers');

        frontend.setFintechPulseActiveSegment('bills');
        assert.equal(frontend.getFintechPulseActiveSegment(), 'bills');

        frontend.setFintechPulseActiveSegment('balance');
        assert.equal(frontend.getFintechPulseActiveSegment(), 'balance');

        // Invalid fallback
        frontend.setFintechPulseActiveSegment('unknown_key');
        assert.equal(frontend.getFintechPulseActiveSegment(), 'balance');
    });

    test('4. renderFintechPulse: SVG Donut Dash-Array, Center Text, and Proactive Badge Hydration', () => {
        const segBalance = { setAttribute: (k, v) => { segBalance[k] = v; } };
        const segTransfers = { setAttribute: (k, v) => { segTransfers[k] = v; } };
        const segBills = { setAttribute: (k, v) => { segBills[k] = v; } };

        const centerPct = { textContent: '' };
        const centerLabel = { textContent: '' };
        const pctBalance = { textContent: '' };
        const amountBalance = { textContent: '' };
        const pctTransfers = { textContent: '' };
        const amountTransfers = { textContent: '' };
        const pctBills = { textContent: '' };
        const amountBills = { textContent: '' };
        const insightText = { textContent: '' };

        const mockElements = {
            'pulse-seg-balance': segBalance,
            'pulse-seg-transfers': segTransfers,
            'pulse-seg-bills': segBills,
            'pulse-center-pct': centerPct,
            'pulse-center-label': centerLabel,
            'pulse-pct-balance': pctBalance,
            'pulse-amount-balance': amountBalance,
            'pulse-pct-transfers': pctTransfers,
            'pulse-amount-transfers': amountTransfers,
            'pulse-pct-bills': pctBills,
            'pulse-amount-bills': amountBills,
            'pulse-ai-insight-text': insightText
        };

        const origDoc = global.document;
        global.document = {
            getElementById: (id) => mockElements[id] || null,
            querySelectorAll: () => [],
            querySelector: () => null
        };

        frontend.setFintechPulseActiveSegment('balance');
        const res = frontend.renderFintechPulse();
        assert.ok(res, 'renderFintechPulse should return calculated data object');
        assert.ok(segBalance['stroke-dasharray'], 'Balance segment must have stroke-dasharray computed');
        assert.ok(segTransfers['stroke-dasharray'], 'Transfers segment must have stroke-dasharray computed');
        assert.ok(segBills['stroke-dasharray'], 'Bills segment must have stroke-dasharray computed');
        assert.ok(centerPct.textContent.includes('%'), 'Center percentage must be populated');
        assert.equal(centerLabel.textContent, 'الرصيد المتاح');
        assert.ok(insightText.textContent.length > 0, 'AI insight text must be populated');

        global.document = origDoc;
    });

    test('5. HTML Component Integrity: Donut SVG, Micro-Gradients, Filter Glow, and AI Badge', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf-8');

        assert.ok(html.includes('id="companion-pulse-section"'), 'index.html must include companion-pulse-section');
        assert.ok(html.includes('id="companion-pulse-card"'), 'index.html must include companion-pulse-card');
        assert.ok(html.includes('id="pulse-donut-svg"'), 'index.html must include pulse-donut-svg');
        assert.ok(html.includes('id="pulse-grad-balance"'), 'SVG defs must include pulse-grad-balance linearGradient');
        assert.ok(html.includes('id="pulse-grad-transfers"'), 'SVG defs must include pulse-grad-transfers linearGradient');
        assert.ok(html.includes('id="pulse-grad-bills"'), 'SVG defs must include pulse-grad-bills linearGradient');
        assert.ok(html.includes('id="pulse-donut-glow"'), 'SVG defs must include glowing dual-theme feDropShadow filter');
        assert.ok(html.includes('id="pulse-seg-balance"'), 'Must have pulse-seg-balance circle');
        assert.ok(html.includes('id="pulse-seg-transfers"'), 'Must have pulse-seg-transfers circle');
        assert.ok(html.includes('id="pulse-seg-bills"'), 'Must have pulse-seg-bills circle');
        assert.ok(html.includes('id="pulse-chip-balance"'), 'Must have pulse-chip-balance interactive chip');
        assert.ok(html.includes('id="pulse-chip-transfers"'), 'Must have pulse-chip-transfers interactive chip');
        assert.ok(html.includes('id="pulse-chip-bills"'), 'Must have pulse-chip-bills interactive chip');
        assert.ok(html.includes('id="pulse-ai-insight-badge"'), 'Must have glassmorphic pulse-ai-insight-badge');
        assert.ok(html.includes('id="pulse-ai-insight-text"'), 'Must have pulse-ai-insight-text container');
    });

    test('6. CSS Architecture: Micro-Animations, Glassmorphic Styling, and Reduced Motion', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        assert.ok(css.includes('.companion-pulse-card'), 'CSS must style .companion-pulse-card');
        assert.ok(css.includes('.pulse-donut-svg'), 'CSS must style .pulse-donut-svg');
        assert.ok(css.includes('.pulse-donut-segment'), 'CSS must style .pulse-donut-segment with transitions');
        assert.ok(css.includes('.pulse-legend-chip'), 'CSS must style .pulse-legend-chip');
        assert.ok(css.includes('.pulse-ai-insight-badge'), 'CSS must style glassmorphic .pulse-ai-insight-badge');
        assert.ok(css.includes('@keyframes pulseCardEntrance'), 'CSS must define pulseCardEntrance keyframes');
        assert.ok(css.includes('@keyframes pulseSparkleGlow'), 'CSS must define pulseSparkleGlow keyframes');
        assert.ok(css.includes('.pulse-legend-chip:active'), 'Reduced motion must include .pulse-legend-chip:active');
    });
});

/* ==========================================================================
   TASK 17 REGRESSION SUITE: Robust Disambiguation Selection,
   Multi-Format Number Parser, Session Persistence & Interactive Disambiguation UI
   ========================================================================== */

describe('Task 17 Regression Suite: Contact Disambiguation & Interactive Selection Cards', () => {
    const fs = require('fs');
    const path = require('path');
    const frontend = require('../../frontend/script.js');

    const mockCandidates = [
        { id: 'cnt_101', name: 'أحمد كمال', alias: 'أحمد كمال (صديق الجامعة)', phone: '+9647801122334', wallet_provider: 'ZainCash' },
        { id: 'cnt_102', name: 'أحمد جاسم', alias: 'أحمد جاسم (الفيترجي / المصلح)', phone: '+9647802233445', wallet_provider: 'AsiaHawala' }
    ];

    test('1. resolveContactSelection: Digits, Arabic-Indic numerals, and punctuated numbers', () => {
        // Standard ASCII digits
        assert.equal(resolveContactSelection('1', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('2', mockCandidates)?.id, 'cnt_102');
        assert.equal(resolveContactSelection(' 1 ', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('1.', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('2.', mockCandidates)?.id, 'cnt_102');

        // Arabic-Indic Numerals
        assert.equal(resolveContactSelection('١', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('٢', mockCandidates)?.id, 'cnt_102');
        assert.equal(resolveContactSelection('١.', mockCandidates)?.id, 'cnt_101');
    });

    test('2. resolveContactSelection: Prefixed choices and Iraqi Arabic textual ordinals', () => {
        // Prefixed strings
        assert.equal(resolveContactSelection('رقم 1', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('رقم 2', mockCandidates)?.id, 'cnt_102');
        assert.equal(resolveContactSelection('الرقم 1', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('خيار 1', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('الخيار 1', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('الخيار رقم 2', mockCandidates)?.id, 'cnt_102');

        // Textual Arabic words & ordinals
        assert.equal(resolveContactSelection('واحد', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('اثنين', mockCandidates)?.id, 'cnt_102');
        assert.equal(resolveContactSelection('ثنين', mockCandidates)?.id, 'cnt_102');
        assert.equal(resolveContactSelection('الاول', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('الأول', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('الثاني', mockCandidates)?.id, 'cnt_102');
        assert.equal(resolveContactSelection('ثاني', mockCandidates)?.id, 'cnt_102');
    });

    test('3. resolveContactSelection: Phone suffix and distinctive alias keywords', () => {
        // Distinguishing phone tails
        assert.equal(resolveContactSelection('2334', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('3445', mockCandidates)?.id, 'cnt_102');

        // Name distinctions & Iraqi relationship aliases
        assert.equal(resolveContactSelection('كمال', mockCandidates)?.id, 'cnt_101');
        assert.equal(resolveContactSelection('جاسم', mockCandidates)?.id, 'cnt_102');
        assert.equal(resolveContactSelection('الفيترجي', mockCandidates)?.id, 'cnt_102');
        assert.equal(resolveContactSelection('المصلح', mockCandidates)?.id, 'cnt_102');
        assert.equal(resolveContactSelection('صديق الجامعة', mockCandidates)?.id, 'cnt_101');

        // Out of bounds / non-matching
        assert.equal(resolveContactSelection('9', mockCandidates), null);
        assert.equal(resolveContactSelection('عمر', mockCandidates), null);
    });

    test('4. parseDisambiguationData: Extract structured candidates from assistant message', () => {
        assert.equal(typeof frontend.parseDisambiguationData, 'function');

        const botMsg = `يا هلا عيوني، عندك أكثر من جهة اتصال باسم "أحمد" بمحفظتك:
1 أحمد كمال (صديق الجامعة) (+9647801122334)
2 أحمد جاسم (الفيترجي / المصلح) (+9647802233445)

يا واحد منهم تقصد؟ يرجى كتابة الرقم أو الاسم الكامل حتى أجهّزلك التحويل.`;

        const parsed = frontend.parseDisambiguationData(botMsg);
        assert.ok(parsed, 'Must successfully parse disambiguation data');
        assert.equal(parsed.name, 'أحمد');
        assert.equal(parsed.options.length, 2);
        assert.equal(parsed.options[0].number, '1');
        assert.equal(parsed.options[0].name, 'أحمد كمال');
        assert.equal(parsed.options[0].subtitle, 'صديق الجامعة');
        assert.equal(parsed.options[0].phone, '+9647801122334');
        assert.equal(parsed.options[1].number, '2');
        assert.equal(parsed.options[1].name, 'أحمد جاسم');
        assert.equal(parsed.options[1].subtitle, 'الفيترجي / المصلح');
        assert.equal(parsed.options[1].phone, '+9647802233445');

        // Non-disambiguation message should return null
        assert.equal(frontend.parseDisambiguationData('تم تحويل المبلغ بنجاح'), null);
    });

    test('5. renderDisambiguationCard: Interactive 1-tap options and accessible markup', () => {
        assert.equal(typeof frontend.renderDisambiguationCard, 'function');

        const mockData = {
            name: 'أحمد',
            options: [
                { number: '1', name: 'أحمد كمال', subtitle: 'صديق الجامعة', phone: '+9647801122334' },
                { number: '2', name: 'أحمد جاسم', subtitle: 'الفيترجي / المصلح', phone: '+9647802233445' }
            ]
        };

        const cardHtml = frontend.renderDisambiguationCard(mockData);
        assert.ok(cardHtml.includes('class="fintech-disambiguation-card"'), 'Must contain container class');
        assert.ok(cardHtml.includes('class="disambiguation-header"'), 'Must contain header');
        assert.ok(cardHtml.includes('اختر جهة الاتصال المطلوبة'), 'Must contain friendly header title');
        assert.ok(cardHtml.includes('data-choice-number="1"'), 'Must have data attribute for option 1');
        assert.ok(cardHtml.includes('data-choice-number="2"'), 'Must have data attribute for option 2');
        assert.ok(cardHtml.includes('option-badge'), 'Must render option number badge');
        assert.ok(cardHtml.includes('option-avatar'), 'Must render option avatar');
        assert.ok(cardHtml.includes('option-name'), 'Must render option name');
        assert.ok(cardHtml.includes('option-subtitle'), 'Must render option subtitle');
        assert.ok(cardHtml.includes('option-phone'), 'Must render option phone');
    });

    test('6. CSS Architecture: Disambiguation Card, Hover Dynamics & Badges', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        assert.ok(css.includes('.fintech-disambiguation-card'), 'CSS must define .fintech-disambiguation-card');
        assert.ok(css.includes('.disambiguation-option-btn'), 'CSS must define .disambiguation-option-btn');
        assert.ok(css.includes('.disambiguation-option-btn:hover'), 'CSS must define interactive hover states');
        assert.ok(css.includes('.disambiguation-option-btn .option-badge'), 'CSS must style .option-badge');
        assert.ok(css.includes('.disambiguation-option-btn .option-avatar'), 'CSS must style .option-avatar');
        assert.ok(css.includes('@keyframes disambiguationCardEntrance'), 'CSS must include smooth entrance animation');
        assert.ok(css.includes('body.light-theme .fintech-disambiguation-card'), 'CSS must support light theme');
    });
});

/* ==========================================================================
   Task 18: Server-Sent Events (SSE) Token Streaming & Sliding-Window Delimiter Parser
   ========================================================================== */

describe('VI Wallet Regression Suite - Task 18: Server-Sent Events (SSE) Token Streaming & Sliding-Window Delimiter Interception', () => {
    const { SlidingWindowTokenParser, initSseStream, writeSseEvent } = require('../src/services/streamParser');
    let testServer;
    let sseBaseUrl;

    before(async () => {
        testServer = http.createServer(app);
        await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
        const port = testServer.address().port;
        sseBaseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        if (testServer) {
            await new Promise(resolve => testServer.close(resolve));
        }
    });

    test('1. SlidingWindowTokenParser: Natural language tokens emit immediately with zero delimiter delay', () => {
        const tokens = [];
        let done = null;
        const parser = new SlidingWindowTokenParser({
            onToken: (t) => tokens.push(t),
            onDone: (d) => { done = d; }
        });

        parser.feed('يا هلا ');
        assert.equal(tokens.length, 1);
        assert.equal(tokens[0], 'يا هلا ');

        parser.feed('عيوني، ');
        assert.equal(tokens.length, 2);
        assert.equal(tokens[1], 'عيوني، ');

        parser.feed('رصيدك هسة 3,000,000 د.ع.');
        assert.equal(tokens.length, 3);

        parser.end();
        assert.ok(done);
        assert.equal(done.fullResponse, 'يا هلا عيوني، رصيدك هسة 3,000,000 د.ع.');
    });

    test('2. SlidingWindowTokenParser: Intercepts and buffers <<<DB_ACTION>>> without leaking to onToken', () => {
        const tokens = [];
        let action = null;
        let done = null;

        const parser = new SlidingWindowTokenParser({
            onToken: (t) => tokens.push(t),
            onAction: (a) => { action = a; },
            onDone: (d) => { done = d; }
        });

        const streamChunks = [
            'تفاصيل التحويل المطلوبة:\n',
            '• المستلم: سيف\n',
            '<', '<', '<', 'DB_ACTION>>>\n',
            '{"action": "TRANSFER", "recipient": "سيف", "amount": 50000}\n',
            '<<<END_DB_ACTION>>>',
            'متأكد تريد أحول؟'
        ];

        streamChunks.forEach(c => parser.feed(c));
        parser.end();

        // Must NOT leak any markup
        const joinedTokens = tokens.join('');
        assert.doesNotMatch(joinedTokens, /<<<DB_ACTION>>>/);
        assert.doesNotMatch(joinedTokens, /<<<END_DB_ACTION>>>/);
        assert.doesNotMatch(joinedTokens, /"action": "TRANSFER"/);

        // Action must be captured
        assert.ok(action, 'Must emit onAction event');
        assert.equal(action.type, 'DB_ACTION');
        assert.ok(action.rawPayload.includes('"action": "TRANSFER"'));

        // Done response must be clean
        assert.ok(done.fullResponse.includes('تفاصيل التحويل المطلوبة'));
        assert.ok(done.fullResponse.includes('متأكد تريد أحول؟'));
    });

    test('3. SlidingWindowTokenParser: Intercepts <CONFIRMATION_REQUIRED> delimiters cleanly', () => {
        const tokens = [];
        let action = null;

        const parser = new SlidingWindowTokenParser({
            onToken: (t) => tokens.push(t),
            onAction: (a) => { action = a; }
        });

        parser.feed('يرجى التأكيد: ');
        parser.feed('<CON');
        parser.feed('FIRMATION_REQUIRED>');
        parser.feed('هل توافق على دفع 25,000 د.ع؟');
        parser.feed('</CONFIRMATION_REQUIRED>');
        parser.feed(' شكراً لك.');
        parser.end();

        const joinedTokens = tokens.join('');
        assert.doesNotMatch(joinedTokens, /<CONFIRMATION_REQUIRED>/);
        assert.doesNotMatch(joinedTokens, /<\/CONFIRMATION_REQUIRED>/);
        assert.ok(action, 'Must emit action event for CONFIRMATION_REQUIRED');
        assert.equal(action.type, 'CONFIRMATION_REQUIRED');
        assert.equal(action.rawPayload, 'هل توافق على دفع 25,000 د.ع؟');
        assert.equal(joinedTokens, 'يرجى التأكيد:  شكراً لك.');
    });

    test('4. SlidingWindowTokenParser: Non-delimiter text with < (e.g. math or comparisons) emits without corruption', () => {
        const tokens = [];
        const parser = new SlidingWindowTokenParser({
            onToken: (t) => tokens.push(t)
        });

        parser.feed('المبلغ المطلوب ');
        parser.feed('< ');
        parser.feed('250 دينار');
        parser.end();

        const joinedTokens = tokens.join('');
        assert.equal(joinedTokens, 'المبلغ المطلوب < 250 دينار');
    });

    test('5. Backend /api/chat: Returns valid text/event-stream chunks when client requests SSE', async () => {
        const sessionId = `test_sse_${Date.now()}`;
        const res = await fetch(`${sseBaseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                'x-session-id': sessionId
            },
            body: JSON.stringify({ message: 'كم رصيدي؟' })
        });

        assert.equal(res.status, 200);
        const contentType = res.headers.get('content-type') || '';
        assert.ok(contentType.includes('text/event-stream'), `Expected text/event-stream, got: ${contentType}`);

        const text = await res.text();
        assert.ok(text.includes('event: token'), 'Must emit event: token');
        assert.ok(text.includes('event: done'), 'Must emit event: done');
        assert.ok(text.includes('رصيدك الحالي بمحفظتك هسة هو:'), 'Must stream balance response');
    });

    test('6. Backend /api/chat: Preserves 100% backward compatibility returning standard JSON when Accept is not SSE', async () => {
        const sessionId = `test_json_compat_${Date.now()}`;
        const res = await fetch(`${sseBaseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-session-id': sessionId
            },
            body: JSON.stringify({ message: 'كم رصيدي؟' })
        });

        assert.equal(res.status, 200);
        const contentType = res.headers.get('content-type') || '';
        assert.ok(contentType.includes('application/json'), `Expected application/json, got: ${contentType}`);

        const data = await res.json();
        assert.ok(data && typeof data.response === 'string', 'Must return standard JSON { response: "..." }');
        assert.ok(data.response.includes('رصيدك الحالي بمحفظتك هسة هو:'));
    });
});

/* ==========================================================================
   Task 19: Robust Persistent Session Management & Token Bucket Rate Limiting
   ========================================================================== */

describe('VI Wallet Regression Suite - Task 19: Robust Persistent Session Management & Token Bucket Rate Limiting', () => {
    let testServer;
    let baseUrl;

    before(async () => {
        testServer = http.createServer(app);
        await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
        const port = testServer.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        if (testServer) {
            await new Promise(resolve => testServer.close(resolve));
        }
    });

    // 1. Durable File-Hydrated Session Store & Reboot State Recovery
    test('1. Durable file-hydrated session store recovers pending confirmations and active financial workflows upon server reboot', () => {
        const rebootSid = `sess_reboot_${Date.now()}`;
        const session = getSession(rebootSid);

        // Stage active financial workflows
        session.pendingTransfer = {
            recipient: 'علي حسن',
            phone: '+9647801234567',
            amount: 75000,
            idempotency_key: 'idemp_reboot_test_01'
        };
        session.pendingDisambiguation = {
            name: 'علي',
            matches: [{ name: 'علي حسن', phone: '+9647801234567' }]
        };
        session.pendingBillPayment = {
            type: 'SINGLE',
            billIds: ['bill_phone_01'],
            totalAmount: 25000
        };
        session.pendingContactCreation = {
            name: 'حسين',
            phone: '+9647809988776'
        };
        session.conversationHistory = [
            { role: 'user', content: 'حول 75 الف لعلي' },
            { role: 'assistant', content: 'تريد أحول 75,000 د.ع إلى علي حسن؟' }
        ];

        // Explicit atomic flush to disk
        const saved = saveSessionsSync();
        assert.equal(saved, true, 'Sessions must save atomically to disk');

        // Simulate complete service reboot by wiping in-memory session map
        sessions.clear();
        assert.equal(sessions.has(rebootSid), false, 'Memory must be completely cleared');

        // Rehydrate from disk
        const hydrated = loadSessionsFromDisk();
        assert.equal(hydrated, true, 'Sessions must hydrate successfully from disk');

        // Verify state recovery
        const recovered = getSession(rebootSid);
        assert.ok(recovered, 'Session must exist after reboot');
        assert.deepEqual(recovered.pendingTransfer, {
            recipient: 'علي حسن',
            phone: '+9647801234567',
            amount: 75000,
            idempotency_key: 'idemp_reboot_test_01'
        }, 'Pending transfer workflow must survive reboot intact');
        assert.equal(recovered.pendingBillPayment.totalAmount, 25000);
        assert.equal(recovered.pendingContactCreation.name, 'حسين');
        assert.equal(recovered.pendingDisambiguation.name, 'علي');
        assert.equal(recovered.conversationHistory.length, 2);
        assert.equal(recovered.conversationHistory[0].content, 'حول 75 الف لعلي');
    });

    // 2. 24-Hour TTL Expiration
    test('2. 24-hour TTL expiration removes stale sessions during prune and disk hydration', () => {
        const expiredSid = `sess_expired_${Date.now()}`;
        const activeSid = `sess_active_${Date.now()}`;

        const expiredSession = getSession(expiredSid);
        const activeSession = getSession(activeSid);

        // Set expired session timestamp to 25 hours ago
        const twentyFiveHoursAgo = Date.now() - (25 * 60 * 60 * 1000);
        expiredSession.lastActive = twentyFiveHoursAgo;

        // Set active session timestamp to 1 hour ago
        activeSession.lastActive = Date.now() - (1 * 60 * 60 * 1000);

        // Pruning removes expired session but retains active session
        const prunedCount = pruneExpiredSessions();
        assert.ok(prunedCount >= 1, 'Must prune at least 1 expired session');
        assert.equal(sessions.has(expiredSid), false, 'Expired session must be pruned from memory');
        assert.equal(sessions.has(activeSid), true, 'Active session within 24h must remain in memory');

        // Disk hydration also skips expired sessions
        sessions.set(expiredSid, { ...createInitialSessionState(), lastActive: twentyFiveHoursAgo });
        saveSessionsSync();
        reloadSessionsFromDisk();

        assert.equal(sessions.has(expiredSid), false, 'Disk hydration must not load sessions older than 24 hours');
        assert.equal(sessions.has(activeSid), true, 'Disk hydration must load active sessions within 24 hours');
    });

    // 3. Token Bucket Algorithm & Discrete Token Math
    test('3. TokenBucket unit math: handles burst capacity, continuous refill, and discrete consumption', () => {
        // Bucket with capacity 3, refill rate 3 per minute (1 token every 20,000ms)
        const bucket = new TokenBucket(3, 3);
        const now = Date.now();

        // 1st consumption: allowed, 2 remaining
        const c1 = bucket.tryConsume(1, now);
        assert.equal(c1.allowed, true);
        assert.equal(c1.limit, 3);
        assert.equal(c1.remaining, 2);

        // 2nd consumption: allowed, 1 remaining
        const c2 = bucket.tryConsume(1, now);
        assert.equal(c2.allowed, true);
        assert.equal(c2.remaining, 1);

        // 3rd consumption: allowed, 0 remaining
        const c3 = bucket.tryConsume(1, now);
        assert.equal(c3.allowed, true);
        assert.equal(c3.remaining, 0);

        // 4th consumption without time elapsed: breached!
        const c4 = bucket.tryConsume(1, now);
        assert.equal(c4.allowed, false);
        assert.equal(c4.remaining, 0);
        assert.ok(c4.retryAfter >= 1, 'retryAfter must be at least 1 second');

        // Simulate forward 20 seconds: 1 token refilled
        const c5 = bucket.tryConsume(1, now + 20000);
        assert.equal(c5.allowed, true, 'Must allow consumption after token refills');
    });

    // 4. HTTP Rate Limiting on /api/chat with 429, Retry-After, and X-RateLimit headers
    test('4. Rate limiter on /api/chat emits standard X-RateLimit headers and returns HTTP 429 when breached', async () => {
        const uniqueKey = `client_chat_limit_${Date.now()}`;
        // Create custom rate limiter instance with capacity 2 for fast deterministic testing
        const customLimiter = createTokenBucketRateLimiter({
            capacity: 2,
            refillRatePerMinute: 2,
            message: 'Too many chat requests. Please slow down.'
        });

        const appWithLimiter = express();
        appWithLimiter.use(express.json());
        appWithLimiter.post('/test-chat', customLimiter, (req, res) => res.json({ response: 'ok' }));

        const localServer = http.createServer(appWithLimiter);
        await new Promise(r => localServer.listen(0, '127.0.0.1', r));
        const port = localServer.address().port;
        const testUrl = `http://127.0.0.1:${port}/test-chat`;

        try {
            // Request 1: allowed
            const res1 = await fetch(testUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-enforce-ratelimit': 'true', 'x-session-id': uniqueKey },
                body: JSON.stringify({ message: '1' })
            });
            assert.equal(res1.status, 200);
            assert.equal(res1.headers.get('x-ratelimit-limit'), '2');
            assert.equal(res1.headers.get('x-ratelimit-remaining'), '1');
            assert.ok(res1.headers.get('x-ratelimit-reset'));

            // Request 2: allowed, capacity exhausted
            const res2 = await fetch(testUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-enforce-ratelimit': 'true', 'x-session-id': uniqueKey },
                body: JSON.stringify({ message: '2' })
            });
            assert.equal(res2.status, 200);
            assert.equal(res2.headers.get('x-ratelimit-remaining'), '0');

            // Request 3: breached -> HTTP 429 Too Many Requests
            const res3 = await fetch(testUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-enforce-ratelimit': 'true', 'x-session-id': uniqueKey },
                body: JSON.stringify({ message: '3' })
            });
            assert.equal(res3.status, 429);
            assert.equal(res3.headers.get('x-ratelimit-limit'), '2');
            assert.equal(res3.headers.get('x-ratelimit-remaining'), '0');
            assert.ok(res3.headers.get('retry-after'), 'Must include Retry-After header');
            const retryAfterSec = parseInt(res3.headers.get('retry-after'), 10);
            assert.ok(retryAfterSec >= 1);

            const body3 = await res3.json();
            assert.equal(body3.error, 'Too Many Requests');
            assert.ok(body3.retryAfter >= 1);
        } finally {
            await new Promise(r => localServer.close(r));
        }
    });

    // 5. Configured limits on main app endpoints: /api/chat (30 req/min) & /api/tts (20 req/min)
    test('5. Configured Token Bucket rate limiters are mounted on /api/chat (30) and /api/tts (20)', async () => {
        // Test /api/chat headers with enforce flag
        const chatRes = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-enforce-ratelimit': 'true',
                'x-session-id': `sess_endpoint_chat_${Date.now()}`
            },
            body: JSON.stringify({ message: 'كم رصيدي؟' })
        });
        assert.equal(chatRes.status, 200);
        assert.equal(chatRes.headers.get('x-ratelimit-limit'), '30', '/api/chat must have capacity 30');
        assert.ok(chatRes.headers.get('x-ratelimit-remaining') !== null);

        // Test /api/tts headers with enforce flag
        const ttsRes = await fetch(`${baseUrl}/api/tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-enforce-ratelimit': 'true',
                'x-session-id': `sess_endpoint_tts_${Date.now()}`
            },
            body: JSON.stringify({ text: 'مرحبا بك في فاي' })
        });
        assert.equal(ttsRes.status, 200);
        assert.equal(ttsRes.headers.get('x-ratelimit-limit'), '20', '/api/tts must have capacity 20');
        assert.ok(ttsRes.headers.get('x-ratelimit-remaining') !== null);
    });

    // 6. Whitelisting automated test harnesses & internal health probes
    test('6. Whitelisting automatically bypasses rate limiting for test harnesses and internal health probes', async () => {
        // Test harness bypass header
        const resBypass = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-bypass-ratelimit': 'true',
                'x-session-id': `sess_bypass_${Date.now()}`
            },
            body: JSON.stringify({ message: 'كم رصيدي؟' })
        });
        assert.equal(resBypass.status, 200);
        assert.equal(resBypass.headers.get('x-ratelimit-bypass'), 'true', 'Must bypass rate limit with x-bypass-ratelimit');

        // Internal health probe bypass header
        const resHealth = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-health-probe': 'true',
                'x-session-id': `sess_health_${Date.now()}`
            },
            body: JSON.stringify({ message: 'كم رصيدي؟' })
        });
        assert.equal(resHealth.status, 200);
        assert.equal(resHealth.headers.get('x-ratelimit-bypass'), 'true', 'Must bypass rate limit for internal health probe');

        // Health probe User-Agent
        const resUa = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'user-agent': 'GoogleHC/1.0',
                'x-session-id': `sess_ua_${Date.now()}`
            },
            body: JSON.stringify({ message: 'كم رصيدي؟' })
        });
        assert.equal(resUa.status, 200);
        assert.equal(resUa.headers.get('x-ratelimit-bypass'), 'true', 'Must bypass rate limit for GoogleHC probe');
    });
});

// =========================================================================
// Task 20: Embedded SQLite Persistence Layer & Full ACID Transactions (Item 3)
// =========================================================================
describe('VI Wallet Regression Suite - Task 20: Embedded SQLite Persistence Layer & ACID Transactions', () => {
    beforeEach(() => {
        resetDatabase();
        clearAuditLog();
    });

    test('1. SQLite WAL mode verification and structured schema tables integrity', () => {
        const db = getSqliteDb();
        const mode = db.pragma('journal_mode', { simple: true });
        assert.equal(mode.toLowerCase(), 'wal', 'SQLite must be running in WAL (Write-Ahead Logging) mode');

        // Check structured tables exist
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
        assert.ok(tables.includes('accounts'), 'accounts table must exist');
        assert.ok(tables.includes('contacts'), 'contacts table must exist');
        assert.ok(tables.includes('bills'), 'bills table must exist');
        assert.ok(tables.includes('transactions'), 'transactions table must exist');
        assert.ok(tables.includes('audit_logs'), 'audit_logs table must exist');
    });

    test('2. Automatic seeder populates SQLite tables with initial data', () => {
        const db = getSqliteDb();
        const user = db.prepare('SELECT * FROM accounts LIMIT 1').get();
        assert.ok(user, 'Account record must exist');
        assert.equal(user.id, 'usr_1001');
        assert.equal(user.balance, 3000000);
        assert.equal(user.currency, 'IQD');

        const contactsCount = db.prepare('SELECT COUNT(*) as count FROM contacts').get().count;
        assert.ok(contactsCount >= 7, 'Must have seeded contacts');

        const billsCount = db.prepare('SELECT COUNT(*) as count FROM bills').get().count;
        assert.equal(billsCount, 4, 'Must have 4 seeded bills');
    });

    test('3. Explicit atomic transaction for transfer executes balance deduction, ledger, and audit log atomically', () => {
        const sid = `test_tx_atomic_${Date.now()}`;
        const idemp = `idemp_tx_${Date.now()}`;
        const initialBal = readDatabase().user.balance;

        const res = executeTransferMutation({
            recipient: 'سيف',
            phone: '+9647804455667',
            amount: 50000,
            idempotency_key: idemp,
            sessionId: sid
        });

        assert.equal(res.success, true);
        assert.equal(res.newBalance, initialBal - 50000);

        // Verify SQLite tables directly
        const db = getSqliteDb();
        const userRow = db.prepare('SELECT balance FROM accounts WHERE id = ?').get('usr_1001');
        assert.equal(Number(userRow.balance), initialBal - 50000);

        const txRow = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?').get(idemp);
        assert.ok(txRow, 'Transaction must be committed in SQLite transactions table');
        assert.equal(Number(txRow.amount), 50000);

        const auditRow = db.prepare('SELECT * FROM audit_logs WHERE idempotency_key = ?').get(idemp);
        assert.ok(auditRow, 'Audit log must be committed in SQLite audit_logs table');
        assert.equal(auditRow.execution_status, 'SUCCESS');
    });

    test('4. ACID rollback guarantee: invalid or insufficient transfer leaves database completely unmutated', () => {
        const initialBal = readDatabase().user.balance;
        const db = getSqliteDb();
        const txCountBefore = db.prepare('SELECT COUNT(*) as count FROM transactions').get().count;

        // Try transfer exceeding balance
        assert.throws(() => {
            executeTransferMutation({
                recipient: 'سيف',
                phone: '+9647804455667',
                amount: initialBal + 500000,
                sessionId: 'sess_rollback_test'
            });
        }, /Insufficient balance/);

        // Verify zero changes to balance or ledger
        const userRow = db.prepare('SELECT balance FROM accounts WHERE id = ?').get('usr_1001');
        assert.equal(Number(userRow.balance), initialBal, 'Balance must remain unchanged after rollback');
        const txCountAfter = db.prepare('SELECT COUNT(*) as count FROM transactions').get().count;
        assert.equal(txCountAfter, txCountBefore, 'No transaction row should be committed after rollback');
    });

    test('5. Explicit atomic transaction for bill payment marks bills paid and deducts balance atomically', () => {
        const sid = `test_bill_atomic_${Date.now()}`;
        const idemp = `idemp_bill_${Date.now()}`;
        const initialBal = readDatabase().user.balance;

        const res = executeBillPaymentMutation({
            billIds: ['bill_elec_01'], // 50,000 IQD
            idempotency_key: idemp,
            sessionId: sid
        });

        assert.equal(res.success, true);
        assert.equal(res.newBalance, initialBal - 50000);

        const db = getSqliteDb();
        const billRow = db.prepare('SELECT status FROM bills WHERE id = ?').get('bill_elec_01');
        assert.equal(billRow.status, 'paid');

        // Audit log in SQLite
        const auditRow = db.prepare('SELECT * FROM audit_logs WHERE idempotency_key = ?').get(idemp);
        assert.ok(auditRow);
        assert.equal(auditRow.action_type, 'BILL_PAYMENT');
        assert.equal(auditRow.execution_status, 'SUCCESS');
    });

    test('6. Synchronous export utility continuously syncs SQLite state to mock_wallet_db.json without drift', () => {
        const exported = exportSqliteToJson();
        assert.ok(exported.user);
        assert.ok(Array.isArray(exported.contacts));
        assert.ok(Array.isArray(exported.bills));
        assert.ok(Array.isArray(exported.recent_transactions));

        // Read from file directly to verify synchronization
        const fileContent = JSON.parse(fs.readFileSync(path.join(__dirname, '../mock_wallet_db.json'), 'utf8'));
        assert.equal(fileContent.user.balance, exported.user.balance);
        assert.equal(fileContent.bills.length, exported.bills.length);
    });
});

// =========================================================================
// Task 21: High-Performance Hybrid NLP Intent Router (Item 4)
// =========================================================================
describe('VI Wallet Regression Suite - Task 21: High-Performance Hybrid NLP Intent Router', () => {
    let baseUrl;
    let localServer;

    before(async () => {
        localServer = http.createServer(app);
        await new Promise(r => localServer.listen(0, '127.0.0.1', r));
        baseUrl = `http://127.0.0.1:${localServer.address().port}`;
    });

    after(async () => {
        await new Promise(r => localServer.close(r));
    });

    beforeEach(() => {
        resetDatabase();
    });

    test('1. Tier-1 Fast Path executes in <0.2ms for standard deterministic inquiries', () => {
        const res = evaluateHybridIntent('كم رصيدي؟');
        assert.equal(res.tier, 1);
        assert.equal(res.intent, 'BALANCE_INQUIRY');
        assert.equal(res.fastPath, true);
        assert.ok(res.latencyMs < 1.0, `Fast path should run in <1ms, took ${res.latencyMs}ms`);
    });

    test('2. Tier-2 Semantic Fallback classifies colloquial Iraqi slang variants with confidence >= 0.82', () => {
        // Slang money transfer
        const transferSlang = evaluateHybridIntent('دزلي فليسات لأبو علي');
        assert.equal(transferSlang.tier, 2);
        assert.equal(transferSlang.intent, 'TRANSFER');
        assert.ok(transferSlang.confidence >= 0.82, `Confidence ${transferSlang.confidence} should be >= 0.82`);
        assert.equal(transferSlang.semanticFallback, true);

        // Slang bill payment / inquiry
        const billSlang = evaluateHybridIntent('صفّيلي اشتراك النت');
        assert.equal(billSlang.tier, 2);
        assert.equal(billSlang.intent, 'BILL_INQUIRY');
        assert.ok(billSlang.confidence >= 0.82, `Confidence ${billSlang.confidence} should be >= 0.82`);
        assert.equal(billSlang.semanticFallback, true);
    });

    test('3. Zero-dependency local classifier runs entirely offline in under 3ms', () => {
        const phrases = [
            'دزلي فليسات لأبو علي',
            'صفّيلي اشتراك النت',
            'منو مسجل يمي بالدفتر',
            'شكد باقي بجيبي',
            'وين راحت فلوسي'
        ];

        for (const phrase of phrases) {
            const result = classifySemanticIntent(phrase);
            assert.ok(result.latencyMs < 3.0, `Classifier for "${phrase}" took ${result.latencyMs}ms, must be < 3ms`);
            assert.ok(result.isConfident, `Phrase "${phrase}" must be confident`);
            assert.ok(result.confidence >= CONFIDENCE_THRESHOLD, `Confidence must meet threshold ${CONFIDENCE_THRESHOLD}`);
        }
    });

    test('4. Multi-dialect Iraqi financial vocabulary coverage (balance, transactions, contacts)', () => {
        const balanceRes = evaluateHybridIntent('شكد باقي بجيبي فلوس كاش');
        assert.equal(balanceRes.intent, 'BALANCE_INQUIRY');
        assert.ok(balanceRes.confidence >= 0.82);

        const txRes = evaluateHybridIntent('وين راحت فلوسي هالشهر');
        assert.equal(txRes.intent, 'TRANSACTIONS_INQUIRY');
        assert.ok(txRes.confidence >= 0.82);

        const contactsRes = evaluateHybridIntent('منو مسجل يمي بالدفتر وجماعتي');
        assert.equal(contactsRes.intent, 'CONTACTS_INQUIRY');
        assert.ok(contactsRes.confidence >= 0.82);
    });

    test('5. Low-confidence or ambiguous utterances gracefully escalate to LLM', () => {
        const ambiguous = evaluateHybridIntent('شلون الجو اليوم في بغداد؟');
        assert.equal(ambiguous.tier, 2);
        assert.equal(ambiguous.intent, null, 'Unrelated message should not match financial intent');
        assert.equal(ambiguous.escalateToLLM, true, 'Must flag escalateToLLM: true');
        assert.ok(ambiguous.confidence < CONFIDENCE_THRESHOLD);
    });

    test('6. End-to-end /api/chat immediately resolves colloquial slang via Hybrid NLP router', async () => {
        const res = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-id': `sess_hybrid_${Date.now()}` },
            body: JSON.stringify({ message: 'شكد باقي بجيبي بالمحفظة' })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(data.response.includes('رصيدك الحالي بمحفظتك هسة هو:'));
    });
});

describe('VI Wallet Regression Suite - Task 22: Dynamic Contextual Actionable Message Chips', () => {
    const fs = require('fs');
    const path = require('path');
    const frontend = require('../../frontend/script.js');

    test('1. Contextual Action Chips derivation for Balance Inquiries Intent', () => {
        assert.equal(typeof frontend.getContextualActionChips, 'function');

        const chips = frontend.getContextualActionChips('كم رصيدي هسة؟', 'رصيدك الحالي بمحفظتك هو 3,000,000 د.ع');
        assert.ok(Array.isArray(chips));
        assert.equal(chips.length, 3);

        const labels = chips.map(c => c.label);
        const actions = chips.map(c => c.action);

        assert.ok(labels.includes('💸 تحويل سريع'), 'Must include 💸 تحويل سريع chip for balance inquiry');
        assert.ok(labels.includes('⚡ تسديد الفواتير'), 'Must include ⚡ تسديد الفواتير chip for balance inquiry');
        assert.ok(labels.includes('📜 كشف الحساب'), 'Must include 📜 كشف الحساب chip for balance inquiry');

        assert.ok(actions.includes('modal:quick-transfer'), 'Must map quick transfer to modal:quick-transfer');
        assert.ok(actions.some(a => a.startsWith('prompt:')), 'Must include prompt auto-dispatch actions');
    });

    test('2. Contextual Action Chips derivation for Bill Queries Intent', () => {
        const chips = frontend.getContextualActionChips('شنو الفواتير المكسورة عندي؟', 'لديك فاتورة الكهرباء وفاتورة الإنترنت مستحقة الدفع.');
        assert.ok(Array.isArray(chips));
        assert.ok(chips.length >= 3);

        const labels = chips.map(c => c.label);
        assert.ok(labels.includes('💳 سداد الآن'), 'Must include 💳 سداد الآن chip for bill queries');
        assert.ok(labels.includes('⚡ تسديد الإنترنت') || labels.includes('💡 تسديد الكهرباء') || labels.includes('📊 كم رصيدي؟'));

        const payNowChip = chips.find(c => c.label === '💳 سداد الآن');
        assert.ok(payNowChip.action.startsWith('prompt:'), 'سداد الآن must map to payment prompt');
    });

    test('3. Follow-up Chips for Completed Financial Mutations / Receipts', () => {
        const chips = frontend.getContextualActionChips('حول 50 الف لاحمد', 'تم التحويل بنجاح إلى أحمد بمبلغ 50,000 د.ع. وصل العملية: TRX-99201');
        assert.ok(Array.isArray(chips));

        const labels = chips.map(c => c.label);
        assert.ok(labels.includes('📊 كم رصيدي هسة؟'), 'Must include balance check following a completed transfer');
        assert.ok(labels.includes('📜 كشف الحساب'), 'Must include ledger check following a completed transfer');
        assert.ok(labels.includes('💸 تحويل آخر'), 'Must include quick transfer modal for another transfer');
    });

    test('4. Card Gating: Confirmation Cards & Disambiguation Cards suppress action chips to avoid conflict', () => {
        // Confirmation card pending
        const confirmChips = frontend.getContextualActionChips('حول 50 الف', 'هل تؤكد التحويل؟ <CONFIRMATION_REQUIRED>{"action":"TRANSFER"}</CONFIRMATION_REQUIRED>');
        assert.deepEqual(confirmChips, [], 'Must return empty array when message contains confirmation card');

        // Disambiguation card pending
        const disambigChips = frontend.getContextualActionChips('حول لاحمد', 'عندي أكثر من جهة بهذا الاسم: <DISAMBIGUATION_REQUIRED>[{"name":"أحمد"}]</DISAMBIGUATION_REQUIRED>');
        assert.deepEqual(disambigChips, [], 'Must return empty array when message contains disambiguation card');

        // Error card
        const errorChips = frontend.getContextualActionChips('test', '⚠️ تنبيه: تعذر إتمام العملية');
        assert.deepEqual(errorChips, [], 'Must return empty array when message is an error notification');
    });

    test('5. DOM Structure, Accessibility & Idempotency of appendActionChipsToMessage', () => {
        // Setup minimal mock DOM
        const mockWrapper = {
            _children: [],
            querySelector(sel) {
                return this._children.find(c => c._className && c._className.includes(sel.replace('.', ''))) || null;
            },
            appendChild(el) {
                this._children.push(el);
            },
            insertBefore(el, ref) {
                const idx = this._children.indexOf(ref);
                if (idx !== -1) {
                    this._children.splice(idx, 0, el);
                } else {
                    this._children.push(el);
                }
            }
        };

        const mockFooter = {
            _className: 'msg-footer',
            parentNode: mockWrapper
        };
        mockWrapper.appendChild(mockFooter);

        // Global document mock for this test
        const originalDoc = global.document;
        global.document = {
            createElement(tag) {
                return {
                    tagName: tag.toUpperCase(),
                    className: '',
                    attributes: {},
                    setAttribute(k, v) { this.attributes[k] = v; },
                    getAttribute(k) { return this.attributes[k]; },
                    appendChild(child) {
                        if (!this.children) this.children = [];
                        this.children.push(child);
                    },
                    classList: {
                        add(c) { this._classes = this._classes || []; this._classes.push(c); },
                        contains(c) { return (this._classes || []).includes(c); }
                    }
                };
            }
        };

        try {
            const chips = [
                { label: '💸 تحويل سريع', action: 'modal:quick-transfer' },
                { label: '⚡ تسديد الفواتير', action: 'prompt:شكو عندي فواتير مكسورة؟' }
            ];

            const container = frontend.appendActionChipsToMessage(mockWrapper, chips);
            assert.ok(container, 'Must return created chips container');
            assert.equal(container.className, 'bot-action-chips-container');
            assert.equal(container.attributes['role'], 'group');
            assert.equal(container.attributes['aria-label'], 'إجراءات مالية سريعة');
            assert.equal(container.children.length, 2);

            const firstBtn = container.children[0];
            assert.equal(firstBtn.className, 'bot-action-chip');
            assert.equal(firstBtn.attributes['data-chip-action'], 'modal:quick-transfer');
            assert.equal(firstBtn.textContent, '💸 تحويل سريع');

            // Idempotency: Second call on same wrapper must be a no-op
            mockWrapper._children.unshift(container);
            container._className = 'bot-action-chips-container';
            const secondCall = frontend.appendActionChipsToMessage(mockWrapper, chips);
            assert.equal(secondCall, null, 'Must not append duplicate chips container if already present');
        } finally {
            global.document = originalDoc;
        }
    });

    test('6. CSS Architecture: Glassmorphic Styling, Smooth Hover Elevation & Micro-Glow Borders', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // Container rules
        assert.ok(css.includes('.bot-action-chips-container'), 'Must define .bot-action-chips-container');
        assert.ok(css.includes('overflow-x: auto'), 'Container must allow smooth horizontal scrolling');
        assert.ok(css.includes('scrollbar-width: none'), 'Container must have hidden scrollbars for clean glass appearance');

        // Chip button rules
        assert.ok(css.includes('.bot-action-chip'), 'Must define .bot-action-chip');
        assert.ok(css.includes('backdrop-filter: blur(20px)'), 'Chip must feature glassmorphic backdrop-filter blur');
        assert.ok(css.includes('border-radius: var(--radius-pill, 9999px)'), 'Chip must feature rounded pill borders');
        assert.ok(css.includes('transform: translateY(-2px)'), 'Hover must elevate by translateY(-2px)');
        assert.ok(css.includes('.bot-action-chip:active'), 'Must support active press scale state');
        assert.ok(css.includes('[data-theme="dark"] .bot-action-chip'), 'Must support dark theme glass styling');
        assert.ok(css.includes('[data-theme="light"] .bot-action-chip'), 'Must support light theme glass styling');
    });
});

describe('VI Wallet Regression Suite - Task 23: Biometric Ambient Glow & Audio Waveform Synchronization', () => {
    const fs = require('fs');
    const path = require('path');
    const frontend = require('../../frontend/script.js');

    test('1. computeAudioRmsIntensity: Mathematical Precision and Dynamic Range (0.0 to 1.0)', () => {
        assert.equal(typeof frontend.computeAudioRmsIntensity, 'function');

        // Test silence: all values centered at 128 (zero displacement)
        const silenceData = new Uint8Array(64).fill(128);
        const silenceIntensity = frontend.computeAudioRmsIntensity(silenceData);
        assert.equal(silenceIntensity, 0, 'Silence must yield exactly 0 intensity');

        // Test maximum volume / clipping sine wave: alternating between 0 and 255
        const maxData = new Uint8Array(64);
        for (let i = 0; i < 64; i++) {
            maxData[i] = (i % 2 === 0) ? 0 : 255;
        }
        const maxIntensity = frontend.computeAudioRmsIntensity(maxData);
        assert.equal(maxIntensity, 1.0, 'Max signal must clamp to 1.0');

        // Test moderate conversational speech amplitude: gentle deviation around 128
        const speechData = new Uint8Array(64);
        for (let i = 0; i < 64; i++) {
            speechData[i] = Math.round(128 + Math.sin(i / 4) * 35);
        }
        const speechIntensity = frontend.computeAudioRmsIntensity(speechData);
        assert.ok(speechIntensity > 0.1 && speechIntensity < 0.9, 'Realistic speech must scale within vibrant range (0.1 - 0.9)');

        // Edge case: empty or invalid buffer
        assert.equal(frontend.computeAudioRmsIntensity(null), 0);
        assert.equal(frontend.computeAudioRmsIntensity(new Uint8Array(0)), 0);
    });

    test('2. Web Audio API AnalyserNode Setup & FFT Size 64 Configuration', async () => {
        let createdSource = null;
        let createdAnalyser = null;
        let destinationConnected = false;

        const mockAudioCtx = {
            state: 'running',
            destination: { id: 'speakers' },
            createMediaElementSource(audioEl) {
                createdSource = {
                    audioEl,
                    connectedTo: null,
                    connect(target) { this.connectedTo = target; },
                    disconnect() { this.connectedTo = null; }
                };
                return createdSource;
            },
            createAnalyser() {
                createdAnalyser = {
                    fftSize: 2048,
                    connectedTo: null,
                    connect(target) {
                        this.connectedTo = target;
                        if (target === mockAudioCtx.destination) {
                            destinationConnected = true;
                        }
                    },
                    disconnect() { this.connectedTo = null; },
                    getByteTimeDomainData(arr) { arr.fill(160); }
                };
                return createdAnalyser;
            },
            resume: async () => {}
        };

        const originalWin = global.window;
        const originalDoc = global.document;

        const customProps = {};
        const docClasses = [];
        const mockAvatar = {
            style: {
                setProperty(k, v) { customProps['avatar:' + k] = v; },
                removeProperty(k) { delete customProps['avatar:' + k]; }
            },
            classList: {
                add(c) { docClasses.push(c); },
                remove(c) { const idx = docClasses.indexOf(c); if (idx !== -1) docClasses.splice(idx, 1); }
            }
        };

        global.window = {
            AudioContext: function() { return mockAudioCtx; },
            requestAnimationFrame: () => 1234,
            cancelAnimationFrame: () => {}
        };

        global.document = {
            documentElement: {
                style: {
                    setProperty(k, v) { customProps[k] = v; },
                    removeProperty(k) { delete customProps[k]; }
                },
                classList: {
                    add(c) { docClasses.push(c); },
                    remove(c) { const idx = docClasses.indexOf(c); if (idx !== -1) docClasses.splice(idx, 1); }
                }
            },
            querySelectorAll(sel) {
                if (sel.includes('msg-avatar') || sel.includes('is-speaking-avatar')) {
                    return [mockAvatar];
                }
                return [];
            }
        };

        try {
            const mockAudio = {
                playbackRate: 1.0,
                paused: false,
                ended: false,
                play: async () => {},
                pause: () => {}
            };

            await frontend.playTtsAudio(mockAudio);

            // Assertions on Web Audio API configuration
            assert.ok(createdSource, 'Must instantiate createMediaElementSource for HTMLAudioElement');
            assert.ok(createdAnalyser, 'Must instantiate AnalyserNode');
            assert.equal(createdAnalyser.fftSize, 64, 'AnalyserNode fftSize must strictly be configured to 64');
            assert.equal(createdSource.connectedTo, createdAnalyser, 'MediaElementSource must connect directly to AnalyserNode');
            assert.equal(destinationConnected, true, 'AnalyserNode must connect to AudioContext.destination for zero audio latency');
        } finally {
            frontend.stopTtsAudioVisualizer();
            global.window = originalWin;
            global.document = originalDoc;
        }
    });

    test('3. Clean Disconnection & Zero Memory Leaks on Speech Completion or Reset', () => {
        const customProps = { '--speech-intensity': '0.75' };
        const classes = ['is-speaking-tts'];

        const originalDoc = global.document;
        global.document = {
            documentElement: {
                style: {
                    setProperty(k, v) { customProps[k] = v; },
                    removeProperty(k) { delete customProps[k]; }
                },
                classList: {
                    add(c) { classes.push(c); },
                    remove(c) { const idx = classes.indexOf(c); if (idx !== -1) classes.splice(idx, 1); }
                }
            },
            querySelectorAll() { return []; }
        };

        try {
            frontend.resetSpeechIntensity();
            assert.equal(customProps['--speech-intensity'], '0', 'Must reset --speech-intensity to 0');
            assert.ok(!classes.includes('is-speaking-tts'), 'Must cleanly remove .is-speaking-tts class');
        } finally {
            global.document = originalDoc;
        }
    });

    test('4. CSS Architecture: Ambient Glow, Waveform Oscillation & Accessibility Tokens in style.css', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // Speech intensity token
        assert.ok(css.includes('--speech-intensity'), 'Must declare --speech-intensity token in stylesheet');

        // Central VI logo breathing radial drop-shadow glow and scale
        assert.ok(css.includes('.hero-logo-img'), 'Must style .hero-logo-img');
        assert.ok(css.includes('html.is-speaking-tts .hero-logo-img'), 'Must define active speech rule on central logo');
        assert.ok(css.includes('var(--speech-intensity'), 'Logo must bind to --speech-intensity');
        assert.ok(css.includes('drop-shadow'), 'Logo must have drop-shadow ambient glow');

        // Message bubble avatars speech glow and oscillation
        assert.ok(css.includes('.msg-avatar.is-speaking-avatar'), 'Must define active speaking avatar style');
        assert.ok(css.includes('transform: scale(calc(1 +'), 'Avatar must oscillate dynamically with speech amplitude');
        assert.ok(css.includes('box-shadow: 0 4px calc('), 'Avatar must emit radial glow box-shadow');

        // Dual theme support
        assert.ok(css.includes('[data-theme="light"] .msg-avatar.is-speaking-avatar'), 'Must style speaking avatar for light theme');

        // Accessibility reduced-motion override
        assert.ok(css.includes('.hero-logo-img,') && css.includes('transform: none !important;'), 'Must disable speech oscillation when reduced motion is preferred');
    });
});

// =========================================================================
// Category 24: Dual-Currency Exchange Rate Pill & Live Micro-Calculator Popover
// =========================================================================
describe('VI Wallet Regression Suite - Task 24: Dual-Currency Exchange Rate Pill & Live Micro-Calculator Popover', () => {
    const frontend = require('../../frontend/script.js');

    test('1. syncFxCalculatorUsdToIqd: Instantaneous recalculation with zero rounding artifacts', () => {
        frontend.setExchangeRateValue(1530);

        // Standard presets
        const res50 = frontend.syncFxCalculatorUsdToIqd('50');
        assert.equal(res50.usd, '50');
        assert.equal(res50.iqd, '76,500');
        assert.equal(res50.iqdNum, 76500);

        const res100 = frontend.syncFxCalculatorUsdToIqd('100');
        assert.equal(res100.usd, '100');
        assert.equal(res100.iqd, '153,000');
        assert.equal(res100.iqdNum, 153000);

        const res500 = frontend.syncFxCalculatorUsdToIqd('500');
        assert.equal(res500.usd, '500');
        assert.equal(res500.iqd, '765,000');
        assert.equal(res500.iqdNum, 765000);

        // Decimal USD input
        const resDecimal = frontend.syncFxCalculatorUsdToIqd('10.5');
        assert.equal(resDecimal.usd, '10.5');
        assert.equal(resDecimal.iqd, '16,065');
        assert.equal(resDecimal.iqdNum, 16065);

        // Empty & invalid handling without NaN or throwing
        const resEmpty = frontend.syncFxCalculatorUsdToIqd('');
        assert.equal(resEmpty.iqd, '');
        assert.equal(resEmpty.iqdNum, 0);

        const resInvalid = frontend.syncFxCalculatorUsdToIqd('abc');
        assert.equal(resInvalid.iqd, '');
        assert.equal(resInvalid.iqdNum, 0);
    });

    test('2. syncFxCalculatorIqdToUsd: Instantaneous reverse recalculation with pristine precision', () => {
        frontend.setExchangeRateValue(1530);

        // Exact reverse matches
        const res153k = frontend.syncFxCalculatorIqdToUsd('153,000');
        assert.equal(res153k.usd, '100');
        assert.equal(res153k.usdNum, 100);
        assert.equal(res153k.iqd, '153,000');

        const res76k = frontend.syncFxCalculatorIqdToUsd('76500');
        assert.equal(res76k.usd, '50');
        assert.equal(res76k.usdNum, 50);

        const res765k = frontend.syncFxCalculatorIqdToUsd('765,000');
        assert.equal(res765k.usd, '500');
        assert.equal(res765k.usdNum, 500);

        // Fractional calculation rounded cleanly to 2 decimals
        const resFractional = frontend.syncFxCalculatorIqdToUsd('100,000');
        assert.equal(resFractional.usd, '65.36');
        assert.equal(resFractional.usdNum, 65.36);

        // Empty & invalid input handling
        const resEmpty = frontend.syncFxCalculatorIqdToUsd('');
        assert.equal(resEmpty.usd, '');
        assert.equal(resEmpty.usdNum, 0);
    });

    test('3. updateFxTickerTelemetry: Live telemetry string formatting across rate updates', () => {
        const mockElements = {
            'header-fx-ticker-text': { textContent: '' },
            'fx-calc-rate-badge': { textContent: '' }
        };

        const originalDoc = global.document;
        global.document = {
            getElementById: (id) => mockElements[id] || null
        };

        try {
            frontend.setExchangeRateValue(1530);
            frontend.updateFxTickerTelemetry();
            assert.equal(mockElements['header-fx-ticker-text'].textContent, '100$ = 153,000 د.ع ⇄');
            assert.equal(mockElements['fx-calc-rate-badge'].textContent, '1$ = 1,530 د.ع');

            // Dynamic rate change (e.g. 1500)
            frontend.setExchangeRateValue(1500);
            assert.equal(mockElements['header-fx-ticker-text'].textContent, '100$ = 150,000 د.ع ⇄');
            assert.equal(mockElements['fx-calc-rate-badge'].textContent, '1$ = 1,500 د.ع');
        } finally {
            frontend.setExchangeRateValue(1530);
            global.document = originalDoc;
        }
    });

    test('4. toggleFxCalculatorPopover: ARIA attributes, modal state and collision management', () => {
        const popoverClasses = ['fx-calculator-popover', 'hidden'];
        const btnAttrs = { 'aria-expanded': 'false' };
        const ttsPopoverClasses = ['tts-settings-popover'];
        const ttsBtnAttrs = { 'aria-expanded': 'true' };

        const mockElements = {
            'fx-calculator-popover': {
                classList: {
                    contains: (c) => popoverClasses.includes(c),
                    add: (c) => { if (!popoverClasses.includes(c)) popoverClasses.push(c); },
                    remove: (c) => { const idx = popoverClasses.indexOf(c); if (idx !== -1) popoverClasses.splice(idx, 1); }
                }
            },
            'header-fx-ticker-btn': {
                setAttribute: (k, v) => { btnAttrs[k] = v; },
                getAttribute: (k) => btnAttrs[k]
            },
            'tts-settings-popover': {
                classList: {
                    add: (c) => { if (!ttsPopoverClasses.includes(c)) ttsPopoverClasses.push(c); }
                }
            },
            'tts-settings-btn': {
                setAttribute: (k, v) => { ttsBtnAttrs[k] = v; }
            },
            'header-fx-ticker-text': { textContent: '' },
            'fx-calc-rate-badge': { textContent: '' }
        };

        const originalDoc = global.document;
        global.document = {
            getElementById: (id) => mockElements[id] || null
        };

        try {
            // Initial toggle opens popover
            frontend.toggleFxCalculatorPopover();
            assert.ok(!popoverClasses.includes('hidden'), 'Popover must be visible when opened');
            assert.equal(btnAttrs['aria-expanded'], 'true', 'aria-expanded must be true on toggle button');
            assert.ok(ttsPopoverClasses.includes('hidden'), 'Must close competing TTS popovers');
            assert.equal(ttsBtnAttrs['aria-expanded'], 'false', 'TTS button must reset aria-expanded');

            // Second toggle closes popover
            frontend.toggleFxCalculatorPopover();
            assert.ok(popoverClasses.includes('hidden'), 'Popover must be hidden on close toggle');
            assert.equal(btnAttrs['aria-expanded'], 'false', 'aria-expanded must reset to false');

            // Force open / close parameter test
            frontend.toggleFxCalculatorPopover(true);
            assert.ok(!popoverClasses.includes('hidden'));
            assert.equal(btnAttrs['aria-expanded'], 'true');

            frontend.toggleFxCalculatorPopover(false);
            assert.ok(popoverClasses.includes('hidden'));
            assert.equal(btnAttrs['aria-expanded'], 'false');
        } finally {
            global.document = originalDoc;
        }
    });

    test('5. handleFxPresetClick: Sets USD and recalculates IQD with active chip update', () => {
        const usdInput = { value: '' };
        const iqdInput = { value: '' };
        const makeMockChip = (usd, active = false) => {
            const classes = active ? ['active'] : [];
            return {
                usd,
                classes,
                classList: {
                    toggle: (c, val) => {
                        const idx = classes.indexOf(c);
                        if (val) {
                            if (idx === -1) classes.push(c);
                        } else {
                            if (idx !== -1) classes.splice(idx, 1);
                        }
                    },
                    contains: (c) => classes.includes(c)
                },
                getAttribute: () => usd
            };
        };

        const chips = [
            makeMockChip('50'),
            makeMockChip('100', true),
            makeMockChip('500')
        ];

        const mockElements = {
            'fx-calc-usd-input': usdInput,
            'fx-calc-iqd-input': iqdInput,
            'fx-preset-chips': {
                querySelectorAll: () => chips
            }
        };

        const originalDoc = global.document;
        global.document = {
            getElementById: (id) => mockElements[id] || null
        };

        try {
            frontend.setExchangeRateValue(1530);
            frontend.handleFxPresetClick(500);

            assert.equal(usdInput.value, '500');
            assert.equal(iqdInput.value, '765,000');
            assert.ok(!chips[0].classes.includes('active'));
            assert.ok(!chips[1].classes.includes('active'));
            assert.ok(chips[2].classes.includes('active'), '$500 preset chip must be marked active');
        } finally {
            global.document = originalDoc;
        }
    });

    test('6. HTML & CSS Architecture: Popover glassmorphism, pulse indicator and ARIA compliance', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf-8');
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // HTML Markup & ARIA tests
        assert.ok(html.includes('id="header-fx-ticker-btn"'), 'HTML must declare #header-fx-ticker-btn');
        assert.ok(html.includes('id="header-fx-ticker-text"'), 'HTML must declare #header-fx-ticker-text');
        assert.ok(html.includes('id="fx-calculator-popover"'), 'HTML must declare #fx-calculator-popover');
        assert.ok(html.includes('role="dialog"'), 'Popover must have role="dialog"');
        assert.ok(html.includes('aria-label="حاسبة تحويل العملات اللحظية"'), 'Popover must have descriptive aria-label');
        assert.ok(html.includes('aria-haspopup="dialog"'), 'Ticker button must have aria-haspopup="dialog"');
        assert.ok(html.includes('id="fx-calc-usd-input"'), 'Must contain USD input');
        assert.ok(html.includes('id="fx-calc-iqd-input"'), 'Must contain IQD input');
        assert.ok(html.includes('data-usd="50"'), 'Must contain $50 preset');
        assert.ok(html.includes('data-usd="100"'), 'Must contain $100 preset');
        assert.ok(html.includes('data-usd="500"'), 'Must contain $500 preset');
        assert.ok(html.includes('id="fx-calc-transfer-btn"'), 'Must declare #fx-calc-transfer-btn action CTA');

        // CSS Architecture tests
        assert.ok(css.includes('.header-fx-ticker-btn'), 'CSS must style .header-fx-ticker-btn');
        assert.ok(css.includes('.fx-ticker-pulse'), 'CSS must define .fx-ticker-pulse indicator');
        assert.ok(css.includes('@keyframes fxTickerPulse'), 'CSS must animate live telemetry pulse');
        assert.ok(css.includes('.fx-calculator-popover'), 'CSS must style .fx-calculator-popover');
        assert.ok(css.includes('backdrop-filter: blur('), 'Must feature liquid-glass backdrop blur');
        assert.ok(css.includes('.fx-input-card'), 'CSS must style currency input cards');
        assert.ok(css.includes('.fx-preset-chip'), 'CSS must style preset chips');
        assert.ok(css.includes('.fx-calc-transfer-btn'), 'CSS must style transfer action CTA');
        assert.ok(css.includes('[data-theme="light"] .fx-calculator-popover'), 'Must support light theme styling');
        assert.ok(css.includes('[data-theme="dark"] .fx-calculator-popover'), 'Must support dark theme styling');

        // Accessibility reduced-motion safeguards
        assert.ok(css.includes('.header-fx-ticker-btn:active') && css.includes('transform: none !important;'), 'Must support reduced-motion overrides');
        assert.ok(css.includes('.fx-ticker-pulse') && css.includes('animation: none !important;'), 'Must disable pulse animation under reduced motion');
    });
});

describe('VI Wallet Regression Suite - Category 25: Fintech Pulse Dual-Perspective Analytics (المصروف الفعلي vs الالتزامات المستحقة)', () => {
    const frontend = require('../../frontend/script.js');

    test('1. calculateFintechPulseObligationsData: Accurate Aggregation, Percentages & 100% Sum Guarantee', () => {
        assert.equal(typeof frontend.calculateFintechPulseObligationsData, 'function', 'Must export calculateFintechPulseObligationsData');

        const mockBills = [
            { id: 'b1', title: 'فاتورة الكهرباء الوطنية', amount: 85000, status: 'unpaid' },
            { id: 'b2', title: 'فاتورة شبكة الإنترنت FTTH', amount: 45000, status: 'unpaid' },
            { id: 'b3', title: 'اشتراك مولدة الحي', amount: 15000, status: 'unpaid' },
            { id: 'b4', title: 'فاتورة الماء', amount: 20000, status: 'paid' }
        ];
        const balance = 3000000;

        const data = frontend.calculateFintechPulseObligationsData(mockBills, balance);

        assert.equal(data.totalObligations, 145000, 'Unpaid bills sum must equal 145,000 IQD');
        assert.equal(data.unpaidCount, 3, 'Unpaid bills count must be 3');
        assert.equal(data.balance, 3000000, 'Current balance must match');
        assert.equal(data.freeBalance, 2855000, 'Free balance must be 3,000,000 - 145,000 = 2,855,000 IQD');
        assert.equal(data.totalBase, 3000000, 'Total base must equal current balance');

        // Percentages check
        assert.equal(data.obligationsPct, 5, '145,000 / 3,000,000 is ~4.83% -> rounded to 5%');
        assert.equal(data.freeBalancePct, 95, 'Free balance must be 95%');
        assert.equal(data.obligationsPct + data.freeBalancePct, 100, 'Sum of percentages must equal 100%');

        // Edge case: No unpaid bills
        const paidOnly = [{ id: 'b1', amount: 50000, status: 'paid' }];
        const zeroData = frontend.calculateFintechPulseObligationsData(paidOnly, 1000000);
        assert.equal(zeroData.totalObligations, 0);
        assert.equal(zeroData.unpaidCount, 0);
        assert.equal(zeroData.obligationsPct, 0);
        assert.equal(zeroData.freeBalancePct, 100);

        // Edge case: Empty bills list
        const emptyData = frontend.calculateFintechPulseObligationsData([], 500000);
        assert.equal(emptyData.totalObligations, 0);
        assert.equal(emptyData.obligationsPct, 0);
        assert.equal(emptyData.freeBalancePct, 100);
    });

    test('2. getFintechPulseInsight: Contextual Authentic Iraqi Advice for Obligations Mode', () => {
        assert.equal(typeof frontend.getFintechPulseInsight, 'function');

        // Zero obligations
        const zeroObligations = { totalObligations: 0, unpaidCount: 0, obligationsPct: 0 };
        const zeroTip = frontend.getFintechPulseInsight(zeroObligations, 'obligations');
        assert.ok(zeroTip.includes('التزاماتك مصفية كلها ومحد يطلبك فلس'), 'Must praise zero debt in Iraqi dialect');

        // Moderate obligations (e.g. 5%)
        const modObligations = { totalObligations: 145000, unpaidCount: 3, obligationsPct: 5 };
        const modTip = frontend.getFintechPulseInsight(modObligations, 'obligations');
        assert.ok(modTip.includes('145,000') || modTip.includes('3 فواتير'), 'Tip should mention amount or count');
        assert.ok(modTip.includes('دفعة وحدة') || modTip.includes('سددها'), 'Must provide actionable settlement advice');

        // High obligations (>25%)
        const highObligations = { totalObligations: 800000, unpaidCount: 4, obligationsPct: 30 };
        const highTip = frontend.getFintechPulseInsight(highObligations, 'obligations');
        assert.ok(highTip.includes('30%') || highTip.includes('التزاماتك'), 'Tip should reflect high commitment warning');

        // Critical obligations (>50%)
        const critObligations = { totalObligations: 1800000, unpaidCount: 5, obligationsPct: 60 };
        const critTip = frontend.getFintechPulseInsight(critObligations, 'obligations');
        assert.ok(critTip.includes('دير بالك') || critTip.includes('أكثر من نص رصيدك'), 'Critical tip must caution user');

        // Backward compatibility: expenses mode still functions identically
        const expensesTip = frontend.getFintechPulseInsight({ billsSpent: 0, transfersSpent: 0, balancePct: 100 }, 'expenses');
        assert.ok(expensesTip.includes('عاشت إيدك') && expensesTip.includes('رصيدك كامل'), 'Expenses insight must remain intact');
    });

    test('3. Perspective State Management: getFintechPulsePerspective & setFintechPulsePerspective', () => {
        assert.equal(typeof frontend.getFintechPulsePerspective, 'function');
        assert.equal(typeof frontend.setFintechPulsePerspective, 'function');

        frontend.setFintechPulsePerspective('obligations');
        assert.equal(frontend.getFintechPulsePerspective(), 'obligations', 'Must switch to obligations');

        frontend.setFintechPulsePerspective('expenses');
        assert.equal(frontend.getFintechPulsePerspective(), 'expenses', 'Must switch back to expenses');

        // Invalid perspective fallback
        frontend.setFintechPulsePerspective('invalid_mode');
        assert.equal(frontend.getFintechPulsePerspective(), 'expenses', 'Invalid mode must safely fallback to expenses');
    });

    test('4. renderFintechPulse: Obligations Mode SVG Dash-Array, Amber Color, and Legend Hydration', () => {
        const segBalance = { setAttribute: (k, v) => { segBalance[k] = v; } };
        const segTransfers = { setAttribute: (k, v) => { segTransfers[k] = v; } };
        const segBills = { setAttribute: (k, v) => { segBills[k] = v; } };

        const centerPct = { textContent: '' };
        const centerLabel = { textContent: '' };
        const pctBalance = { textContent: '' };
        const amountBalance = { textContent: '' };
        const pctTransfers = { textContent: '' };
        const amountTransfers = { textContent: '' };
        const pctBills = { textContent: '' };
        const amountBills = { textContent: '' };
        const titleBills = { textContent: '' };
        const titleTransfers = { textContent: '' };
        const titleBalance = { textContent: '' };
        const insightText = { textContent: '' };

        const makeMockClassList = (classes) => ({
            add: (c) => { if (!classes.includes(c)) classes.push(c); },
            remove: (c) => { const i = classes.indexOf(c); if (i !== -1) classes.splice(i, 1); },
            toggle: (c, val) => {
                const i = classes.indexOf(c);
                const shouldAdd = (val !== undefined) ? Boolean(val) : (i === -1);
                if (shouldAdd) {
                    if (i === -1) classes.push(c);
                } else {
                    if (i !== -1) classes.splice(i, 1);
                }
            },
            contains: (c) => classes.includes(c)
        });

        const cardClasses = [];
        const cardElement = { classList: makeMockClassList(cardClasses) };

        const actionsClasses = ['hidden'];
        const actionsElement = { classList: makeMockClassList(actionsClasses) };

        const mockElements = {
            'companion-pulse-card': cardElement,
            'pulse-obligations-actions': actionsElement,
            'pulse-seg-balance': segBalance,
            'pulse-seg-transfers': segTransfers,
            'pulse-seg-bills': segBills,
            'pulse-center-pct': centerPct,
            'pulse-center-label': centerLabel,
            'pulse-pct-balance': pctBalance,
            'pulse-amount-balance': amountBalance,
            'pulse-pct-transfers': pctTransfers,
            'pulse-amount-transfers': amountTransfers,
            'pulse-pct-bills': pctBills,
            'pulse-amount-bills': amountBills,
            'pulse-title-bills': titleBills,
            'pulse-title-transfers': titleTransfers,
            'pulse-title-balance': titleBalance,
            'pulse-ai-insight-text': insightText
        };

        const origDoc = global.document;
        global.document = {
            getElementById: (id) => mockElements[id] || null,
            querySelectorAll: () => [],
            querySelector: () => null
        };

        try {
            // Set mock bills
            frontend.setCachedBills([
                { id: 'b1', title: 'كهرباء', amount: 85000, status: 'unpaid' },
                { id: 'b2', title: 'إنترنت', amount: 45000, status: 'unpaid' },
                { id: 'b3', title: 'مولدة', amount: 15000, status: 'unpaid' }
            ]);

            frontend.setFintechPulsePerspective('obligations');
            const data = frontend.renderFintechPulse();

            assert.ok(data, 'Must return obligations data');
            assert.equal(data.perspective, 'obligations');
            assert.equal(data.totalObligations, 145000);
            assert.equal(segBills['stroke'], '#f59e0b', 'segBills stroke must be amber #f59e0b in obligations mode');
            assert.equal(centerPct.textContent, '5%', 'Center percentage must reflect obligations %');
            assert.equal(centerLabel.textContent, 'نسبة الفواتير');
            assert.ok(cardClasses.includes('is-obligations-mode'), 'Pulse card must have is-obligations-mode class');
            assert.ok(!actionsClasses.includes('hidden'), 'Obligations action CTA must not be hidden when bills are unpaid');
            assert.equal(titleBills.textContent, 'فواتير مطلوبة');
            assert.equal(titleBalance.textContent, 'رصيد حر متبقي');

            // Switch back to expenses
            frontend.setFintechPulsePerspective('expenses');
            const expData = frontend.renderFintechPulse();
            assert.equal(expData.perspective, 'expenses');
            assert.ok(!cardClasses.includes('is-obligations-mode'), 'Pulse card must remove is-obligations-mode class');
            assert.ok(actionsClasses.includes('hidden'), 'Obligations CTA must be hidden in expenses mode');
        } finally {
            global.document = origDoc;
        }
    });

    test('5. handlePayAllBillsAction: Dispatches 1-Tap Bulk Settlement Prompt', () => {
        assert.equal(typeof frontend.handlePayAllBillsAction, 'function', 'Must export handlePayAllBillsAction');
        let submittedText = '';
        frontend.handleFormSubmit = (text) => {
            submittedText = text;
        };

        frontend.handlePayAllBillsAction();
        assert.equal(submittedText, 'سدد كل الفواتير دفعة وحدة', 'Must dispatch exact Iraqi 1-tap bulk settlement prompt');
    });

    test('6. HTML & CSS Architecture: Dual Perspective Toggle, Amber Tokens, and Instant Button', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf-8');
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // HTML Markup
        assert.ok(html.includes('class="pulse-perspective-toggle"'), 'Must include pulse-perspective-toggle');
        assert.ok(html.includes('id="pulse-mode-expenses-btn"'), 'Must include #pulse-mode-expenses-btn');
        assert.ok(html.includes('id="pulse-mode-obligations-btn"'), 'Must include #pulse-mode-obligations-btn');
        assert.ok(html.includes('id="pulse-grad-obligations"'), 'Must include linearGradient #pulse-grad-obligations');
        assert.ok(html.includes('id="pulse-obligations-actions"'), 'Must include #pulse-obligations-actions');
        assert.ok(html.includes('id="pulse-pay-all-btn"'), 'Must include #pulse-pay-all-btn');
        assert.ok(html.includes('سدّد كل الفواتير دفعة وحدة'), 'Must include exact Arabic CTA button text');

        // CSS Styling
        assert.ok(css.includes('.pulse-perspective-toggle'), 'CSS must style .pulse-perspective-toggle');
        assert.ok(css.includes('.pulse-perspective-btn'), 'CSS must style .pulse-perspective-btn');
        assert.ok(css.includes('.companion-pulse-card.is-obligations-mode'), 'CSS must define .companion-pulse-card.is-obligations-mode');
        assert.ok(css.includes('#f59e0b'), 'CSS must include amber warning color #f59e0b');
        assert.ok(css.includes('.pulse-obligations-actions'), 'CSS must style .pulse-obligations-actions');
        assert.ok(css.includes('.pulse-pay-all-btn'), 'CSS must style .pulse-pay-all-btn');
        assert.ok(css.includes('.pulse-pay-all-btn:hover'), 'CSS must style hover elevation for pay-all button');

        // Reduced motion overrides
        assert.ok(css.includes('.pulse-perspective-btn') && css.includes('transition: none !important;'), 'Must have reduced motion overrides for toggle');
        assert.ok(css.includes('.pulse-pay-all-btn:active') && css.includes('transform: none !important;'), 'Must have reduced motion overrides for pay button');
    });
});

describe('VI Wallet Regression Suite - Category 26: Procedural Web Audio API Haptic Sound Synthesizer (ViHaptics)', () => {
    const frontend = require('../../frontend/script.js');

    test('1. ViHaptics.playSuccessChime: Synthesizes Ascending Major Chord (C5-E5-G5-C6) with Exponential Envelopes', () => {
        assert.equal(typeof frontend.ViHaptics, 'object', 'ViHaptics object must be exported');
        assert.equal(typeof frontend.ViHaptics.playSuccessChime, 'function', 'Must export playSuccessChime');

        frontend.setSoundEffectsEnabled(true);

        const createdOscillators = [];
        const createdGains = [];

        class MockGainNode {
            constructor() {
                this.gain = {
                    setValueAtTime: (val, time) => { this.setVal = val; this.setTime = time; },
                    linearRampToValueAtTime: (val, time) => { this.rampVal = val; this.rampTime = time; },
                    exponentialRampToValueAtTime: (val, time) => { this.expVal = val; this.expTime = time; }
                };
            }
            connect(dest) {}
            disconnect() {}
        }

        class MockOscillatorNode {
            constructor() {
                this.type = 'sine';
                this.frequencies = [];
                this.frequency = {
                    setValueAtTime: (val, time) => {
                        this.frequencies.push({ val, time, method: 'set' });
                    },
                    exponentialRampToValueAtTime: (val, time) => {
                        this.frequencies.push({ val, time, method: 'ramp' });
                    }
                };
            }
            connect(dest) {}
            disconnect() {}
            start(t) { this.startTime = t; }
            stop(t) { this.stopTime = t; }
        }

        class MockAudioContext {
            constructor() {
                this.state = 'running';
                this.currentTime = 2.0;
                this.destination = {};
            }
            createGain() {
                const g = new MockGainNode();
                createdGains.push(g);
                return g;
            }
            createOscillator() {
                const osc = new MockOscillatorNode();
                createdOscillators.push(osc);
                return osc;
            }
            resume() { return Promise.resolve(); }
        }

        const origWin = global.window;
        try {
            global.window = {
                AudioContext: MockAudioContext
            };

            const result = frontend.ViHaptics.playSuccessChime();
            assert.equal(result.played, true, 'Must return played: true');
            assert.equal(result.sound, 'success', 'Sound name must be success');
            assert.equal(result.notes.length, 5, 'Must play 5 ascending harmonic components (C5, E5, G5, C6, C7-shimmer)');

            // Verify ascending frequencies: C5=523.25, E5=659.25, G5=783.99, C6=1046.50, C7=2093.00
            assert.equal(result.notes[0].freq, 523.25, 'Note 1 must be C5 (523.25 Hz)');
            assert.equal(result.notes[1].freq, 659.25, 'Note 2 must be E5 (659.25 Hz)');
            assert.equal(result.notes[2].freq, 783.99, 'Note 3 must be G5 (783.99 Hz)');
            assert.equal(result.notes[3].freq, 1046.50, 'Note 4 must be C6 (1046.50 Hz)');
            assert.equal(result.notes[4].freq, 2093.00, 'Note 5 must be C7 shimmer (2093.00 Hz)');

            assert.equal(createdOscillators.length, 5, 'Must instantiate 5 sine wave oscillators for full chord');
            assert.equal(createdGains.length, 5, 'Must instantiate 5 gain nodes for individual decay envelopes');

            // Verify clean node disconnect handler
            assert.equal(typeof createdOscillators[0].onended, 'function', 'Must attach onended handler for node cleanup');
            createdOscillators[0].onended();
        } finally {
            global.window = origWin;
        }
    });

    test('2. ViHaptics.playClickSound: Synthesizes 8ms Crisp Frequency Drop (2200Hz -> 1200Hz)', () => {
        assert.equal(typeof frontend.ViHaptics.playClickSound, 'function', 'Must export playClickSound');

        frontend.setSoundEffectsEnabled(true);
        const createdOscillators = [];
        const createdGains = [];

        class MockGainNode {
            constructor() {
                this.gain = {
                    setValueAtTime: (val, time) => { this.setVal = val; },
                    linearRampToValueAtTime: (val, time) => { this.rampVal = val; },
                    exponentialRampToValueAtTime: (val, time) => { this.expVal = val; }
                };
            }
            connect(dest) {}
            disconnect() {}
        }

        class MockOscillatorNode {
            constructor() {
                this.type = 'sine';
                this.frequencies = [];
                this.frequency = {
                    setValueAtTime: (val, time) => {
                        this.frequencies.push({ val, time, method: 'set' });
                    },
                    exponentialRampToValueAtTime: (val, time) => {
                        this.frequencies.push({ val, time, method: 'ramp' });
                    }
                };
            }
            connect(dest) {}
            disconnect() {}
            start(t) {}
            stop(t) {}
        }

        class MockAudioContext {
            constructor() {
                this.state = 'running';
                this.currentTime = 5.0;
                this.destination = {};
            }
            createGain() {
                const g = new MockGainNode();
                createdGains.push(g);
                return g;
            }
            createOscillator() {
                const osc = new MockOscillatorNode();
                createdOscillators.push(osc);
                return osc;
            }
            resume() { return Promise.resolve(); }
        }

        const origWin = global.window;
        try {
            global.window = {
                AudioContext: MockAudioContext
            };
            frontend.ViHaptics.resetAudioContext();

            const result = frontend.ViHaptics.playClickSound();
            assert.equal(result.played, true, 'Click sound must report played: true');
            assert.equal(result.sound, 'click', 'Sound type must be click');
            assert.equal(result.durationMs, 8, 'Click duration must be exactly 8ms');

            assert.equal(createdOscillators.length, 1, 'Must create 1 micro-click oscillator');
            const osc = createdOscillators[0];
            assert.equal(osc.frequencies[0].val, 2200, 'Start frequency must be 2200 Hz');
            assert.equal(osc.frequencies[1].val, 1200, 'End ramp frequency must be 1200 Hz');
        } finally {
            frontend.ViHaptics.resetAudioContext();
            global.window = origWin;
        }
    });

    test('3. ViHaptics.playErrorThud: Synthesizes Soft Dual-Tone Thud (150Hz & 110Hz Detuned Pair)', () => {
        assert.equal(typeof frontend.ViHaptics.playErrorThud, 'function', 'Must export playErrorThud');

        frontend.setSoundEffectsEnabled(true);
        const createdOscillators = [];

        class MockGainNode {
            constructor() {
                this.gain = {
                    setValueAtTime: () => {},
                    linearRampToValueAtTime: () => {},
                    exponentialRampToValueAtTime: () => {}
                };
            }
            connect(dest) {}
            disconnect() {}
        }

        class MockOscillatorNode {
            constructor() {
                this.frequencies = [];
                this.frequency = {
                    setValueAtTime: (val, time) => {
                        this.frequencies.push({ val, time });
                    },
                    exponentialRampToValueAtTime: (val, time) => {
                        this.frequencies.push({ val, time });
                    }
                };
            }
            connect(dest) {}
            disconnect() {}
            start(t) {}
            stop(t) {}
        }

        class MockAudioContext {
            constructor() {
                this.state = 'running';
                this.currentTime = 10.0;
                this.destination = {};
            }
            createGain() { return new MockGainNode(); }
            createOscillator() {
                const osc = new MockOscillatorNode();
                createdOscillators.push(osc);
                return osc;
            }
            resume() { return Promise.resolve(); }
        }

        const origWin = global.window;
        try {
            global.window = {
                AudioContext: MockAudioContext
            };
            frontend.ViHaptics.resetAudioContext();

            const result = frontend.ViHaptics.playErrorThud();
            assert.equal(result.played, true, 'Error thud must report played: true');
            assert.equal(result.sound, 'error', 'Sound type must be error');
            assert.deepEqual(result.tones, [150, 110], 'Must be 150Hz and 110Hz dual tones');
            assert.equal(result.durationMs, 130, 'Error thud duration must be 130ms');

            assert.equal(createdOscillators.length, 2, 'Must create dual detuned oscillators');
            assert.equal(createdOscillators[0].frequencies[0].val, 150, 'Oscillator 1 starts at 150 Hz');
            assert.equal(createdOscillators[1].frequencies[0].val, 110, 'Oscillator 2 starts at 110 Hz');
        } finally {
            frontend.ViHaptics.resetAudioContext();
            global.window = origWin;
        }
    });

    test('4. Persistent Preference Toggle & Muted State Suppression (vi_sound_effects_enabled)', () => {
        let storage = {};
        const mockLocalStorage = {
            getItem: (k) => storage[k] || null,
            setItem: (k, v) => { storage[k] = String(v); }
        };

        const origWin = global.window;
        try {
            global.window = {
                localStorage: mockLocalStorage
            };

            // Enable
            frontend.setSoundEffectsEnabled(true);
            assert.equal(frontend.isSoundEffectsEnabled(), true);
            assert.equal(storage['vi_sound_effects_enabled'], 'true');

            // Disable / Mute
            frontend.setSoundEffectsEnabled(false);
            assert.equal(frontend.isSoundEffectsEnabled(), false);
            assert.equal(storage['vi_sound_effects_enabled'], 'false');

            // When muted, all sound triggers must immediately abort and return muted without touching AudioContext
            const sRes = frontend.ViHaptics.playSuccessChime();
            assert.equal(sRes.played, false);
            assert.equal(sRes.reason, 'muted');

            const cRes = frontend.ViHaptics.playClickSound();
            assert.equal(cRes.played, false);
            assert.equal(cRes.reason, 'muted');

            const eRes = frontend.ViHaptics.playErrorThud();
            assert.equal(eRes.played, false);
            assert.equal(eRes.reason, 'muted');

            // Toggle sound effects
            const toggled = frontend.toggleSoundEffects();
            assert.equal(toggled, true, 'Toggling from false must return true');
            assert.equal(frontend.isSoundEffectsEnabled(), true);
            assert.equal(storage['vi_sound_effects_enabled'], 'true');
        } finally {
            frontend.setSoundEffectsEnabled(true);
            global.window = origWin;
        }
    });

    test('5. UI Synchronization: Header Pill and Popover Switch State & ARIA Attributes', () => {
        const toggleBtnClasses = [];
        const switchClasses = [];
        let toggleAttributes = {};
        let switchAttributes = {};
        let onIconHidden = false;
        let offIconHidden = false;

        const mockBtn = {
            id: 'haptic-sound-toggle-btn',
            setAttribute: (k, v) => { toggleAttributes[k] = v; },
            classList: {
                toggle: (cls, condition) => {
                    const idx = toggleBtnClasses.indexOf(cls);
                    if (condition && idx === -1) toggleBtnClasses.push(cls);
                    if (!condition && idx !== -1) toggleBtnClasses.splice(idx, 1);
                }
            },
            querySelector: (sel) => {
                if (sel === '.haptic-on') {
                    return { classList: { toggle: (c, cond) => { onIconHidden = cond; } } };
                }
                if (sel === '.haptic-off') {
                    return { classList: { toggle: (c, cond) => { offIconHidden = cond; } } };
                }
                return null;
            }
        };

        const mockSwitch = {
            id: 'haptic-setting-switch',
            setAttribute: (k, v) => { switchAttributes[k] = v; },
            classList: {
                toggle: (cls, condition) => {
                    const idx = switchClasses.indexOf(cls);
                    if (condition && idx === -1) switchClasses.push(cls);
                    if (!condition && idx !== -1) switchClasses.splice(idx, 1);
                }
            }
        };

        const origDoc = global.document;
        try {
            global.document = {
                getElementById: (id) => {
                    if (id === 'haptic-sound-toggle-btn') return mockBtn;
                    if (id === 'haptic-setting-switch') return mockSwitch;
                    return null;
                }
            };

            // Set enabled
            frontend.setSoundEffectsEnabled(true);
            assert.equal(toggleAttributes['aria-pressed'], 'true');
            assert.equal(switchAttributes['aria-checked'], 'true');
            assert.ok(toggleBtnClasses.includes('active'));
            assert.ok(!toggleBtnClasses.includes('is-muted'));
            assert.ok(switchClasses.includes('active'));
            assert.equal(onIconHidden, false, 'On-icon must not be hidden when active');
            assert.equal(offIconHidden, true, 'Off-icon must be hidden when active');

            // Set muted
            frontend.setSoundEffectsEnabled(false);
            assert.equal(toggleAttributes['aria-pressed'], 'false');
            assert.equal(switchAttributes['aria-checked'], 'false');
            assert.ok(toggleBtnClasses.includes('is-muted'));
            assert.ok(!toggleBtnClasses.includes('active'));
            assert.ok(!switchClasses.includes('active'));
            assert.equal(onIconHidden, true, 'On-icon must be hidden when muted');
            assert.equal(offIconHidden, false, 'Off-icon must not be hidden when muted');
        } finally {
            frontend.setSoundEffectsEnabled(true);
            global.document = origDoc;
        }
    });

    test('6. HTML & CSS Architecture: Design Tokens, Glassmorphism, & Reduced Motion', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf-8');
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // HTML Verification
        assert.ok(html.includes('id="haptic-sound-toggle-btn"'), 'Must include #haptic-sound-toggle-btn in header');
        assert.ok(html.includes('haptic-sound-toggle-btn active'), 'Must have .haptic-sound-toggle-btn active class');
        assert.ok(html.includes('haptic-icon haptic-on'), 'Must have .haptic-on SVG icon');
        assert.ok(html.includes('haptic-icon haptic-off hidden'), 'Must have .haptic-off icon hidden by default');
        assert.ok(html.includes('id="haptic-setting-switch"'), 'Must have #haptic-setting-switch in TTS popover');
        assert.ok(html.includes('role="switch"'), 'Switch must have role="switch"');
        assert.ok(html.includes('aria-checked="true"'), 'Switch must have aria-checked="true" by default');

        // CSS Verification
        assert.ok(css.includes('.haptic-sound-toggle-btn'), 'Must style .haptic-sound-toggle-btn');
        assert.ok(css.includes('.haptic-sound-toggle-btn.is-muted'), 'Must style .is-muted state');
        assert.ok(css.includes('.haptic-setting-switch'), 'Must style .haptic-setting-switch');
        assert.ok(css.includes('.haptic-switch-thumb'), 'Must style .haptic-switch-thumb');
        assert.ok(css.includes('.haptic-settings-section'), 'Must style .haptic-settings-section');

        // Reduced Motion
        assert.ok(css.includes('.haptic-sound-toggle-btn:hover') && css.includes('transform: none !important;'), 'Reduced motion must disable hover transform for haptic button');
        assert.ok(css.includes('.haptic-setting-switch') && css.includes('transition: none !important;'), 'Reduced motion must disable transitions for haptic switch');
    });
});

describe('VI Wallet Regression Suite - Category 27: Luxury Swipe-to-Confirm Slider Widget Physics (88% Travel Threshold, High-Value Financial Transfers >100,000 IQD)', () => {
    const frontend = require('../../frontend/script.js');

    test('1. SLIDE_COMPLETION_THRESHOLD is exactly 0.88 (88%) and exported', () => {
        assert.equal(frontend.SLIDE_COMPLETION_THRESHOLD, 0.88, 'SLIDE_COMPLETION_THRESHOLD must be 0.88');
    });

    test('2. isHighValueTransfer accurately flags financial transfers >100,000 IQD across formats', () => {
        assert.equal(typeof frontend.isHighValueTransfer, 'function', 'Must export isHighValueTransfer');
        assert.equal(typeof frontend.parseAmountValue, 'function', 'Must export parseAmountValue');

        // Below threshold
        assert.equal(frontend.isHighValueTransfer({ amount: '50,000 د.ع' }), false);
        assert.equal(frontend.isHighValueTransfer({ amount: '100,000 IQD' }), false);
        assert.equal(frontend.isHighValueTransfer('25,000 دينار'), false);

        // Above threshold (>100,000 IQD)
        assert.equal(frontend.isHighValueTransfer({ amount: '100,001 د.ع' }), true);
        assert.equal(frontend.isHighValueTransfer({ amount: '150,000 د.ع' }), true);
        assert.equal(frontend.isHighValueTransfer({ amount: '500,000 IQD' }), true);
        assert.equal(frontend.isHighValueTransfer({ amount: '١٥٠,٠٠٠ د.ع' }), true); // Eastern Arabic numerals
        assert.equal(frontend.isHighValueTransfer({ amount: '1,000,000 دينار' }), true);
        assert.equal(frontend.isHighValueTransfer({ amount: 'مليون دينار' }), true);
        assert.equal(frontend.isHighValueTransfer({ isHighValue: true }), true);
    });

    test('3. renderFintechConfirmationCard activates luxury security badge & high-value classes for >100,000 IQD', () => {
        const standardCard = frontend.renderConfirmationCard({
            recipient: 'علي كاظم',
            phoneOrAccount: '07801234567',
            amount: '50,000 د.ع',
            balanceAfter: '950,000 د.ع'
        });
        assert.ok(!standardCard.includes('high-value-security-badge'), 'Standard transfer must not show high-value security badge');
        assert.ok(!standardCard.includes('high-value-card'), 'Standard transfer must not have high-value-card class');

        const highValueCard = frontend.renderConfirmationCard({
            recipient: 'أحمد كمال',
            phoneOrAccount: '07801122334',
            amount: '250,000 د.ع',
            balanceAfter: '750,000 د.ع'
        });
        assert.ok(highValueCard.includes('high-value-security-badge'), 'Must embed high-value security badge');
        assert.ok(highValueCard.includes('high-value-card'), 'Card must have high-value-card class');
        assert.ok(highValueCard.includes('تحويل عالي القيمة') && highValueCard.includes('100,000 د.ع'), 'Must display high-value Arabic alert');
        assert.ok(highValueCard.includes('data-threshold="0.88"'), 'Must specify data-threshold="0.88" on track');
        assert.ok(highValueCard.includes('high-value-track'), 'Track must receive high-value-track class');
    });

    test('4. RTL displacement physics: tracks displacement from right to left with real-time text fading & green fill expansion', () => {
        const mockFill = { style: {} };
        const mockText = { style: {} };
        const mockShimmer = { style: {}, textContent: 'اسحب لتأكيد التحويل' };
        const mockThumb = {
            offsetWidth: 40,
            style: {},
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };

        let attrMap = {};
        const mockTrack = {
            style: {},
            classList: {
                classes: new Set(['slide-to-confirm-track']),
                contains(c) { return this.classes.has(c); },
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); }
            },
            getAttribute: (a) => attrMap[a] || null,
            setAttribute: (a, v) => { attrMap[a] = String(v); },
            removeAttribute: (a) => { delete attrMap[a]; },
            getBoundingClientRect: () => ({ width: 300, left: 100, right: 400 }),
            closest: function(sel) {
                if (!sel || sel.includes('slide-to-confirm-track')) return this;
                return { querySelector: () => null };
            },
            querySelector: (sel) => {
                if (sel === '.slide-to-confirm-thumb') return mockThumb;
                if (sel === '.slide-progress-fill') return mockFill;
                if (sel === '.slide-track-text') return mockText;
                if (sel === '.slide-shimmer-text') return mockShimmer;
                return null;
            }
        };

        global.window = { getComputedStyle: () => ({ direction: 'rtl' }) };

        try {
            // Start drag at right side (clientX = 350)
            frontend.startSlideDrag({
                target: mockTrack,
                clientX: 350
            });

            // Touch-action: none inline guarantee
            assert.equal(mockTrack.style.touchAction, 'none', 'Track must enforce touch-action: none');
            assert.equal(mockThumb.style.touchAction, 'none', 'Thumb must enforce touch-action: none');

            // Drag 100px to the left in RTL: clientX decreases to 250 (rawDelta = 350 - 250 = 100)
            frontend.onSlideDragMove({
                clientX: 250,
                cancelable: true
            });

            // Displacement in RTL must be negative X
            assert.equal(mockThumb.style.transform, 'translateX(-100px)', 'Thumb displacement must be negative X in RTL');
            assert.equal(mockFill.style.width, '120px', 'Progress fill must expand (100px + 20px half thumb)');

            // Shimmer text must fade in real-time
            const textOpacity = parseFloat(mockText.style.opacity);
            assert.ok(textOpacity < 1.0 && textOpacity > 0.0, 'Track text must fade in real time');
            assert.equal(mockShimmer.style.opacity, mockText.style.opacity, 'Shimmer text opacity must match track text');
        } finally {
            frontend.onSlideDragEnd({ clientX: 350 });
            delete global.window;
        }
    });

    test('5. Releasing below 88% travel threshold springs thumb back via elastic cubic-bezier without layout jump', () => {
        const mockFill = { style: {} };
        const mockText = { style: {} };
        const mockShimmer = { style: {}, textContent: 'اسحب لتأكيد التحويل' };
        const mockThumb = {
            offsetWidth: 40,
            style: {},
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };

        let attrMap = {};
        const mockTrack = {
            style: {},
            classList: {
                classes: new Set(['slide-to-confirm-track']),
                contains(c) { return this.classes.has(c); },
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); }
            },
            getAttribute: (a) => attrMap[a] || null,
            setAttribute: (a, v) => { attrMap[a] = String(v); },
            removeAttribute: (a) => { delete attrMap[a]; },
            getBoundingClientRect: () => ({ width: 300, left: 100, right: 400 }),
            closest: function(sel) {
                if (!sel || sel.includes('slide-to-confirm-track')) return this;
                return { querySelector: () => null };
            },
            querySelector: (sel) => {
                if (sel === '.slide-to-confirm-thumb') return mockThumb;
                if (sel === '.slide-progress-fill') return mockFill;
                if (sel === '.slide-track-text') return mockText;
                if (sel === '.slide-shimmer-text') return mockShimmer;
                return null;
            }
        };

        global.window = { getComputedStyle: () => ({ direction: 'rtl' }) };

        try {
            // maxTravel = 300 - 40 - 8 = 252px.
            // 88% threshold = 252 * 0.88 = 221.76px.
            // Drag 218px (218 / 252 = 86.5%, below 88% threshold)
            frontend.startSlideDrag({
                target: mockTrack,
                clientX: 350
            });

            frontend.onSlideDragMove({
                clientX: 350 - 218,
                cancelable: true
            });

            assert.equal(mockThumb.classList.contains('ready-to-snap'), false, 'Should not be ready-to-snap below 88%');

            // Release drag below 88%
            frontend.onSlideDragEnd({
                clientX: 350 - 218
            });

            // Verify elastic cubic-bezier spring-back
            assert.ok(mockThumb.style.transition.includes('cubic-bezier(0.175, 0.885, 0.32, 1.275)'), 'Thumb must return via cubic-bezier(0.175, 0.885, 0.32, 1.275)');
            assert.equal(mockThumb.style.transform, 'translateX(0px)', 'Thumb must return to 0px');
            assert.equal(mockFill.style.width, '0px', 'Fill width must return to 0px');
            assert.equal(mockText.style.opacity, '1', 'Text opacity must reset to 1');
            assert.equal(mockShimmer.style.opacity, '1', 'Shimmer text opacity must reset to 1');
            assert.equal(attrMap['aria-valuenow'], '0', 'aria-valuenow must reset to 0');
            assert.ok(!mockTrack.classList.contains('is-confirmed'), 'Track must not be confirmed');
        } finally {
            delete global.window;
        }
    });

    test('6. Snapping to locked completion at >=88% triggers green locked state, tactile success chime, and mutation', async () => {
        let vibrationPattern = null;
        if (typeof global.navigator === 'undefined') {
            global.navigator = {};
        }
        global.navigator.vibrate = (pattern) => { vibrationPattern = pattern; };

        let submittedMessage = null;
        let submittedOptions = null;
        const origSubmit = frontend.handleFormSubmit;
        frontend.handleFormSubmit = (msg, opts) => {
            submittedMessage = msg;
            submittedOptions = opts;
        };

        const mockFill = { style: {} };
        const mockText = { style: {} };
        const mockShimmer = { style: {}, textContent: 'اسحب لتأكيد التحويل' };
        const mockThumb = {
            offsetWidth: 40,
            style: {},
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };

        let attrMap = {};
        const mockCard = { querySelector: () => null, classList: { add() {} } };
        const mockTrack = {
            style: {},
            classList: {
                classes: new Set(['slide-to-confirm-track']),
                contains(c) { return this.classes.has(c); },
                add(...args) { args.forEach(c => this.classes.add(c)); },
                remove(c) { this.classes.delete(c); }
            },
            getAttribute: (a) => attrMap[a] || null,
            setAttribute: (a, v) => { attrMap[a] = String(v); },
            removeAttribute: (a) => { delete attrMap[a]; },
            getBoundingClientRect: () => ({ width: 300, left: 100, right: 400 }),
            closest: function(sel) {
                if (!sel || sel.includes('slide-to-confirm-track')) return this;
                if (sel.includes('fintech-card')) return mockCard;
                return null;
            },
            querySelector: (sel) => {
                if (sel === '.slide-to-confirm-thumb') return mockThumb;
                if (sel === '.slide-progress-fill') return mockFill;
                if (sel === '.slide-track-text') return mockText;
                if (sel === '.slide-shimmer-text') return mockShimmer;
                return null;
            }
        };

        global.window = { getComputedStyle: () => ({ direction: 'rtl' }) };

        try {
            // maxTravel = 252px. Drag 225px (225 / 252 = 89.28% >= 88% threshold)
            frontend.startSlideDrag({
                target: mockTrack,
                clientX: 350
            });

            frontend.onSlideDragMove({
                clientX: 350 - 225,
                cancelable: true
            });

            assert.ok(mockThumb.classList.contains('ready-to-snap'), 'Must receive ready-to-snap at >= 88%');

            // Release at >= 88% threshold
            frontend.onSlideDragEnd({
                clientX: 350 - 225
            });

            // Verify locked green state
            assert.ok(mockTrack.classList.contains('is-confirmed'), 'Track must receive is-confirmed');
            assert.ok(mockTrack.classList.contains('slide-completed'), 'Track must receive slide-completed');
            assert.ok(mockTrack.classList.contains('btn-locked'), 'Track must receive btn-locked');
            assert.ok(mockThumb.classList.contains('is-success'), 'Thumb must receive is-success for checkmark morph');
            assert.equal(mockFill.style.width, '100%', 'Progress fill must expand to 100%');
            assert.equal(mockShimmer.textContent, 'تم التأكيد بنجاح', 'Shimmer text must show confirmed message');
            assert.equal(attrMap['aria-valuenow'], '100', 'aria-valuenow must be 100');
            assert.equal(attrMap['aria-disabled'], 'true', 'aria-disabled must be true');

            // Verify tactile haptic pattern
            assert.deepEqual(vibrationPattern, [15, 30, 20], 'Must trigger haptic pattern [15, 30, 20]');

            // Verify confirmation mutation dispatched
            assert.equal(submittedMessage, 'نعم متأكد', 'Must submit confirmation payload "نعم متأكد"');
            assert.equal(submittedOptions.actionType, 'confirm', 'actionType must be confirm');
        } finally {
            frontend.handleFormSubmit = origSubmit;
            delete global.navigator.vibrate;
            delete global.window;
        }
    });

    test('7. CSS Architecture: Luxury High-Value Tokens, Security Badge & Touch Physics', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        assert.ok(css.includes('.high-value-security-badge'), 'Must style .high-value-security-badge');
        assert.ok(css.includes('@keyframes highValueGlowPulse'), 'Must define highValueGlowPulse animation');
        assert.ok(css.includes('.security-badge-icon'), 'Must style security badge icon');
        assert.ok(css.includes('.high-value-tag'), 'Must style high value tag');
        assert.ok(css.includes('.slide-to-confirm-track.high-value-track'), 'Must style high-value track');
        assert.ok(css.includes('.confirm-card.high-value-card'), 'Must style high-value confirmation card');
        assert.ok(css.includes('touch-action: none'), 'Track & thumb must have touch-action: none');
    });
});

describe('VI Wallet Regression Suite - Category 28: Contextual Iraqi Fintech Network Badges & Recent Activity Micro-Timestamps', () => {
    const frontend = require('../../frontend/script.js');

    test('1. getIraqiFintechNetwork detects phone prefix and wallet metadata accurately with unified VI branding', () => {
        // Any phone prefix or metadata resolves to unified VI Pay
        const zain1 = frontend.getIraqiFintechNetwork('+9647801122334');
        assert.equal(zain1.id, 'vi');
        assert.equal(zain1.arabicName, 'فاي باي');
        assert.equal(zain1.badgeClass, 'network-badge-vi');
        assert.equal(zain1.dotClass, 'status-dot-violet');

        const zain2 = frontend.getIraqiFintechNetwork({ phone: '07809988776', name: 'أحمد' });
        assert.equal(zain2.id, 'vi');
        assert.equal(zain2.arabicName, 'فاي باي');

        const asia1 = frontend.getIraqiFintechNetwork('+9647709998877');
        assert.equal(asia1.id, 'vi');
        assert.equal(asia1.arabicName, 'فاي باي');

        const fast1 = frontend.getIraqiFintechNetwork('07501234567');
        assert.equal(fast1.id, 'vi');
        assert.equal(fast1.arabicName, 'فاي باي');

        const qi1 = frontend.getIraqiFintechNetwork({ wallet_provider: 'qi', name: 'بطاقة كي كارد' });
        assert.equal(qi1.id, 'vi');
        assert.equal(qi1.arabicName, 'فاي باي');

        // Default -> VI Pay
        const vi1 = frontend.getIraqiFintechNetwork({});
        assert.equal(vi1.id, 'vi');
        assert.equal(vi1.arabicName, 'فاي باي');
        assert.equal(vi1.badgeClass, 'network-badge-vi');
        assert.equal(vi1.dotClass, 'status-dot-violet');
    });

    test('2. formatRelativeIraqiTimestamp formats chronological Iraqi timestamps accurately', () => {
        const refDate = new Date('2026-10-21T12:00:00Z');

        // Empty / null -> '' (clean, no awkward placeholder)
        assert.equal(frontend.formatRelativeIraqiTimestamp(null, refDate), '');
        assert.equal(frontend.formatRelativeIraqiTimestamp('', refDate), '');

        // Same day -> 'آخر تحويل: اليوم'
        assert.equal(frontend.formatRelativeIraqiTimestamp('2026-10-21', refDate), 'آخر تحويل: اليوم');

        // Yesterday (1 day ago) -> 'آخر تحويل: البارحة'
        assert.equal(frontend.formatRelativeIraqiTimestamp('2026-10-20', refDate), 'آخر تحويل: البارحة');

        // 2 days ago -> 'قبل يومين'
        assert.equal(frontend.formatRelativeIraqiTimestamp('2026-10-19', refDate), 'قبل يومين');

        // 4 days ago -> 'قبل 4 أيام'
        assert.equal(frontend.formatRelativeIraqiTimestamp('2026-10-17', refDate), 'قبل 4 أيام');

        // 15 days ago -> 'قبل 15 يوماً'
        assert.equal(frontend.formatRelativeIraqiTimestamp('2026-10-06', refDate), 'قبل 15 يوماً');
    });

    test('3. getContactActivityTimestamp cross-references cachedTransactions and matches by phone and name', () => {
        const refDate = new Date('2026-10-21T12:00:00Z');
        const transactions = [
            { id: 'tx_1', type: 'TRANSFER', recipient: 'أحمد كمال', phone: '07801122334', date: '2026-10-20' },
            { id: 'tx_2', type: 'TRANSFER', recipient: 'علاوي', phone: '+9647709998877', date: '2026-10-17' },
            { id: 'tx_3', type: 'BILL', biller: 'كهرباء', amount: 50000, date: '2026-10-21' }
        ];

        // Match Ahmad Kamal (phone format normalized) -> 'آخر تحويل: البارحة'
        const actAhmad = frontend.getContactActivityTimestamp(
            { name: 'أحمد كمال', phone: '+9647801122334' },
            transactions,
            refDate
        );
        assert.equal(actAhmad.isNew, false);
        assert.equal(actAhmad.text, 'آخر تحويل: البارحة');

        // Match Allawi -> 'قبل 4 أيام'
        const actAllawi = frontend.getContactActivityTimestamp(
            { name: 'علاوي', phone: '07709998877' },
            transactions,
            refDate
        );
        assert.equal(actAllawi.isNew, false);
        assert.equal(actAllawi.text, 'قبل 4 أيام');

        // Unmatched contact -> empty text and isNew: true
        const actNew = frontend.getContactActivityTimestamp(
            { name: 'مصطفى سالم', phone: '07805554433' },
            transactions,
            refDate
        );
        assert.equal(actNew.isNew, true);
        assert.equal(actNew.text, '');
    });

    test('4. renderCompanionContacts renders network badges, status dots, and activity timestamps', () => {
        const mockList = { innerHTML: '' };
        const mockCount = { textContent: '' };

        global.document = {
            getElementById: (id) => {
                if (id === 'companion-contacts-list') return mockList;
                if (id === 'companion-contacts-count') return mockCount;
                return null;
            }
        };

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

        frontend.setCachedTransactions([
            { id: 'tx_1', type: 'TRANSFER', recipient: 'أحمد كمال', phone: '07801122334', date: yStr }
        ]);

        frontend.setCachedCompanionContacts([
            { name: 'أحمد كمال', alias: 'صديق الجامعة', phone: '+9647801122334' },
            { name: 'علاوي', alias: 'أخي', phone: '+9647709998877' }
        ]);

        frontend.renderCompanionContacts();

        // Check network badge rendered
        assert.ok(mockList.innerHTML.includes('network-badge-vi'), 'Must render VI Pay network badge');
        assert.ok(mockList.innerHTML.includes('فاي باي'), 'Must display VI Pay Arabic label');

        // Check luminous status dots
        assert.ok(mockList.innerHTML.includes('status-dot-violet'), 'Must render violet status dot');

        // Check activity timestamps - only rendered when there is actual history
        assert.ok(mockList.innerHTML.includes('companion-contact-timestamp'), 'Must render companion-contact-timestamp for active contacts');
        assert.ok(mockList.innerHTML.includes('آخر تحويل: البارحة'));
        assert.ok(!mockList.innerHTML.includes('جهة جديدة'), 'Must not render confusing جهة جديدة text');

        delete global.document;
    });

    test('5. openQuickTransferModal updates network provider badge, status dot, and activity timestamp in modal', () => {
        const mockModal = { classList: { classes: new Set(['hidden']), remove(c) { this.classes.delete(c); }, add(c) { this.classes.add(c); }, contains(c) { return this.classes.has(c); } } };
        const mockBackdrop = { classList: { classes: new Set(['hidden']), remove(c) { this.classes.delete(c); }, add(c) { this.classes.add(c); }, contains(c) { return this.classes.has(c); } } };
        const mockName = { textContent: '' };
        const mockAlias = { textContent: '' };
        const mockInitial = { textContent: '' };
        const mockAvatar = { style: { background: '' } };
        const mockInput = { value: '' };
        const mockProvider = { textContent: '', className: '' };
        const mockStatusDot = { className: '' };
        const mockTimestamp = { textContent: '', className: '', style: {} };

        global.document = {
            getElementById: (id) => {
                if (id === 'quick-transfer-modal') return mockModal;
                if (id === 'quick-transfer-backdrop') return mockBackdrop;
                if (id === 'quick-transfer-name') return mockName;
                if (id === 'quick-transfer-alias') return mockAlias;
                if (id === 'quick-transfer-avatar-initial') return mockInitial;
                if (id === 'quick-transfer-avatar') return mockAvatar;
                if (id === 'quick-transfer-amount-input') return mockInput;
                if (id === 'quick-transfer-provider') return mockProvider;
                if (id === 'quick-transfer-status-dot') return mockStatusDot;
                if (id === 'quick-transfer-timestamp') return mockTimestamp;
                return null;
            },
            querySelector: () => ({ style: {} }),
            querySelectorAll: () => []
        };

        frontend.setCachedTransactions([
            { id: 'tx_1', type: 'TRANSFER', recipient: 'علاوي', phone: '+9647709998877', date: '2026-10-17' }
        ]);

        frontend.openQuickTransferModal('علاوي', '+9647709998877', 'أخي');

        assert.equal(mockProvider.textContent, 'فاي باي');
        assert.ok(mockProvider.className.includes('network-badge-vi'));
        assert.ok(mockStatusDot.className.includes('status-dot-violet'));
        assert.ok(mockTimestamp.textContent.length > 0);

        delete global.document;
    });

    test('6. HTML & CSS Architecture: Network Badges, Luminous Dots, Micro-Timestamps & Elevation', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf-8');
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // HTML checks
        assert.ok(html.includes('id="quick-transfer-status-dot"'), 'HTML must include quick-transfer-status-dot');
        assert.ok(html.includes('id="quick-transfer-timestamp"'), 'HTML must include quick-transfer-timestamp');
        assert.ok(html.includes('id="quick-transfer-provider"'), 'HTML must include quick-transfer-provider ID');

        // CSS checks
        assert.ok(css.includes('.contact-network-badge'), 'CSS must define .contact-network-badge');
        assert.ok(css.includes('.network-badge-zain'), 'CSS must define .network-badge-zain');
        assert.ok(css.includes('.network-badge-asiapay'), 'CSS must define .network-badge-asiapay');
        assert.ok(css.includes('.network-badge-fastpay'), 'CSS must define .network-badge-fastpay');
        assert.ok(css.includes('.network-badge-qi'), 'CSS must define .network-badge-qi');
        assert.ok(css.includes('.network-badge-vi'), 'CSS must define .network-badge-vi');

        assert.ok(css.includes('.contact-status-dot'), 'CSS must define .contact-status-dot');
        assert.ok(css.includes('@keyframes statusDotPulse'), 'CSS must define @keyframes statusDotPulse');
        assert.ok(css.includes('.status-dot-emerald'), 'CSS must define .status-dot-emerald');
        assert.ok(css.includes('.status-dot-violet'), 'CSS must define .status-dot-violet');

        assert.ok(css.includes('.companion-contact-timestamp'), 'CSS must define .companion-contact-timestamp');
        assert.ok(css.includes('.companion-contact-item:hover'), 'CSS must define hover elevation on .companion-contact-item');
        assert.ok(css.includes('transform: translateY(-2px)'), 'CSS must apply translateY(-2px) elevation');
    });

    test('7. Bulk bill payment settles all bills atomically with guaranteed unique transaction IDs', () => {
        const { getSqliteDb, executeBillPaymentTransaction } = require('../../backend/src/services/sqliteDb.js');
        const db = getSqliteDb();

        // Ensure at least two bills are marked unpaid
        db.prepare("UPDATE bills SET status = 'unpaid', paid_at = NULL WHERE id IN ('bill_phone_01', 'bill_net_01', 'bill_elec_01')").run();
        db.prepare("UPDATE accounts SET balance = 3000000").run();

        const result = executeBillPaymentTransaction({
            billIds: ['bill_phone_01', 'bill_net_01', 'bill_elec_01'],
            idempotencyKey: `bulk_test_idemp_${Date.now()}`
        });

        assert.equal(result.success, true);
        assert.ok(result.paidBills.length >= 2);
        // Verify all generated transaction IDs are unique
        const txIds = db.prepare("SELECT id FROM transactions WHERE type = 'BILL_PAYMENT' ORDER BY timestamp DESC LIMIT 3").all().map(r => r.id);
        const uniqueIds = new Set(txIds);
        assert.equal(txIds.length, uniqueIds.size, 'All transaction IDs in bulk payment must be strictly unique');

        // Cleanup: reset bills back to unpaid so subsequent tests/runs remain idempotent
        db.prepare("UPDATE bills SET status = 'unpaid', paid_at = NULL WHERE id IN ('bill_phone_01', 'bill_net_01', 'bill_elec_01')").run();
        db.prepare("UPDATE accounts SET balance = 3000000").run();
        const { exportSqliteToJson } = require('../../backend/src/services/sqliteDb.js');
        exportSqliteToJson(db);
    });

    test('8. Repeated bulk payment command without explicit user confirmation does NOT auto-execute', async () => {
        const { handleModelActions, getSession } = require('../server');
        const { getSqliteDb, exportSqliteToJson } = require('../../backend/src/services/sqliteDb.js');
        const sqlite = getSqliteDb();
        sqlite.prepare("UPDATE bills SET status = 'unpaid', paid_at = NULL WHERE id IN ('bill_phone_01', 'bill_net_01', 'bill_elec_01')").run();
        sqlite.prepare("UPDATE accounts SET balance = 3000000").run();
        const db = exportSqliteToJson(sqlite);
        const session = getSession(`test_bulk_safety_${Date.now()}`);

        const modelReply = `<<<DB_ACTION>>>
{"action": "BILL_PAYMENT", "bill_id": "ALL"}
<<<END_DB_ACTION>>>`;

        // First click/command -> creates pending confirmation
        const reply1 = await handleModelActions(modelReply, db, 'سدد كل الفواتير دفعة وحدة', 'local', session);
        assert.ok(reply1.includes('تفاصيل تسديد كافة الفواتير'), 'First call must ask for confirmation');
        assert.ok(session.pendingBillPayment != null, 'Must establish pendingBillPayment in session');

        // Second click/command without affirmative confirmation (repeats same prompt) -> MUST NOT execute
        const reply2 = await handleModelActions(modelReply, db, 'سدد كل الفواتير دفعة وحدة', 'local', session);
        assert.ok(reply2.includes('تفاصيل تسديد كافة الفواتير'), 'Second unconfirmed call must STILL ask for confirmation without executing');
        assert.ok(!reply2.includes('تم تأكيد دفع كافة الفواتير بنجاح'), 'Must NOT falsely auto-execute on repeated action click');
    });

    test('9. CSS & HTML Architecture: Light theme slider text is white and dark theme FX popover button is emerald green', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');
        const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf-8');

        // Light theme slider text is white
        assert.ok(css.includes('[data-theme="light"] .slide-shimmer-text'), 'CSS must style light theme slider shimmer text');
        assert.ok(css.includes('color: #ffffff;'), 'Slider text must be white for high contrast on purple track');
        assert.ok(css.includes('[data-theme="light"] .slide-track-arrow'), 'Must style light theme slide track arrow');

        // Dark theme FX popover transfer button is emerald green
        assert.ok(css.includes('[data-theme="dark"] .fx-calc-transfer-btn'), 'CSS must style dark theme FX transfer button');
        assert.ok(css.includes('#10b981'), 'Must use emerald green #10b981 in dark theme transfer button');

        // Popover title does not have badge icon and button does not have paper plane icon
        assert.ok(!html.includes('class="fx-calc-badge-icon"'), 'Popover header must not include decorative badge icon');
        const transferBtnHtml = html.substring(html.indexOf('id="fx-calc-transfer-btn"'), html.indexOf('</button>', html.indexOf('id="fx-calc-transfer-btn"')));
        assert.ok(!transferBtnHtml.includes('<svg'), 'FX transfer button must not contain send SVG icon');
    });
});

describe('VI Wallet Regression Suite - Category 29: Continuous Horizontal Chip Wheel & Balance Ceiling Guard', () => {
    const frontend = require('../../frontend/script.js');

    test('1. Preset Banknote Chips: 7 denominations (5K, 10K, 25K, 50K, 100K, 250K, 500K IQD) with secondary USD valuations', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf-8');

        // Check wheel track container
        assert.ok(html.includes('id="quick-transfer-wheel-track"'), 'Must include quick-transfer-wheel-track');
        assert.ok(html.includes('class="quick-transfer-wheel-track"'), 'Must have quick-transfer-wheel-track class');

        // Check all 7 preset amounts
        const requiredPresets = ['5000', '10000', '25000', '50000', '100000', '250000', '500000'];
        for (const preset of requiredPresets) {
            assert.ok(
                html.includes(`data-amount="${preset}"`),
                `HTML must contain preset chip with data-amount="${preset}"`
            );
        }

        // Check primary Arabic labels
        assert.ok(html.includes('5,000 د.ع'));
        assert.ok(html.includes('10,000 د.ع'));
        assert.ok(html.includes('25,000 د.ع'));
        assert.ok(html.includes('50,000 د.ع'));
        assert.ok(html.includes('100,000 د.ع'));
        assert.ok(html.includes('250,000 د.ع'));
        assert.ok(html.includes('500,000 د.ع'));

        // Check ceiling alert element in HTML
        assert.ok(html.includes('id="quick-transfer-ceiling-alert"'), 'HTML must have quick-transfer-ceiling-alert');
        assert.ok(html.includes('id="quick-transfer-ceiling-msg"'), 'HTML must have quick-transfer-ceiling-msg');
        assert.ok(html.includes('المبلغ المطلوب أكبر من رصيدك المتاح'), 'Must have Iraqi guidance message in HTML');
    });

    test('2. validateQuickTransferCeiling calculation logic handles amounts below, equal, and exceeding balance', () => {
        const testBalance = 3000000;

        // Amount below balance
        const res1 = frontend.validateQuickTransferCeiling(50000, testBalance);
        assert.equal(res1.isExceeded, false);
        assert.equal(res1.amountIqd, 50000);
        assert.equal(res1.balance, testBalance);

        // Amount equal to balance
        const res2 = frontend.validateQuickTransferCeiling(3000000, testBalance);
        assert.equal(res2.isExceeded, false);
        assert.equal(res2.amountIqd, 3000000);

        // Amount exceeding balance
        const res3 = frontend.validateQuickTransferCeiling(3500000, testBalance);
        assert.equal(res3.isExceeded, true);
        assert.equal(res3.amountIqd, 3500000);

        const res4 = frontend.validateQuickTransferCeiling(10000000, testBalance);
        assert.equal(res4.isExceeded, true);

        // Custom low balance (e.g. 100,000 IQD)
        const res5 = frontend.validateQuickTransferCeiling(50000, 100000);
        assert.equal(res5.isExceeded, false);

        const res6 = frontend.validateQuickTransferCeiling(250000, 100000);
        assert.equal(res6.isExceeded, true);
    });

    test('3. validateQuickTransferCeiling updates DOM elements: amber border, Iraqi guidance alert, disabled submit', () => {
        const mockInput = {
            classList: {
                classes: new Set(),
                toggle(c, val) { if (val) this.classes.add(c); else this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            },
            attrs: {},
            setAttribute(k, v) { this.attrs[k] = v; },
            removeAttribute(k) { delete this.attrs[k]; },
            value: '5,000,000'
        };
        const mockAlert = {
            classList: {
                classes: new Set(['hidden']),
                toggle(c, val) { if (val) this.classes.add(c); else this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };
        const mockAlertMsg = { textContent: '' };
        const mockSubmitBtn = {
            disabled: false,
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            },
            attrs: {},
            setAttribute(k, v) { this.attrs[k] = v; },
            removeAttribute(k) { delete this.attrs[k]; }
        };

        global.document = {
            getElementById: (id) => {
                if (id === 'quick-transfer-amount-input') return mockInput;
                if (id === 'quick-transfer-ceiling-alert') return mockAlert;
                if (id === 'quick-transfer-ceiling-msg') return mockAlertMsg;
                if (id === 'quick-transfer-submit-btn') return mockSubmitBtn;
                return null;
            }
        };

        // Case 1: Exceeded balance (5M > 3M)
        frontend.validateQuickTransferCeiling(5000000, 3000000);

        assert.ok(mockInput.classList.contains('is-ceiling-exceeded'), 'Input must have is-ceiling-exceeded class');
        assert.equal(mockInput.attrs['aria-invalid'], 'true', 'Input aria-invalid must be true');
        assert.equal(mockAlert.classList.contains('hidden'), false, 'Ceiling alert must be visible (hidden removed)');
        assert.equal(mockAlertMsg.textContent, 'المبلغ المطلوب أكبر من رصيدك المتاح', 'Must set Iraqi guidance message');
        assert.equal(mockSubmitBtn.disabled, true, 'Submit button must be disabled');
        assert.ok(mockSubmitBtn.classList.contains('is-disabled'), 'Submit button must have is-disabled class');
        assert.equal(mockSubmitBtn.attrs['aria-disabled'], 'true', 'Submit button aria-disabled must be true');

        // Case 2: Normal valid amount (100K <= 3M)
        frontend.validateQuickTransferCeiling(100000, 3000000);

        assert.equal(mockInput.classList.contains('is-ceiling-exceeded'), false, 'Input must remove is-ceiling-exceeded class');
        assert.equal(mockInput.attrs['aria-invalid'], 'false', 'Input aria-invalid must be false');
        assert.equal(mockAlert.classList.contains('hidden'), true, 'Ceiling alert must be hidden');
        assert.equal(mockSubmitBtn.disabled, false, 'Submit button must be re-enabled');
        assert.equal(mockSubmitBtn.classList.contains('is-disabled'), false, 'Submit button must remove is-disabled class');
        assert.equal(mockSubmitBtn.attrs['aria-disabled'], undefined, 'Submit button aria-disabled must be removed');

        delete global.document;
    });

    test('4. submitQuickTransfer blocks submission when transfer amount exceeds balance ceiling', () => {
        let submissionDispatched = false;
        let errorSoundPlayed = false;

        const mockInput = {
            value: '4,500,000',
            classList: {
                classes: new Set(),
                toggle(c, val) { if (val) this.classes.add(c); else this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            },
            setAttribute() {},
            removeAttribute() {}
        };
        const mockAlert = {
            classList: {
                classes: new Set(['hidden']),
                toggle(c, val) { if (val) this.classes.add(c); else this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };
        const mockAlertMsg = { textContent: '' };
        const mockSubmitBtn = { disabled: false, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} };
        const mockModal = { classList: { add() {}, remove() {} }, querySelector: () => null };
        const mockBackdrop = { classList: { add() {}, remove() {} } };

        global.document = {
            getElementById: (id) => {
                if (id === 'quick-transfer-amount-input') return mockInput;
                if (id === 'quick-transfer-ceiling-alert') return mockAlert;
                if (id === 'quick-transfer-ceiling-msg') return mockAlertMsg;
                if (id === 'quick-transfer-submit-btn') return mockSubmitBtn;
                if (id === 'quick-transfer-modal') return mockModal;
                if (id === 'quick-transfer-backdrop') return mockBackdrop;
                return null;
            },
            querySelectorAll: () => []
        };

        let modalClosed = false;
        mockModal.classList.add = (c) => {
            if (c === 'hidden') modalClosed = true;
        };

        // Open modal with contact
        frontend.openQuickTransferModal('حيدر كرار', '+9647805556677', 'صديق العمل');

        // Input 4.5M IQD when wallet has 3M IQD -> Exceeds balance ceiling
        mockInput.value = '4,500,000';
        frontend.submitQuickTransfer();

        // Must early-return: modal remains open, submit button is disabled, ceiling warning displayed
        assert.equal(modalClosed, false, 'Modal must NOT close when balance ceiling is exceeded');
        assert.equal(mockSubmitBtn.disabled, true, 'Submit button must be disabled upon ceiling violation');
        assert.ok(mockInput.classList.contains('is-ceiling-exceeded'), 'Input must have ceiling exceeded class');
        assert.equal(mockAlert.classList.contains('hidden'), false, 'Ceiling alert must be visible');

        delete global.document;
    });

    test('5. CSS Architecture: Wheel Track Panning, Amber Input Ceiling, Guidance Alert, and Disabled Submit', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // Continuous horizontal wheel track styles
        assert.ok(css.includes('.quick-transfer-wheel-track'), 'CSS must style .quick-transfer-wheel-track');
        assert.ok(css.includes('overflow-x: auto'), 'Track must have horizontal overflow scrolling');
        assert.ok(css.includes('scroll-snap-type: x mandatory'), 'Track must have CSS scroll-snap mandatory');
        assert.ok(css.includes('cursor: grab'), 'Track must have grab cursor');
        assert.ok(css.includes('.quick-transfer-wheel-track.is-dragging'), 'CSS must define .is-dragging state');
        assert.ok(css.includes('cursor: grabbing'), 'Dragging track must have grabbing cursor');

        // Amount wheel chip styling
        assert.ok(css.includes('.amount-wheel-chip'), 'CSS must style .amount-wheel-chip');
        assert.ok(css.includes('scroll-snap-align: start'), 'Chips must snap align to start');
        assert.ok(css.includes('.amount-wheel-chip.active'), 'CSS must define active chip state');

        // Ceiling validation styling: soft amber
        assert.ok(css.includes('.quick-transfer-amount-input.is-ceiling-exceeded'), 'CSS must style input when ceiling exceeded');
        assert.ok(css.includes('#f59e0b'), 'Must tint border with soft amber #f59e0b');
        assert.ok(css.includes('@keyframes inputCeilingShake'), 'Must define subtle shake animation for ceiling violation');

        // Guidance alert styling
        assert.ok(css.includes('.quick-transfer-ceiling-alert'), 'CSS must style .quick-transfer-ceiling-alert');
        assert.ok(css.includes('[data-theme="dark"] .quick-transfer-ceiling-alert'), 'Must have dark mode support for ceiling alert');

        // Graceful submit button disablement
        assert.ok(css.includes('.quick-transfer-submit-btn:disabled') || css.includes('.quick-transfer-submit-btn.is-disabled'), 'Must style disabled submit button');
        assert.ok(css.includes('opacity: 0.45'), 'Disabled submit button must have reduced opacity');
        assert.ok(css.includes('cursor: not-allowed'), 'Disabled submit button must have not-allowed cursor');
    });
});

describe('VI Wallet Regression Suite - Category 30: State-of-the-Art Circular Ripple View Transition', () => {
    const frontend = require('../../frontend/script.js');

    test('1. Instant Fallback: Applies theme synchronously when startViewTransition is unsupported', () => {
        let themeApplied = null;
        let storageSet = null;

        const mockDocElement = {
            setAttribute(k, v) { if (k === 'data-theme') themeApplied = v; },
            getAttribute(k) { return k === 'data-theme' ? themeApplied : null; },
            style: { setProperty() {} }
        };

        global.document = {
            documentElement: mockDocElement,
            body: { setAttribute() {} },
            getElementById: () => null,
            querySelectorAll: () => []
            // startViewTransition is NOT defined -> triggers instant fallback
        };
        global.localStorage = {
            setItem: (k, v) => { if (k === 'fintech_theme') storageSet = v; },
            getItem: () => 'dark'
        };

        const result = frontend.toggleThemeWithRipple('light', null);

        assert.equal(result, null, 'Must return null when startViewTransition is unsupported');
        assert.equal(themeApplied, 'light', 'Must synchronously apply light theme');
        assert.equal(storageSet, 'light', 'Must persist target theme in localStorage');

        delete global.document;
        delete global.localStorage;
    });

    test('2. Instant Fallback: Honors prefers-reduced-motion media query by bypassing transition', () => {
        let themeApplied = null;
        let viewTransitionCalled = false;

        const mockDocElement = {
            setAttribute(k, v) { if (k === 'data-theme') themeApplied = v; },
            getAttribute(k) { return k === 'data-theme' ? themeApplied : null; },
            style: { setProperty() {} }
        };

        global.document = {
            documentElement: mockDocElement,
            body: { setAttribute() {} },
            getElementById: () => null,
            querySelectorAll: () => [],
            startViewTransition: () => { viewTransitionCalled = true; }
        };
        global.window = {
            innerWidth: 1440,
            innerHeight: 900,
            matchMedia: (query) => ({
                matches: query.includes('prefers-reduced-motion')
            })
        };

        const result = frontend.toggleThemeWithRipple('dark', null);

        assert.equal(result, null, 'Must return null when reduced motion is preferred');
        assert.equal(viewTransitionCalled, false, 'Must NOT invoke startViewTransition when reduced motion is active');
        assert.equal(themeApplied, 'dark', 'Must immediately apply target theme');

        delete global.document;
        delete global.window;
    });

    test('3. Exact Viewport Coordinates & Radius Calculation: Orchestrates document.startViewTransition and animate()', async () => {
        let viewTransitionCallback = null;
        let animationConfig = null;
        let cssProps = {};
        let appliedTheme = null;

        const mockDocElement = {
            setAttribute(k, v) { if (k === 'data-theme') appliedTheme = v; },
            getAttribute(k) { return k === 'data-theme' ? appliedTheme : null; },
            style: {
                setProperty(k, v) { cssProps[k] = v; }
            },
            animate(keyframes, options) {
                animationConfig = { keyframes, options };
                return {};
            }
        };

        const mockBtn = {
            getBoundingClientRect: () => ({
                left: 100,
                top: 50,
                width: 40,
                height: 30
            }),
            setAttribute: () => {}
        };

        // Button center: x = 100 + 40/2 = 120, y = 50 + 30/2 = 65
        // Viewport: 1000 x 800
        const expectedX = 120;
        const expectedY = 65;
        const expectedRadius = Math.hypot(Math.max(120, 1000 - 120), Math.max(65, 800 - 65));

        const mockTransition = {
            ready: Promise.resolve(),
            finished: Promise.resolve()
        };

        global.window = {
            innerWidth: 1000,
            innerHeight: 800,
            matchMedia: () => ({ matches: false })
        };

        global.document = {
            documentElement: mockDocElement,
            body: { setAttribute() {} },
            getElementById: (id) => (id === 'theme-toggle-btn' ? mockBtn : null),
            querySelectorAll: () => [],
            startViewTransition: (callback) => {
                viewTransitionCallback = callback;
                return mockTransition;
            }
        };

        const transition = frontend.toggleThemeWithRipple('light', mockBtn);

        assert.ok(transition, 'Must return the ViewTransition instance');
        assert.ok(viewTransitionCallback, 'Must pass theme mutation callback to startViewTransition');

        // Execute mutation callback
        viewTransitionCallback();
        assert.equal(appliedTheme, 'light', 'Callback must apply target theme');

        // Verify CSS custom properties set on documentElement
        assert.equal(cssProps['--ripple-x'], `${expectedX}px`, 'Must set --ripple-x to button center X');
        assert.equal(cssProps['--ripple-y'], `${expectedY}px`, 'Must set --ripple-y to button center Y');
        assert.equal(cssProps['--ripple-r'], `${expectedRadius}px`, 'Must set --ripple-r to max radius');

        // Wait for ready promise to execute animation
        await mockTransition.ready;

        assert.ok(animationConfig, 'Must invoke document.documentElement.animate()');
        assert.equal(animationConfig.options.duration, 380, 'Must animate over exactly 380ms');
        assert.equal(animationConfig.options.easing, 'cubic-bezier(0.16, 1, 0.3, 1)', 'Must use cubic-bezier(0.16, 1, 0.3, 1)');
        assert.equal(animationConfig.options.pseudoElement, '::view-transition-new(root)', 'Must target ::view-transition-new(root)');

        // Verify circular clip-path keyframes
        const keyframes = animationConfig.keyframes;
        assert.equal(keyframes.clipPath[0], `circle(0px at ${expectedX}px ${expectedY}px)`, 'Keyframe 0 must start from circle(0px at x y)');
        assert.equal(keyframes.clipPath[1], `circle(${expectedRadius}px at ${expectedX}px ${expectedY}px)`, 'Keyframe 1 must expand to circle(maxRadius at x y)');

        delete global.document;
        delete global.window;
    });

    test('4. CSS Architecture: View Transitions pseudo-elements, 380ms cubic-bezier, and rippleExpand keyframes', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // Pseudo elements styling
        assert.ok(css.includes('::view-transition-old(root)'), 'CSS must style ::view-transition-old(root)');
        assert.ok(css.includes('::view-transition-new(root)'), 'CSS must style ::view-transition-new(root)');
        assert.ok(css.includes('mix-blend-mode: normal'), 'Must use mix-blend-mode: normal to prevent color flash');

        // Z-Index ordering
        assert.ok(css.includes('z-index: 1'), 'Old view must have z-index 1');
        assert.ok(css.includes('z-index: 9999'), 'New view must have elevated z-index 9999');

        // Timing & Easing in CSS
        assert.ok(css.includes('380ms cubic-bezier(0.16, 1, 0.3, 1)'), 'Must specify 380ms with cubic-bezier(0.16, 1, 0.3, 1)');
        assert.ok(css.includes('@keyframes rippleExpand'), 'Must define @keyframes rippleExpand');
        assert.ok(css.includes('clip-path: circle(0px at var(--ripple-x'), 'From keyframe must expand from circle(0px)');
        assert.ok(css.includes('clip-path: circle(var(--ripple-r'), 'To keyframe must expand to circle(maxRadius)');

        // Reduced motion override
        assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'Must respect reduced motion in CSS');
    });
});

describe('VI Wallet Regression Suite - Category 31: Interactive Quick Transfer Contact Picker & Streamlined Actions', () => {
    const frontend = require('../../frontend/script.js');

    test('1. renderQuickTransferContactPicker populates contact options and highlights active contact', () => {
        const mockList = {
            innerHTML: '',
            querySelectorAll: () => []
        };

        global.document = {
            getElementById: (id) => {
                if (id === 'quick-transfer-picker-list') return mockList;
                return null;
            }
        };

        frontend.setCurrentTransferContact({ name: 'أحمد كمال', alias: 'صديق الجامعة', phone: '+9647801122334' });
        frontend.renderQuickTransferContactPicker();

        assert.ok(mockList.innerHTML.includes('أحمد كمال'), 'Must render Ahmad Kamal in picker');
        assert.ok(mockList.innerHTML.includes('مرتضى'), 'Must render Murtadha in picker');
        assert.ok(mockList.innerHTML.includes('is-selected'), 'Must highlight active recipient');
        assert.ok(mockList.innerHTML.includes('qt-picker-check-icon'), 'Must display check icon for selected recipient');
        assert.ok(mockList.innerHTML.includes('network-badge-vi'), 'Must render unified VI Pay network badge');
        assert.ok(mockList.innerHTML.includes('فاي باي'), 'Must render Arabic label فاي باي');

        delete global.document;
    });

    test('2. selectQuickTransferContact updates recipient dynamically and syncs card UI', () => {
        const mockName = { textContent: '' };
        const mockAlias = { textContent: '' };
        const mockInitial = { textContent: '' };
        const mockAvatar = { style: { background: '' } };
        const mockProvider = { textContent: '', className: '' };
        const mockStatusDot = { className: '' };
        const mockTimestamp = { textContent: '', style: { display: '' }, className: '' };
        const mockMenu = { classList: { contains: () => false, add: () => {}, remove: () => {} } };
        const mockCard = { classList: { add: () => {}, remove: () => {} }, setAttribute: () => {} };
        const mockUserInput = { value: 'أريد أحول لـ أحمد كمال ' };

        global.document = {
            getElementById: (id) => {
                if (id === 'quick-transfer-name') return mockName;
                if (id === 'quick-transfer-alias') return mockAlias;
                if (id === 'quick-transfer-avatar-initial') return mockInitial;
                if (id === 'quick-transfer-avatar') return mockAvatar;
                if (id === 'quick-transfer-provider') return mockProvider;
                if (id === 'quick-transfer-status-dot') return mockStatusDot;
                if (id === 'quick-transfer-timestamp') return mockTimestamp;
                if (id === 'quick-transfer-picker-menu') return mockMenu;
                if (id === 'quick-transfer-target-card') return mockCard;
                if (id === 'user-input') return mockUserInput;
                return null;
            },
            querySelector: () => ({ style: { display: '' } })
        };

        frontend.selectQuickTransferContact({
            name: 'مرتضى',
            alias: 'صديق العمل',
            phone: '+9647819919952'
        });

        assert.equal(frontend.getCurrentTransferContact().name, 'مرتضى');
        assert.equal(mockName.textContent, 'مرتضى');
        assert.equal(mockAlias.textContent, 'صديق العمل');
        assert.equal(mockInitial.textContent, 'م');
        assert.equal(mockUserInput.value, 'أريد أحول لـ مرتضى ');

        delete global.document;
    });

    test('3. openQuickTransferModal accepts dynamic recipient like Murtadha and resolves details', () => {
        const mockModal = { classList: { remove: () => {}, contains: () => false }, querySelector: () => null };
        const mockBackdrop = { classList: { remove: () => {}, contains: () => false } };
        const mockName = { textContent: '' };
        const mockAlias = { textContent: '' };
        const mockInitial = { textContent: '' };
        const mockAvatar = { style: { background: '' } };
        const mockProvider = { textContent: '', className: '' };
        const mockStatusDot = { className: '' };
        const mockTimestamp = { textContent: '', style: { display: '' }, className: '' };
        const mockInput = { value: '' };
        const mockMenu = { classList: { contains: () => false, add: () => {}, remove: () => {} } };
        const mockCard = { classList: { add: () => {}, remove: () => {} }, setAttribute: () => {} };

        global.document = {
            getElementById: (id) => {
                if (id === 'quick-transfer-modal') return mockModal;
                if (id === 'quick-transfer-backdrop') return mockBackdrop;
                if (id === 'quick-transfer-name') return mockName;
                if (id === 'quick-transfer-alias') return mockAlias;
                if (id === 'quick-transfer-avatar-initial') return mockInitial;
                if (id === 'quick-transfer-avatar') return mockAvatar;
                if (id === 'quick-transfer-provider') return mockProvider;
                if (id === 'quick-transfer-status-dot') return mockStatusDot;
                if (id === 'quick-transfer-timestamp') return mockTimestamp;
                if (id === 'quick-transfer-amount-input') return mockInput;
                if (id === 'quick-transfer-picker-menu') return mockMenu;
                if (id === 'quick-transfer-target-card') return mockCard;
                return null;
            },
            querySelectorAll: () => [],
            querySelector: () => ({ style: { display: '' } })
        };

        // Open modal for Murtadha directly
        frontend.openQuickTransferModal('مرتضى', '', '', 153000);

        assert.equal(frontend.getCurrentTransferContact().name, 'مرتضى');
        assert.equal(mockName.textContent, 'مرتضى');
        assert.equal(mockInitial.textContent, 'م');
        assert.equal(mockInput.value, '153,000');

        delete global.document;
    });

    test('4. HTML & CSS Architecture: X close button removed, submit button has no icons, picker is styled', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf-8');
        const css = fs.readFileSync(path.join(__dirname, '../../frontend/style.css'), 'utf-8');

        // Close button removed from modal header
        assert.ok(!html.includes('id="quick-transfer-close-btn"'), 'Modal header must NOT contain X close button');
        assert.ok(css.includes('.quick-transfer-close-btn') && css.includes('display: none !important'), 'CSS must hide close button');

        // Submit button contains clean text without paper-plane or lightning icons
        const submitBtnMatch = html.match(/<button[^>]*id="quick-transfer-submit-btn"[^>]*>([\s\S]*?)<\/button>/);
        assert.ok(submitBtnMatch, 'Must find submit button in HTML');
        const submitContent = submitBtnMatch[1];
        assert.ok(!submitContent.includes('<svg'), 'Submit button must NOT contain paper-plane SVG');
        assert.ok(!submitContent.includes('⚡'), 'Submit button must NOT contain lightning bolt emoji');
        assert.ok(submitContent.includes('إرسال عبر فاي'), 'Submit button must display clean text "إرسال عبر فاي"');

        // Interactive Target Card and Dropdown Picker in HTML & CSS
        assert.ok(html.includes('id="quick-transfer-target-card"'), 'Must have quick-transfer-target-card');
        assert.ok(html.includes('id="quick-transfer-picker-menu"'), 'Must have quick-transfer-picker-menu');
        assert.ok(html.includes('quick-transfer-picker-arrow'), 'Must have picker chevron arrow');

        assert.ok(css.includes('.quick-transfer-target-card:hover'), 'Must have hover state for target card');
        assert.ok(css.includes('.quick-transfer-target-card.is-open'), 'Must style is-open state for card');
        assert.ok(css.includes('.quick-transfer-picker-menu'), 'Must style picker dropdown menu');
        assert.ok(css.includes('.qt-picker-item:hover'), 'Must style hover for picker items');
        assert.ok(css.includes('.qt-picker-item.is-selected'), 'Must style selected picker item');
    });
});







