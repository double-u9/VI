const fs = require('fs');
const path = require('path');
const { DB_FILE_PATH, DB_TMP_FILE_PATH } = require('../config/providers');
const { INITIAL_DB } = require('../config/initialDb');
const { appendAuditLog } = require('./auditLogger');
const { callUnifiedChatCompletion } = require('./llmService');
const { normalizeArabic, isUserConfirmation } = require('./nlpRouter');
const { buildJsonRepairPrompt } = require('../prompts/recoveryPrompts');

const {
    getSqliteDb,
    exportSqliteToJson,
    syncSqliteWithJsonObject,
    executeTransferTransaction,
    executeBillPaymentTransaction,
    addContactTransaction,
    resetSqliteDatabase
} = require('./sqliteDb');

function getClonedInitialDb() {
    return JSON.parse(JSON.stringify(INITIAL_DB));
}

function readDatabase() {
    try {
        const sqlite = getSqliteDb();
        return exportSqliteToJson(sqlite);
    } catch (error) {
        console.warn(`[DB Auto-Healing] SQLite read fallback: ${error.message}`);
        if (fs.existsSync(DB_FILE_PATH)) {
            try {
                const raw = fs.readFileSync(DB_FILE_PATH, 'utf8').trim();
                if (raw) return JSON.parse(raw);
            } catch (_) {}
        }
        return getClonedInitialDb();
    }
}

function saveDatabase(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid database data provided for save.');
    }
    syncSqliteWithJsonObject(data);
    return true;
}

function resetDatabase() {
    return resetSqliteDatabase(INITIAL_DB);
}

function executeTransferMutation(params) {
    return executeTransferTransaction(params);
}

function executeBillPaymentMutation(params) {
    return executeBillPaymentTransaction(params);
}

function addContactMutation(params) {
    const contact = addContactTransaction(params);
    return { success: true, contact };
}

async function handleModelActions(rawReply, db, userMessage, providerKey = 'local', session = null) {
    if (!rawReply || typeof rawReply !== 'string') return rawReply;

    const actionRegex = /<<<DB_ACTION>>>([\s\S]*?)<<<END_DB_ACTION>>>/;
    const match = rawReply.match(actionRegex);

    if (!match) {
        // Anti-fabrication safeguard: if model falsely claims a transaction succeeded without <<<DB_ACTION>>>
        const normReply = normalizeArabic(rawReply);
        const claimsPayment = (normReply.includes('تم دفع') || normReply.includes('تم تسديد') || normReply.includes('تم تحويل')) &&
                              (normReply.includes('بنجاح') || normReply.includes('فاتور'));
        if (claimsPayment) {
            console.warn('⚠️ [SECURITY INTERCEPT]: Model fabricated payment success without <<<DB_ACTION>>>. Overriding with safety prompt.');
            return '⚠️ لم يتم تنفيذ أي عملية دفع أو خصم من رصيدك حتى الآن. يرجى تأكيد العملية لتنفيذها بشكل رسمي وآمن.';
        }
        return rawReply;
    }

    let actionPayload = null;
    let parseSuccess = false;

    // Attempt 1: Direct JSON parse
    try {
        actionPayload = JSON.parse(match[1].trim());
        parseSuccess = true;
    } catch (initialErr) {
        console.warn(`⚠️ [DB_ACTION Parse Error]: ${initialErr.message}. Initiating model self-correction...`);

        // Attempt 2: Self-correction loop (Rule 2: Exactly one retry attempt)
        try {
            const selfCorrectionPrompt = buildJsonRepairPrompt(match[1].trim(), initialErr.message);

            const correctionResponse = await callUnifiedChatCompletion(providerKey, selfCorrectionPrompt, {
                temperature: 0.1,
                max_tokens: 300
            });

            let correctedText = (correctionResponse.choices?.[0]?.message?.content || '').trim();
            correctedText = correctedText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            const innerMatch = correctedText.match(/<<<DB_ACTION>>>([\s\S]*?)<<<END_DB_ACTION>>>/);
            if (innerMatch) {
                correctedText = innerMatch[1].trim();
            }

            actionPayload = JSON.parse(correctedText);
            parseSuccess = true;
            console.log('✅ [DB_ACTION Self-Correction Successful]: Malformed action payload repaired.');
        } catch (correctionErr) {
            console.error('❌ [DB_ACTION Self-Correction Failed]:', correctionErr.message);
            parseSuccess = false;
        }
    }

    // Abort mutation if parsing / self-correction failed on second attempt
    if (!parseSuccess || !actionPayload || typeof actionPayload !== 'object') {
        console.error('🚨 [DB_ACTION Aborted]: Action parsing failed after self-correction attempt. Mutation aborted.');
        return '⚠️ عذراً عيوني، حدث خطأ تقني في معالجة بيانات العملية ولم يتم تنفيذ أي تغيير على محفظتك أو رصيدك. يرجى المحاولة مرة أخرى.';
    }

    try {
        if (actionPayload.action === 'TRANSFER') {
            const numericAmt = Number(actionPayload.amount);

            // Rule 3: Schema validation guards
            if (isNaN(numericAmt) || numericAmt <= 0) {
                console.error('[Action Execution Error] Invalid transfer amount in payload:', actionPayload.amount);
                return '⚠️ عذراً عيوني، لم يتم تحديد مبلغ صحيح للتحويل، ولم يُخصم أي مبلغ من رصيدك.';
            }

            if (db.user.balance < numericAmt) {
                return `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${numericAmt.toLocaleString()} د.ع.`;
            }

            const currentPendingTransfer = session?.pendingTransfer || null;
            if (isUserConfirmation(userMessage)) {
                const toExecute = currentPendingTransfer || {
                    recipient: actionPayload.recipient,
                    amount: numericAmt,
                    phone: actionPayload.phone
                };
                console.log('[Transfer Confirmed & Executed on DB]:', toExecute);
                const result = executeTransferMutation(toExecute);
                if (session) {
                    session.pendingTransfer = null;
                    session.pendingDisambiguation = null;
                }

                const toExecuteDisplay = (toExecute.recipient.includes(toExecute.phone) || !toExecute.phone)
                    ? toExecute.recipient
                    : `${toExecute.recipient} (${toExecute.phone})`;
                return `تم تأكيد التحويل بنجاح! دزيت ${toExecute.amount.toLocaleString()} د.ع إلى ${toExecuteDisplay}. رصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
            } else {
                console.log('[Action Intercepted - Requiring Confirmation]:', actionPayload);
                const newPendingTransfer = {
                    recipient: actionPayload.recipient,
                    amount: numericAmt,
                    phone: actionPayload.phone
                };
                if (session) {
                    session.pendingTransfer = newPendingTransfer;
                }

                const remainingBal = db.user.balance - numericAmt;
                const newPendingDisplay = (newPendingTransfer.recipient.includes(newPendingTransfer.phone) || !newPendingTransfer.phone)
                    ? newPendingTransfer.recipient
                    : `${newPendingTransfer.recipient} (${newPendingTransfer.phone})`;
                return `تفاصيل التحويل المطلوبة:\n• المستلم: ${newPendingDisplay}\n• المبلغ: ${newPendingTransfer.amount.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
            }
        } else if (actionPayload.action === 'BILL_PAYMENT' || actionPayload.action === 'PAY_BILL') {
            const isAll = actionPayload.bill_id === 'ALL' ||
                (typeof actionPayload.biller === 'string' && (actionPayload.biller.toUpperCase() === 'ALL' || normalizeArabic(actionPayload.biller).includes('كل الفواتير')));

            if (isAll) {
                const unpaid = (db.bills || []).filter(b => b.status === 'unpaid');
                if (unpaid.length === 0) {
                    return 'ما عندك أي فواتير غير مدفوعة حالياً بمحفظتك، كل فواتيرك مسددة بالكامل! ✅';
                }

                const totalAmount = unpaid.reduce((sum, b) => sum + Number(b.amount || 0), 0);
                if (db.user.balance < totalAmount) {
                    return `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع كل الفواتير البالغة ${totalAmount.toLocaleString()} د.ع.`;
                }

                const currentPendingBill = session?.pendingBillPayment || null;
                if (isUserConfirmation(userMessage)) {
                    const toExecute = currentPendingBill || {
                        type: 'ALL',
                        billIds: unpaid.map(b => b.id),
                        totalAmount: totalAmount,
                        bills: unpaid
                    };
                    const result = executeBillPaymentMutation(toExecute);
                    if (session) {
                        session.pendingBillPayment = null;
                    }
                    return `تم تأكيد دفع كافة الفواتير بنجاح! ✅\nتم تسديد ${result.paidBills.length} فواتير بمجموع ${result.totalAmount.toLocaleString()} د.ع.\nرصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
                } else {
                    const newPendingBill = {
                        type: 'ALL',
                        billIds: unpaid.map(b => b.id),
                        totalAmount: totalAmount,
                        bills: unpaid
                    };
                    if (session) {
                        session.pendingBillPayment = newPendingBill;
                    }
                    const remainingBal = db.user.balance - totalAmount;
                    const billsBreakdown = unpaid.map(b => `• ${b.biller}: ${b.amount.toLocaleString()} د.ع`).join('\n');
                    return `تفاصيل تسديد كافة الفواتير:\n• عدد الفواتير: ${unpaid.length}\n${billsBreakdown}\n• المجموع الكلي: ${totalAmount.toLocaleString()} د.ع\n• الرصيد بعد الدفع: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أسدد كل الفواتير؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                }
            } else {
                let targetBill = null;
                if (actionPayload.bill_id && actionPayload.bill_id !== 'ALL') {
                    targetBill = (db.bills || []).find(b => b.id === actionPayload.bill_id);
                }
                if (!targetBill && actionPayload.account_number) {
                    targetBill = (db.bills || []).find(b => b.account_number && b.account_number.toLowerCase() === String(actionPayload.account_number).toLowerCase());
                }
                if (!targetBill && actionPayload.biller) {
                    const normSearch = normalizeArabic(actionPayload.biller);
                    targetBill = (db.bills || []).find(b => {
                        const nb = normalizeArabic(b.biller);
                        return nb.includes(normSearch) || normSearch.includes(nb);
                    });
                }

                if (!targetBill) {
                    return '⚠️ عذراً عيوني، لم يتم العثور على الفاتورة المطلوبة في قائمة فواتيرك.';
                }

                if (targetBill.status === 'paid') {
                    return `فاتورة "${targetBill.biller}" مسددة مسبقاً وما عليها أي مستحقات حالياً! ✅`;
                }

                const billAmount = Number(targetBill.amount);
                if (isNaN(billAmount) || billAmount <= 0) {
                    return '⚠️ عذراً عيوني، بيانات مبلغ الفاتورة غير صحيحة.';
                }

                if (db.user.balance < billAmount) {
                    return `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع فاتورة ${targetBill.biller} البالغة ${billAmount.toLocaleString()} د.ع.`;
                }

                const currentPendingBill = session?.pendingBillPayment || null;
                if (isUserConfirmation(userMessage)) {
                    const toExecute = currentPendingBill || {
                        type: 'SINGLE',
                        billIds: [targetBill.id],
                        totalAmount: billAmount,
                        bills: [targetBill]
                    };
                    const result = executeBillPaymentMutation(toExecute);
                    if (session) {
                        session.pendingBillPayment = null;
                    }
                    return `تم تأكيد دفع الفاتورة بنجاح! ✅\nتم تسديد ${result.totalAmount.toLocaleString()} د.ع لحساب (${targetBill.biller} - ${targetBill.account_number}).\nرصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
                } else {
                    const newPendingBill = {
                        type: 'SINGLE',
                        billIds: [targetBill.id],
                        totalAmount: billAmount,
                        bills: [targetBill]
                    };
                    if (session) {
                        session.pendingBillPayment = newPendingBill;
                    }
                    const remainingBal = db.user.balance - billAmount;
                    return `تفاصيل تسديد الفاتورة:\n• الفاتورة: ${targetBill.biller} (${targetBill.account_number})\n• المبلغ المطلوب: ${billAmount.toLocaleString()} د.ع\n• الرصيد بعد الدفع: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أسدد الفاتورة؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                }
            }
        } else if (actionPayload.action === 'ADD_CONTACT') {
            const rawPhoneDigits = String(actionPayload.phone || '').replace(/\D/g, '');
            const userMessageDigits = userMessage.replace(/\D/g, '');

            const isCurrentMessagePhone = rawPhoneDigits.length >= 7 && userMessageDigits.includes(rawPhoneDigits.slice(-7));
            const isUserContextPhone = session?.lastUserPhoneCandidate?.source === 'USER_INPUT' &&
                String(session.lastUserPhoneCandidate.phone || '').replace(/\D/g, '').endsWith(rawPhoneDigits.slice(-7));

            const isAuthenticUserPhone = isCurrentMessagePhone || isUserContextPhone;

            if (!isAuthenticUserPhone) {
                console.warn(`⚠️ [SECURITY INTERCEPT]: Blocked hallucinated ADD_CONTACT action for "${actionPayload.name}" with fake phone "${actionPayload.phone}". User did not provide this number.`);
                return `عذراً عيوني، ما كتبت رقم الهاتف الفعلي لـ "${actionPayload.name}". يرجى كتابة رقم هاتفه حتى أضيفه لك بمحفظتك.`;
            }

            addContactMutation({
                name: actionPayload.name,
                phone: actionPayload.phone,
                alias: actionPayload.alias,
                wallet_provider: actionPayload.wallet_provider
            });

            if (session) {
                session.lastUserPhoneCandidate = null;
                session.pendingContactCreation = null;
            }

            const cleanBotText = rawReply.replace(actionRegex, '').trim();
            if (cleanBotText) {
                return cleanBotText;
            }
            return `تدلل عيوني! تم حفظ "${actionPayload.name}" برقم (${actionPayload.phone}) في جهات اتصال محفظتك بنجاح. ✅`;
        }
    } catch (err) {
        console.error('[Action Execution Error]', err.message);
        return `⚠️ تعذر إتمام العملية: ${err.message}`;
    }

    return rawReply.replace(actionRegex, '').trim();
}

module.exports = {
    INITIAL_DB,
    getClonedInitialDb,
    readDatabase,
    saveDatabase,
    resetDatabase,
    executeTransferMutation,
    executeBillPaymentMutation,
    addContactMutation,
    handleModelActions
};
