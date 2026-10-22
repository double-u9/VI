const {
    isBalanceInquiry,
    isTransactionsInquiry,
    isContactsListInquiry,
    isUserCancellation,
    isUserConfirmation,
    isBillInquiry,
    detectBillPaymentIntent,
    findMatchingBill,
    isContactCreationIntent,
    extractUserPhoneCandidates,
    extractContactNameFromMessage,
    isDisambiguationAbandonment,
    resolveContactSelection,
    extractAmount,
    findAmbiguousContacts,
    handleContactInquiry,
    handleDirectTransferIntent,
    isStandaloneNumberedChoice,
    normalizeArabic,
    evaluateHybridIntent
} = require('../services/nlpRouter');

const {
    readDatabase,
    executeTransferMutation,
    executeBillPaymentMutation,
    addContactMutation,
    handleModelActions
} = require('../services/walletService');

const {
    getSession,
    recordSessionTurn,
    appendToConversationHistory,
    persistSessionsToDisk
} = require('../services/sessionStore');

const { callUnifiedChatCompletion } = require('../services/llmService');
const { PROVIDERS, DEFAULT_SESSION_ID, DB_FILE_PATH } = require('../config/providers');
const { buildSystemPrompt } = require('../prompts/systemPrompt');
const { SlidingWindowTokenParser, initSseStream, writeSseEvent } = require('../services/streamParser');

/**
 * Universal Response Dispatcher
 * Sends standard JSON when isStream is false (for 100% test & backward compatibility)
 * Emits SSE token + done events when isStream is true
 */
function sendChatResponse(res, isStream, { response, openTransactionsDrawer = false, action = null }) {
    persistSessionsToDisk();
    if (!isStream) {
        return res.json({
            response,
            ...(openTransactionsDrawer && { openTransactionsDrawer: true })
        });
    }

    initSseStream(res);
    writeSseEvent(res, 'token', { token: response });
    if (action) {
        writeSseEvent(res, 'action', action);
    }
    writeSseEvent(res, 'done', {
        fullResponse: response,
        openTransactionsDrawer: Boolean(openTransactionsDrawer)
    });
    res.end();
}

async function handleChat(req, res) {
    const userMessage = req.body?.message;
    const selectedProvider = req.body?.provider || req.body?.model || 'local';
    const sessionId = req.sessionId || req.headers['x-session-id'] || req.body?.sessionId || DEFAULT_SESSION_ID;
    const session = req.session || getSession(sessionId);
    const idempotencyKey = req.idempotencyKey || req.headers['x-idempotency-key'] || req.headers['idempotency-key'] || req.body?.idempotencyKey || req.body?.idempotency_key || null;

    const isStreamRequest = Boolean(
        req.body?.stream === true ||
        (typeof req.headers['accept'] === 'string' && req.headers['accept'].includes('text/event-stream'))
    );

    if (!userMessage) {
        if (isStreamRequest) {
            initSseStream(res);
            writeSseEvent(res, 'error', { error: 'Message field is required.' });
            return res.end();
        }
        return res.status(400).json({ error: 'Message field is required.' });
    }

    console.log(`\n======================================================`);
    console.log(`📩 [Incoming User Message]: "${userMessage}"`);
    console.log(`⚙️  [Selected Provider]: "${selectedProvider}" (${PROVIDERS[selectedProvider]?.name || selectedProvider}) [Stream: ${isStreamRequest}]`);
    console.log(`🆔 [Session ID]: "${sessionId}"`);
    console.log(`======================================================`);

    try {
        const db = readDatabase();

        // Track authentic user-provided phone numbers strictly from the current incoming user message
        const userPhones = extractUserPhoneCandidates(userMessage);
        if (userPhones.length === 1) {
            session.lastUserPhoneCandidate = {
                phone: userPhones[0],
                source: 'USER_INPUT',
                timestamp: Date.now()
            };
            session.recentUserPhoneCandidates = [userPhones[0]];
        } else if (userPhones.length > 1) {
            session.lastUserPhoneCandidate = null;
            session.recentUserPhoneCandidates = userPhones;
        }

        // 0. Direct Balance Inquiry (ALWAYS from disk - Never hallucinated)
        if (isBalanceInquiry(userMessage)) {
            if (session.pendingDisambiguation) {
                session.pendingDisambiguation = null;
            }
            let reply = `رصيدك الحالي بمحفظتك هسة هو: ${db.user.balance.toLocaleString()} ${db.user.currency || 'IQD'}.`;
            if (session.pendingBillPayment) {
                reply += `\n\n(ملاحظة: عندك طلب معلق لتسديد فاتورة بقيمة ${session.pendingBillPayment.totalAmount.toLocaleString()} د.ع. إذا تريد تكمل كلي "نعم" أو "إلغاء").`;
            } else if (session.pendingTransfer) {
                reply += `\n\n(ملاحظة: عندك طلب معلق لتحويل ${session.pendingTransfer.amount.toLocaleString()} د.ع إلى ${session.pendingTransfer.recipient}. إذا تريد تكمل كلي "نعم" أو "إلغاء").`;
            }
            recordSessionTurn(session, userMessage, reply);
            return sendChatResponse(res, isStreamRequest, { response: reply });
        }

        // 0b. Direct Transactions History Inquiry (from disk - Always 100% accurate)
        if (isTransactionsInquiry(userMessage)) {
            if (session.pendingDisambiguation) {
                session.pendingDisambiguation = null;
            }
            const trxs = db.recent_transactions || [];
            let reply = '';
            if (trxs.length === 0) {
                reply = 'ما عندك أي معاملات مسجلة بالسجل حتى الآن بمحفظتك.';
            } else {
                const list = trxs.slice(0, 5).map((t, i) => {
                    const typeText = t.type === 'TRANSFER' ? `تحويل إلى ${t.recipient}` : `دفع فاتورة ${t.biller}`;
                    return `${i + 1}. ${typeText} بمبلغ ${Number(t.amount).toLocaleString()} د.ع بتاريخ ${t.date} (${t.status === 'SUCCESS' ? 'ناجحة ✅' : t.status})`;
                }).join('\n');
                reply = `هاي قائمة بآخر المعاملات المسجلة بمحفظتك:\n\n${list}\n\n💡 تكدر تفتح "السجل" من أعلى الشاشة حتى تشوف كافة التفاصيل والإحصائيات الكاملة!`;
            }
            recordSessionTurn(session, userMessage, reply);
            return sendChatResponse(res, isStreamRequest, { response: reply, openTransactionsDrawer: true });
        }

        // 0c. Direct Contacts List Inquiry (from disk - Always 100% accurate)
        if (isContactsListInquiry(userMessage)) {
            if (session.pendingDisambiguation) {
                session.pendingDisambiguation = null;
            }
            const contacts = db.contacts || [];
            let reply = '';
            if (contacts.length === 0) {
                reply = 'ما عندك أي جهات اتصال مسجلة بمحفظتك حالياً.';
            } else {
                const list = contacts.map((c, i) => `${i + 1}. ${c.alias || c.name} (${c.phone})`).join('\n');
                reply = `هاي قائمة بجهات الاتصال المسجلة بمحفظتك:\n\n${list}\n\n💡 تكدر تختار أي شخص منهم وتكلي: "حول 50 الف لسيف" أو "حول 25 الف لأحمد".`;
            }
            recordSessionTurn(session, userMessage, reply);
            return sendChatResponse(res, isStreamRequest, { response: reply });
        }

        // 1. Check for cancellation at any point
        if (isUserCancellation(userMessage)) {
            if (session.pendingTransfer || session.pendingDisambiguation || session.pendingBillPayment || session.pendingTransferRecipient || session.pendingContactCreation) {
                console.log('\n❌ [Operation Cancelled by User]');
                session.pendingTransfer = null;
                session.pendingDisambiguation = null;
                session.pendingBillPayment = null;
                session.pendingTransferRecipient = null;
                session.pendingContactCreation = null;
                session.lastUserPhoneCandidate = null;
                session.recentUserPhoneCandidates = [];
                const reply = 'صار عيوني، تم إلغاء العملية وما انخصم أي فلس من رصيدك.';
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            } else {
                const reply = 'صار عيوني، ماكو أي عملية معلقة حالياً حتى ألغيها بمحفظتك.';
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            }
        }

        // 2. Check if user is confirming an existing pending bill payment
        if (session.pendingBillPayment && isUserConfirmation(userMessage)) {
            try {
                const billParams = {
                    billIds: session.pendingBillPayment.bills ? session.pendingBillPayment.bills.map(b => b.id) : (session.pendingBillPayment.billIds || []),
                    idempotency_key: idempotencyKey || session.pendingBillPayment.idempotency_key || null,
                    sessionId
                };
                const result = executeBillPaymentMutation(billParams);
                const completed = session.pendingBillPayment;
                session.pendingBillPayment = null;

                console.log(`\n======================================================`);
                console.log(`✅ [TRANSACTION EXECUTED & SAVED TO DATABASE]`);
                console.log(`Transaction Type: BILL PAYMENT`);
                if (completed.type === 'ALL') {
                    console.log(`Paid Bills Count: ${completed.bills.length}`);
                    completed.bills.forEach(b => console.log(`   • ${b.biller} (${b.account_number}): ${b.amount.toLocaleString()} IQD`));
                } else {
                    const bill = completed.bills[0];
                    console.log(`Biller: ${bill.biller}`);
                    console.log(`Account Number: ${bill.account_number}`);
                }
                console.log(`Total Paid: ${result.totalAmount.toLocaleString()} IQD`);
                console.log(`New Wallet Balance: ${result.newBalance.toLocaleString()} IQD`);
                console.log(`Database File: ${DB_FILE_PATH}`);
                console.log(`======================================================\n`);

                let reply = '';
                if (completed.type === 'ALL') {
                    reply = `تم تأكيد دفع كافة الفواتير بنجاح! ✅\nتم تسديد ${completed.bills.length} فواتير بمجموع ${result.totalAmount.toLocaleString()} د.ع.\nرصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
                } else {
                    const bill = completed.bills[0];
                    reply = `تم تأكيد دفع الفاتورة بنجاح! ✅\nتم تسديد ${result.totalAmount.toLocaleString()} د.ع لحساب (${bill.biller} - ${bill.account_number}).\nرصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
                }

                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, {
                    response: reply,
                    action: { type: 'BILL_PAYMENT', result }
                });
            } catch (mutationErr) {
                session.pendingBillPayment = null;
                console.error('[Bill Payment Error]:', mutationErr.message);
                const errorReply = `تعذر إتمام دفع الفاتورة: ${mutationErr.message}`;
                recordSessionTurn(session, userMessage, errorReply);
                return sendChatResponse(res, isStreamRequest, { response: errorReply });
            }
        }

        // 3. Check if user is confirming an existing pending transfer
        if (session.pendingTransfer && isUserConfirmation(userMessage)) {
            try {
                const transferParams = {
                    ...session.pendingTransfer,
                    idempotency_key: idempotencyKey || session.pendingTransfer.idempotency_key || null,
                    sessionId
                };
                const result = executeTransferMutation(transferParams);
                const completedTrx = session.pendingTransfer;
                session.pendingTransfer = null;
                session.pendingDisambiguation = null;

                console.log(`\n======================================================`);
                console.log(`✅ [TRANSACTION EXECUTED & SAVED TO DATABASE]`);
                console.log(`Transaction Type: TRANSFER`);
                console.log(`Recipient: ${completedTrx.recipient} (${completedTrx.phone})`);
                console.log(`Transfer Amount: ${completedTrx.amount.toLocaleString()} IQD`);
                console.log(`New Wallet Balance: ${result.newBalance.toLocaleString()} IQD`);
                console.log(`Database File: ${DB_FILE_PATH}`);
                console.log(`======================================================\n`);

                const targetDisplay = (completedTrx.recipient.includes(completedTrx.phone) || !completedTrx.phone)
                    ? completedTrx.recipient
                    : `${completedTrx.recipient} (${completedTrx.phone})`;
                const reply = `تم تأكيد التحويل بنجاح! دزيت ${completedTrx.amount.toLocaleString()} د.ع إلى ${targetDisplay}. رصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, {
                    response: reply,
                    action: { type: 'TRANSFER', result }
                });
            } catch (mutationErr) {
                session.pendingTransfer = null;
                console.error('[Transfer Error]:', mutationErr.message);
                const errorReply = `تعذر إتمام التحويل: ${mutationErr.message}`;
                recordSessionTurn(session, userMessage, errorReply);
                return sendChatResponse(res, isStreamRequest, { response: errorReply });
            }
        }

        // 3b. Check if user is resolving a pending contact creation waiting for a name
        if (session.pendingContactCreation) {
            const rawName = userMessage.replace(/^(باسم|سميه|اسمه|اسم)\s+/i, '').trim();
            if (rawName && rawName.length >= 2 && !isDisambiguationAbandonment(userMessage)) {
                const targetPhone = session.pendingContactCreation.phone;
                const normPhone = targetPhone.replace(/\D/g, '').slice(-10);
                const normName = normalizeArabic(rawName);

                const existingContact = (db.contacts || []).find(c => {
                    const cPhone = (c.phone || '').replace(/\D/g, '').slice(-10);
                    const cName = normalizeArabic(c.name || '');
                    return cPhone === normPhone || cName === normName;
                });

                session.pendingContactCreation = null;
                session.lastUserPhoneCandidate = null;
                session.recentUserPhoneCandidates = [];
                session.pendingTransferRecipient = null;

                if (existingContact) {
                    const isSamePhone = (existingContact.phone || '').replace(/\D/g, '').slice(-10) === normPhone;
                    const warnReply = isSamePhone
                        ? `هذا الرقم (${targetPhone}) مسجل مسبقاً بمحفظتك باسم "${existingContact.name}".`
                        : `الاسم "${rawName}" مسجل مسبقاً بمحفظتك برقم (${existingContact.phone}).`;
                    recordSessionTurn(session, userMessage, warnReply);
                    return sendChatResponse(res, isStreamRequest, { response: warnReply });
                }

                addContactMutation({
                    name: rawName,
                    phone: targetPhone,
                    alias: rawName,
                    wallet_provider: 'VI'
                });

                const reply = `تدلل عيوني! تم حفظ "${rawName}" برقم (${targetPhone}) في جهات اتصال محفظتك بنجاح. ✅`;
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, {
                    response: reply,
                    action: { type: 'ADD_CONTACT', name: rawName, phone: targetPhone }
                });
            } else {
                session.pendingContactCreation = null;
                session.lastUserPhoneCandidate = null;
                session.recentUserPhoneCandidates = [];
            }
        }

        // 4. Check if user is inquiring about bills
        if (isBillInquiry(userMessage)) {
            const unpaid = (db.bills || []).filter(b => b.status === 'unpaid');
            if (unpaid.length === 0) {
                const reply = 'ما عندك أي فواتير غير مدفوعة حالياً بمحفظتك، كل فواتيرك مسددة بالكامل! ✅';
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            }

            const totalUnpaid = unpaid.reduce((sum, b) => sum + Number(b.amount || 0), 0);
            const list = unpaid.map((b, i) => `${i + 1}. ${b.biller} (رقم الحساب: ${b.account_number}) - المبلغ: ${b.amount.toLocaleString()} د.ع`).join('\n');
            const reply = `عندك ${unpaid.length} فواتير غير مدفوعة حالياً بمحفظتك:\n${list}\n\nالمجموع الكلي: ${totalUnpaid.toLocaleString()} د.ع.\n\nتريد تسدد أي وحدة منها؟ تكدر تكلي: "ادفع مال كهرباء" أو "ادفع رقم 1" أو "ادفع كل الفواتير".`;
            recordSessionTurn(session, userMessage, reply);
            return sendChatResponse(res, isStreamRequest, { response: reply });
        }

        // 5. Check if user wants to pay ALL bills or a SPECIFIC bill
        const billIntent = detectBillPaymentIntent(userMessage, db.bills);
        if (billIntent) {
            if (billIntent.type === 'ALL') {
                const unpaid = (db.bills || []).filter(b => b.status === 'unpaid');
                if (unpaid.length === 0) {
                    const reply = 'ما عندك أي فواتير غير مدفوعة حالياً بمحفظتك، كل فواتيرك مسددة بالكامل! ✅';
                    recordSessionTurn(session, userMessage, reply);
                    return sendChatResponse(res, isStreamRequest, { response: reply });
                }

                const totalAmount = unpaid.reduce((sum, b) => sum + Number(b.amount || 0), 0);
                if (db.user.balance < totalAmount) {
                    const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع كل الفواتير البالغة ${totalAmount.toLocaleString()} د.ع.`;
                    recordSessionTurn(session, userMessage, reply);
                    return sendChatResponse(res, isStreamRequest, { response: reply });
                }

                session.pendingBillPayment = {
                    type: 'ALL',
                    billIds: unpaid.map(b => b.id),
                    totalAmount: totalAmount,
                    bills: unpaid
                };

                const remainingBal = db.user.balance - totalAmount;
                const billsBreakdown = unpaid.map(b => `• ${b.biller}: ${b.amount.toLocaleString()} د.ع`).join('\n');
                const reply = `تفاصيل تسديد كافة الفواتير:\n• عدد الفواتير: ${unpaid.length}\n${billsBreakdown}\n• المجموع الكلي: ${totalAmount.toLocaleString()} د.ع\n• الرصيد بعد الدفع: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أسدد كل الفواتير؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;

                console.log(`\n⏳ [Bill Payment Step 1 - Awaiting User Confirmation]:`);
                console.log(`   Bills Count: ${unpaid.length}`);
                console.log(`   Total Amount: ${totalAmount.toLocaleString()} IQD`);
                console.log(`   Remaining Balance After Payment: ${remainingBal.toLocaleString()} IQD\n`);

                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            } else if (billIntent.type === 'SINGLE') {
                const targetBill = billIntent.bill;
                if (targetBill.status === 'paid') {
                    const reply = `فاتورة "${targetBill.biller}" مسددة مسبقاً وما عليها أي مستحقات حالياً! ✅`;
                    recordSessionTurn(session, userMessage, reply);
                    return sendChatResponse(res, isStreamRequest, { response: reply });
                }

                if (db.user.balance < targetBill.amount) {
                    const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع فاتورة ${targetBill.biller} البالغة ${targetBill.amount.toLocaleString()} د.ع.`;
                    recordSessionTurn(session, userMessage, reply);
                    return sendChatResponse(res, isStreamRequest, { response: reply });
                }

                session.pendingBillPayment = {
                    type: 'SINGLE',
                    billIds: [targetBill.id],
                    totalAmount: targetBill.amount,
                    bills: [targetBill]
                };

                const remainingBal = db.user.balance - targetBill.amount;
                const reply = `تفاصيل تسديد الفاتورة:\n• الفاتورة: ${targetBill.biller} (${targetBill.account_number})\n• المبلغ المطلوب: ${targetBill.amount.toLocaleString()} د.ع\n• الرصيد بعد الدفع: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أسدد الفاتورة؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;

                console.log(`\n⏳ [Bill Payment Step 1 - Awaiting User Confirmation]:`);
                console.log(`   Biller: ${targetBill.biller} (${targetBill.account_number})`);
                console.log(`   Amount Due: ${targetBill.amount.toLocaleString()} IQD`);
                console.log(`   Remaining Balance After Payment: ${remainingBal.toLocaleString()} IQD\n`);

                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            }
        }

        // 6. Check if user wants to add/save a contact
        if (isContactCreationIntent(userMessage)) {
            if (session.recentUserPhoneCandidates && session.recentUserPhoneCandidates.length > 1) {
                const reply = `عندي أكثر من رقم (${session.recentUserPhoneCandidates.join(' و ')}). يا رقم منهم تحب أضيفه لجهات الاتصال؟`;
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            }

            const currentMsgPhones = extractUserPhoneCandidates(userMessage);
            const targetPhone = currentMsgPhones.length === 1
                ? currentMsgPhones[0]
                : (session.lastUserPhoneCandidate?.source === 'USER_INPUT' ? session.lastUserPhoneCandidate.phone : null);

            if (!targetPhone) {
                const reply = 'تدلل عيوني، يرجى تزويدي برقم الهاتف اللي تحب أضيفه لجهات اتصالك.';
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            }

            const nameFromMsg = extractContactNameFromMessage(userMessage);
            if (!nameFromMsg) {
                session.pendingContactCreation = {
                    phone: targetPhone,
                    source: 'USER_INPUT'
                };
                session.pendingTransferRecipient = null;
                const reply = `تدلل عيوني، شنو الاسم اللي تريد أحفظ بيه هذا الرقم (${targetPhone}) بمحفظتك؟`;
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            } else {
                const normPhone = targetPhone.replace(/\D/g, '').slice(-10);
                const normName = normalizeArabic(nameFromMsg);

                const existingContact = (db.contacts || []).find(c => {
                    const cPhone = (c.phone || '').replace(/\D/g, '').slice(-10);
                    const cName = normalizeArabic(c.name || '');
                    return cPhone === normPhone || cName === normName;
                });

                session.pendingContactCreation = null;
                session.lastUserPhoneCandidate = null;
                session.recentUserPhoneCandidates = [];
                session.pendingTransferRecipient = null;

                if (existingContact) {
                    const isSamePhone = (existingContact.phone || '').replace(/\D/g, '').slice(-10) === normPhone;
                    const warnReply = isSamePhone
                        ? `هذا الرقم (${targetPhone}) مسجل مسبقاً بمحفظتك باسم "${existingContact.name}".`
                        : `الاسم "${nameFromMsg}" مسجل مسبقاً بمحفظتك برقم (${existingContact.phone}).`;
                    recordSessionTurn(session, userMessage, warnReply);
                    return sendChatResponse(res, isStreamRequest, { response: warnReply });
                }

                addContactMutation({
                    name: nameFromMsg,
                    phone: targetPhone,
                    alias: nameFromMsg,
                    wallet_provider: 'VI'
                });

                const reply = `تدلل عيوني! تم حفظ "${nameFromMsg}" برقم (${targetPhone}) في جهات اتصال محفظتك بنجاح. ✅`;
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, {
                    response: reply,
                    action: { type: 'ADD_CONTACT', name: nameFromMsg, phone: targetPhone }
                });
            }
        }

        // 7. Check if user is resolving an ambiguous contact (pendingDisambiguation)
        if (session.pendingDisambiguation) {
            const matches = session.pendingDisambiguation.matches || [];
            const selected = resolveContactSelection(userMessage, matches);
            if (selected) {
                const amount = extractAmount(userMessage) || session.pendingDisambiguation.amount;
                session.pendingDisambiguation = null;

                if (amount) {
                    if (db.user.balance < amount) {
                        const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${amount.toLocaleString()} د.ع.`;
                        recordSessionTurn(session, userMessage, reply);
                        return sendChatResponse(res, isStreamRequest, { response: reply });
                    }

                    session.pendingTransfer = {
                        recipient: selected.alias || selected.name,
                        phone: selected.phone,
                        amount: amount
                    };

                    const remainingBal = db.user.balance - amount;

                    console.log(`\n⏳ [Transfer Step 1 - Awaiting User Confirmation]:`);
                    console.log(`   Recipient: ${session.pendingTransfer.recipient} (${session.pendingTransfer.phone})`);
                    console.log(`   Amount: ${session.pendingTransfer.amount.toLocaleString()} IQD`);
                    console.log(`   Remaining Balance After Transfer: ${remainingBal.toLocaleString()} IQD\n`);

                    const reply = `تمام عيوني، اخترت ${selected.alias || selected.name}.\n\nتفاصيل التحويل:\n• المستلم: ${selected.alias || selected.name} (${selected.phone})\n• المبلغ: ${amount.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                    recordSessionTurn(session, userMessage, reply);
                    return sendChatResponse(res, isStreamRequest, { response: reply });
                } else {
                    session.pendingTransferRecipient = {
                        name: selected.alias || selected.name,
                        phone: selected.phone
                    };
                    const reply = `صار عيوني، اخترت ${selected.alias || selected.name} (${selected.phone}).\nشكد المبلغ اللي تريد تحوله له؟`;
                    recordSessionTurn(session, userMessage, reply);
                    return sendChatResponse(res, isStreamRequest, { response: reply });
                }
            } else {
                session.pendingDisambiguation = null;
                session.pendingTransfer = null;
                session.pendingTransferRecipient = null;

                if (isDisambiguationAbandonment(userMessage)) {
                    const reply = 'صار عيوني، تم إلغاء اختيار جهة الاتصال وما تم تجهيز أو تنفيذ أي تحويل وما انخصم أي مبلغ من رصيدك.';
                    recordSessionTurn(session, userMessage, reply);
                    return sendChatResponse(res, isStreamRequest, { response: reply });
                }

                const isOtherIntent = isBalanceInquiry(userMessage) ||
                                      isTransactionsInquiry(userMessage) ||
                                      isBillInquiry(userMessage) ||
                                      detectBillPaymentIntent(userMessage, db.bills) ||
                                      handleContactInquiry(userMessage, db.contacts) ||
                                      findAmbiguousContacts(userMessage, db.contacts);

                if (!isOtherIntent) {
                    const reply = 'لم يتم اختيار أي من الأسماء المعروضة، وتم إلغاء عملية التحديد وما تم تنفيذ أي تحويل.';
                    recordSessionTurn(session, userMessage, reply);
                    return sendChatResponse(res, isStreamRequest, { response: reply });
                }
            }
        }

        // 8. Check if the user message mentions a name matching multiple contacts
        const ambiguous = findAmbiguousContacts(userMessage, db.contacts);
        if (ambiguous) {
            const extractedAmt = extractAmount(userMessage);
            session.pendingTransfer = null;
            session.pendingTransferRecipient = null;
            session.pendingDisambiguation = {
                name: ambiguous.baseName,
                matches: ambiguous.matches,
                amount: extractedAmt
            };

            console.log(`\n🔍 [Contact Disambiguation]: Found ${ambiguous.matches.length} contacts matching "${ambiguous.baseName}". Waiting for user selection.`);

            const listText = ambiguous.matches.map((c, i) => `${i + 1}. ${c.alias || c.name} (${c.phone})`).join('\n');
            const reply = `يا هلا عيوني، عندك أكثر من جهة اتصال باسم "${ambiguous.baseName}" بمحفظتك:\n${listText}\n\nيا واحد منهم تقصد؟ يرجى كتابة الرقم أو الاسم الكامل حتى أجهّزلك التحويل.`;
            recordSessionTurn(session, userMessage, reply);
            return sendChatResponse(res, isStreamRequest, { response: reply });
        }

        // 9. Check if user is resolving a pending recipient waiting for an amount
        if (session.pendingTransferRecipient) {
            const extractedAmt = extractAmount(userMessage);
            if (extractedAmt) {
                const target = session.pendingTransferRecipient;
                session.pendingTransferRecipient = null;

                if (extractedAmt < 250) {
                    session.pendingTransferRecipient = target;
                    const reply = 'أقل مبلغ تحويل مسموح به هو 250 د.ع.';
                    recordSessionTurn(session, userMessage, reply);
                    return sendChatResponse(res, isStreamRequest, { response: reply });
                }

                if (db.user.balance < extractedAmt) {
                    const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${extractedAmt.toLocaleString()} د.ع.`;
                    recordSessionTurn(session, userMessage, reply);
                    return sendChatResponse(res, isStreamRequest, { response: reply });
                }

                session.pendingTransfer = {
                    recipient: target.name,
                    phone: target.phone,
                    amount: extractedAmt
                };

                const remainingBal = db.user.balance - extractedAmt;
                const targetDisplay = (target.name.includes(target.phone) || !target.phone)
                    ? target.name
                    : `${target.name} (${target.phone})`;
                const reply = `تفاصيل التحويل:\n• المستلم: ${targetDisplay}\n• المبلغ: ${extractedAmt.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            }
        }

        // 10. Check if user is inquiring about contacts
        const contactInquiryReply = handleContactInquiry(userMessage, db.contacts);
        if (contactInquiryReply) {
            recordSessionTurn(session, userMessage, contactInquiryReply);
            return sendChatResponse(res, isStreamRequest, { response: contactInquiryReply });
        }

        // 11. Check direct transfer intent
        const transferIntentReply = handleDirectTransferIntent(userMessage, db, session);
        if (transferIntentReply) {
            recordSessionTurn(session, userMessage, transferIntentReply);
            return sendChatResponse(res, isStreamRequest, { response: transferIntentReply });
        }

        // 12. Check standalone numbered choice when no selection prompt is active
        if (isStandaloneNumberedChoice(userMessage) && !session.pendingDisambiguation && !session.pendingBillPayment && !session.pendingTransfer && !session.pendingTransferRecipient && !session.pendingContactCreation) {
            const history = session.conversationHistory || [];
            const lastAssistantTurn = [...history].reverse().find(t => t.role === 'assistant');
            if (lastAssistantTurn && (lastAssistantTurn.content.includes('عندك أكثر من جهة اتصال') || lastAssistantTurn.content.includes('يا واحد منهم تقصد'))) {
                const nameMatch = lastAssistantTurn.content.match(/باسم\s*["']?([\u0621-\u064A\s]+?)["']?\s*بمحفظتك/);
                const recoveredName = nameMatch ? nameMatch[1].trim() : null;
                const ambiguousRecovered = recoveredName ? findAmbiguousContacts(recoveredName, db.contacts) : null;
                if (ambiguousRecovered && ambiguousRecovered.matches && ambiguousRecovered.matches.length > 0) {
                    const selected = resolveContactSelection(userMessage, ambiguousRecovered.matches);
                    if (selected) {
                        const lastUserTurnWithAmt = [...history].reverse().find(t => t.role === 'user' && extractAmount(t.content));
                        const recoveredAmt = lastUserTurnWithAmt ? extractAmount(lastUserTurnWithAmt.content) : null;
                        if (recoveredAmt) {
                            session.pendingTransfer = {
                                recipient: selected.alias || selected.name,
                                phone: selected.phone,
                                amount: recoveredAmt
                            };
                            persistSessionsToDisk();
                            const remainingBal = db.user.balance - recoveredAmt;
                            const reply = `تمام عيوني، اخترت ${selected.alias || selected.name}.\n\nتفاصيل التحويل:\n• المستلم: ${selected.alias || selected.name} (${selected.phone})\n• المبلغ: ${recoveredAmt.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                            recordSessionTurn(session, userMessage, reply);
                            return sendChatResponse(res, isStreamRequest, { response: reply });
                        } else {
                            session.pendingTransferRecipient = {
                                name: selected.alias || selected.name,
                                phone: selected.phone
                            };
                            persistSessionsToDisk();
                            const reply = `صار عيوني، اخترت ${selected.alias || selected.name} (${selected.phone}).\nشكد المبلغ اللي تريد تحوله له؟`;
                            recordSessionTurn(session, userMessage, reply);
                            return sendChatResponse(res, isStreamRequest, { response: reply });
                        }
                    }
                }
            }

            const reply = 'ماكو أي خيارات أو قائمة معروضة حالياً للاختيار منها. بشنو أگدر أساعدك بمحفظتك؟';
            recordSessionTurn(session, userMessage, reply);
            return sendChatResponse(res, isStreamRequest, { response: reply });
        }

        // 13. Tier-2 Semantic Intent Router Fallback (Sub-3ms Local Offline Classifier)
        const hybridIntent = evaluateHybridIntent(userMessage, { bills: db.bills, contacts: db.contacts });
        if (hybridIntent.tier === 2 && hybridIntent.intent && !session.pendingDisambiguation && !session.pendingBillPayment && !session.pendingTransfer) {
            console.log(`⚡ [Hybrid NLP Router Tier-2 Match]: Intent "${hybridIntent.intent}" (Confidence: ${hybridIntent.confidence}, Latency: ${hybridIntent.latencyMs}ms)`);

            if (hybridIntent.intent === 'BALANCE_INQUIRY') {
                let reply = `رصيدك الحالي بمحفظتك هسة هو: ${db.user.balance.toLocaleString()} ${db.user.currency || 'IQD'}.`;
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            }

            if (hybridIntent.intent === 'TRANSACTIONS_INQUIRY') {
                const txs = db.recent_transactions || [];
                let reply = txs.length === 0
                    ? 'ما عندك أي حركات أو تحويلات سابقة مسجلة بسجل محفظتك لحد هسة.'
                    : `عندك ${txs.length} حركات مسجلة بالسجل. وهاي فتحتلك سجل الحركات كامل لتشوف التفاصيل!`;
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply, openTransactionsDrawer: true });
            }

            if (hybridIntent.intent === 'CONTACTS_INQUIRY') {
                const contactsList = (db.contacts || []).map(c => `• ${c.alias || c.name}: ${c.phone}`).join('\n');
                const reply = `جهات الاتصال المسجلة بدفترك:\n${contactsList}`;
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            }

            if (hybridIntent.intent === 'BILL_INQUIRY') {
                const unpaid = (db.bills || []).filter(b => b.status === 'unpaid');
                let reply = '';
                if (unpaid.length === 0) {
                    reply = 'كل فواتيرك مسددة بالكامل وما عندك أي قوائم متأخرة حالياً! ✅';
                } else {
                    const sum = unpaid.reduce((s, b) => s + Number(b.amount || 0), 0);
                    reply = `عندك ${unpaid.length} فواتير غير مسددة بمجموع ${sum.toLocaleString()} د.ع:\n` +
                        unpaid.map(b => `• ${b.biller}: ${Number(b.amount).toLocaleString()} د.ع`).join('\n') +
                        `\nتريد أسدلك وحدة منهم لو أسددهم كلهم؟`;
                }
                recordSessionTurn(session, userMessage, reply);
                return sendChatResponse(res, isStreamRequest, { response: reply });
            }

            if (hybridIntent.intent === 'TRANSFER') {
                const amt = extractAmount(userMessage);
                const recipientMatch = classifyRecipient(userMessage, db.contacts);
                if (amt && recipientMatch && recipientMatch.type === 'EXACT') {
                    const targetContact = recipientMatch.contact;
                    session.pendingTransfer = {
                        recipient: targetContact.alias || targetContact.name,
                        phone: targetContact.phone,
                        amount: amt
                    };
                    persistSessionsToDisk();
                    const remainingBal = db.user.balance - amt;
                    const reply = `تفاصيل التحويل المطلوبة:\n• المستلم: ${targetContact.alias || targetContact.name} (${targetContact.phone})\n• المبلغ: ${amt.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                    recordSessionTurn(session, userMessage, reply);
                    return sendChatResponse(res, isStreamRequest, { response: reply });
                }
            }
        }

        const dbData = JSON.stringify(db, null, 2);
        const unpaidBills = (db.bills || []).filter(b => b.status === 'unpaid');
        const totalUnpaidAmount = unpaidBills.reduce((sum, b) => sum + Number(b.amount || 0), 0);
        const proactiveDigest = unpaidBills.length > 0
            ? `تنبيه مالي استباقي دقيق: المستخدم لديه ${unpaidBills.length} فواتير غير مدفوعة بإجمالي ${totalUnpaidAmount.toLocaleString()} د.ع (${unpaidBills.map(b => `${b.biller} بقيمة ${Number(b.amount).toLocaleString()} د.ع`).join('، ')}). عندما يحييك المستخدم أو يسألك شلونك أو يبدأ المحادثة، بعد الترحيب العراقي الدافئ، اذكره برصيده الحالي (${db.user.balance.toLocaleString()} د.ع) ونبهه بلطف عن فواتيره غير المسددة واقترح عليه سدادها.`
            : `تنبيه مالي استباقي دقيق: رصيد المستخدم ${db.user.balance.toLocaleString()} د.ع، وليس عليه أي فواتير متأخرة نهائياً. عند الترحيب، طمئنه بأن كل فواتيره مسددة ووضعه المالي ممتاز.`;

        const systemPrompt = buildSystemPrompt({ db, proactiveDigest, dbData });

        appendToConversationHistory(session, "user", userMessage);

        const payloadMessages = [
            { role: "system", content: systemPrompt },
            ...session.conversationHistory
        ];

        // Mode 1: Non-streaming standard JSON response
        if (!isStreamRequest) {
            let rawBotReply = '';
            try {
                console.log(`🤖 [Routing to Provider (Standard)]: "${selectedProvider}" (${PROVIDERS[selectedProvider]?.name || selectedProvider})`);
                const completion = await callUnifiedChatCompletion(selectedProvider, payloadMessages, {
                    temperature: 0.2,
                    max_tokens: 500,
                    stream: false
                });
                rawBotReply = completion.choices?.[0]?.message?.content || "(لم يتم استلام رد من النموذج)";
            } catch (fetchErr) {
                console.error(`[${selectedProvider} Completion Error]:`, fetchErr.message);
                let offlineReply = '';
                if (fetchErr.message && (fetchErr.message.includes('النموذج الأساسي') || fetchErr.message.includes('المزود الاحتياطي') || fetchErr.message.includes('مفتاح الـ API'))) {
                    offlineReply = `⚠️ ${fetchErr.message}`;
                } else if (selectedProvider === 'local') {
                    offlineReply = '⚠️ عيوني، نموذج الذكاء الاصطناعي (LM Studio) غير متصل حالياً أو ما زال قيد التحميل في الحاسبة.\n\nيرجى التأكد من تشغيل السيرفر من داخل برنامج LM Studio (الضغط على Start Server على البورت 1234) حتى أگدر أفكر وأجاوبك مباشرة!';
                } else if (selectedProvider === 'gemini') {
                    offlineReply = `⚠️ تعذر الاتصال بنموذج Google Gemini.\n\nالسبب: ${fetchErr.message}\n\n💡 يرجى التأكد من ضبط GEMINI_API_KEY داخل ملف .env والتأكد من توفر اتصال بالإنترنت.`;
                } else if (selectedProvider === 'groq') {
                    offlineReply = `⚠️ تعذر الاتصال بنموذج Groq.\n\nالسبب: ${fetchErr.message}\n\n💡 يرجى التأكد من ضبط GROQ_API_KEY داخل ملف .env والتأكد من توفر اتصال بالإنترنت.`;
                } else {
                    offlineReply = `⚠️ خطأ في الاتصال بالنموذج (${selectedProvider}): ${fetchErr.message}`;
                }
                appendToConversationHistory(session, "assistant", offlineReply);
                return res.json({ response: offlineReply });
            }

            const cleanBotReply = await handleModelActions(rawBotReply, db, userMessage, selectedProvider, session);
            appendToConversationHistory(session, "assistant", cleanBotReply);

            return res.json({ response: cleanBotReply });
        }

        // Mode 2: SSE Token Streaming with In-Memory Sliding-Window Delimiter Interception
        console.log(`🤖 [Routing to Provider (SSE Stream)]: "${selectedProvider}" (${PROVIDERS[selectedProvider]?.name || selectedProvider})`);
        initSseStream(res);

        let capturedAction = null;
        let streamFinished = false;

        const parser = new SlidingWindowTokenParser({
            onToken: (token) => {
                writeSseEvent(res, 'token', { token });
            },
            onAction: (actionData) => {
                capturedAction = actionData;
                writeSseEvent(res, 'action', actionData);
            },
            onDone: async (doneData) => {
                if (streamFinished) return;
                streamFinished = true;

                let finalCleanReply = doneData.fullResponse;
                try {
                    if (doneData.rawResponse && (doneData.rawResponse.includes('<<<DB_ACTION>>>') || capturedAction)) {
                        const processed = await handleModelActions(doneData.rawResponse, db, userMessage, selectedProvider, session);
                        if (!finalCleanReply || processed.includes('⚠️')) {
                            finalCleanReply = processed;
                        }
                    } else {
                        const antiCheck = await handleModelActions(doneData.fullResponse, db, userMessage, selectedProvider, session);
                        if (antiCheck !== doneData.fullResponse) {
                            finalCleanReply = antiCheck;
                        }
                    }
                } catch (actionErr) {
                    console.error('[Action Processing Error on Stream Finish]:', actionErr.message);
                }

                appendToConversationHistory(session, "assistant", finalCleanReply);

                writeSseEvent(res, 'done', {
                    fullResponse: finalCleanReply,
                    action: capturedAction
                });
                res.end();
            },
            onError: (err) => {
                console.error('[Stream Parser Error]:', err.message);
                writeSseEvent(res, 'error', { error: err.message });
            }
        });

        try {
            const stream = await callUnifiedChatCompletion(selectedProvider, payloadMessages, {
                temperature: 0.2,
                max_tokens: 500,
                stream: true
            });

            for await (const chunk of stream) {
                const delta = chunk.choices?.[0]?.delta?.content || '';
                if (delta) {
                    parser.feed(delta);
                }
            }
            await parser.end();
        } catch (streamErr) {
            console.error(`[${selectedProvider} Streaming Error]:`, streamErr.message);
            let offlineReply = '';
            if (streamErr.message && (streamErr.message.includes('النموذج الأساسي') || streamErr.message.includes('المزود الاحتياطي') || streamErr.message.includes('مفتاح الـ API'))) {
                offlineReply = `⚠️ ${streamErr.message}`;
            } else if (selectedProvider === 'local') {
                offlineReply = '⚠️ عيوني، نموذج الذكاء الاصطناعي (LM Studio) غير متصل حالياً أو ما زال قيد التحميل في الحاسبة.\n\nيرجى التأكد من تشغيل السيرفر من داخل برنامج LM Studio (الضغط على Start Server على البورت 1234) حتى أگدر أفكر وأجاوبك مباشرة!';
            } else if (selectedProvider === 'gemini') {
                offlineReply = `⚠️ تعذر الاتصال بنموذج Google Gemini.\n\nالسبب: ${streamErr.message}\n\n💡 يرجى التأكد من ضبط GEMINI_API_KEY داخل ملف .env والتأكد من توفر اتصال بالإنترنت.`;
            } else if (selectedProvider === 'groq') {
                offlineReply = `⚠️ تعذر الاتصال بنموذج Groq.\n\nالسبب: ${streamErr.message}\n\n💡 يرجى التأكد من ضبط GROQ_API_KEY داخل ملف .env والتأكد من توفر اتصال بالإنترنت.`;
            } else {
                offlineReply = `⚠️ خطأ في الاتصال بالنموذج (${selectedProvider}): ${streamErr.message}`;
            }

            writeSseEvent(res, 'token', { token: offlineReply });
            writeSseEvent(res, 'done', { fullResponse: offlineReply });
            appendToConversationHistory(session, "assistant", offlineReply);
            res.end();
        }

    } catch (error) {
        console.error('[Server Error]:', error.message);
        if (isStreamRequest) {
            initSseStream(res);
            writeSseEvent(res, 'error', { error: error.message });
            writeSseEvent(res, 'done', { fullResponse: `⚠️ حدث خطأ غير متوقع: ${error.message}` });
            res.end();
        } else {
            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = {
    handleChat,
    sendChatResponse
};
