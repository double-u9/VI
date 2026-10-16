const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { resetDatabase } = require('./reset_db');

// Load environment variables securely from .env in project root
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const app = express();
app.use(cors());
app.use(express.json());

// Disable caching in development so browser always receives latest UI
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

app.use('/assets', express.static(path.join(__dirname, '../assets')));
app.use(express.static(path.join(__dirname, '../assets')));
app.use(express.static(path.join(__dirname, '../frontend')));

/* ==========================================================================
   Unified Model Providers Configuration & OpenAI Client Wrapper
   ========================================================================== */

const PROVIDERS = {
    local: {
        name: 'LM Studio (محلي)',
        baseURL: (process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1').replace(/\/chat\/completions\/?$/, ''),
        apiKeyEnv: 'LOCAL_API_KEY',
        defaultKey: 'lm-studio',
        defaultModel: 'local-model'
    },
    gemini: {
        name: 'Google Gemini',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKeyEnv: 'GEMINI_API_KEY',
        defaultKey: null,
        defaultModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
    },
    groq: {
        name: 'Groq',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKeyEnv: 'GROQ_API_KEY',
        defaultKey: null,
        defaultModel: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b'
    }
};

/**
 * Unified Chat Completion Handler
 * Routes all chat requests dynamically through OpenAI client based on selected provider.
 */
async function callUnifiedChatCompletion(providerKey, messages, options = {}) {
    const provider = PROVIDERS[providerKey] || PROVIDERS.local;
    const keyName = provider.apiKeyEnv;
    const apiKey = process.env[keyName] || provider.defaultKey;

    if (!apiKey && providerKey !== 'local') {
        throw new Error(`مفتاح الـ API لـ ${provider.name} (${keyName}) غير متوفر! يرجى إضافته في ملف .env أولاً.`);
    }

    const client = new OpenAI({
        baseURL: provider.baseURL,
        apiKey: apiKey || 'lm-studio'
    });

    const model = options.model || provider.defaultModel;

    return await client.chat.completions.create({
        model: model,
        messages: messages,
        temperature: options.temperature !== undefined ? options.temperature : 0.2,
        max_tokens: options.max_tokens !== undefined ? options.max_tokens : 500
    });
}

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1/chat/completions';
const DB_FILE_PATH = path.join(__dirname, 'mock_wallet_db.json');
const FEEDBACK_LIKES_PATH = path.join(__dirname, 'feedback_likes.json');
const FEEDBACK_DISLIKES_PATH = path.join(__dirname, 'feedback_dislikes.json');

/* ==========================================================================
   وظائف قراءة وتحديث ملفات التقييم وقاعدة البيانات على القرص
   ========================================================================== */

function readFeedbackFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify([], null, 2), 'utf8');
            return [];
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (err) {
        console.error(`[Feedback] Error reading ${filePath}:`, err.message);
        return [];
    }
}

function saveFeedbackFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error(`[Feedback Error] Failed to write ${filePath}:`, err.message);
        return false;
    }
}

function readDatabase() {
    try {
        if (!fs.existsSync(DB_FILE_PATH)) {
            throw new Error(`Database file not found at: ${DB_FILE_PATH}`);
        }
        const raw = fs.readFileSync(DB_FILE_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        console.error('Error reading database:', error.message);
        throw error;
    }
}

function saveDatabase(data) {
    try {
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid database data provided for save.');
        }
        const jsonString = JSON.stringify(data, null, 2);
        fs.writeFileSync(DB_FILE_PATH, jsonString, 'utf8');
        console.log(`[DB] Successfully persisted changes to ${DB_FILE_PATH}`);
        return true;
    } catch (error) {
        console.error('[DB Error] Failed to write database to disk:', error.message);
        throw error;
    }
}

function executeTransferMutation({ recipient, amount, phone }) {
    const db = readDatabase();
    const numericAmount = Number(amount);

    if (isNaN(numericAmount) || numericAmount <= 0) {
        throw new Error(`Invalid transfer amount: ${amount}`);
    }

    if (db.user.balance < numericAmount) {
        throw new Error(`Insufficient balance: current balance (${db.user.balance} IQD) is less than transfer amount (${numericAmount} IQD).`);
    }

    db.user.balance -= numericAmount;

    const trxId = `trx_${Date.now().toString().slice(-6)}`;
    const newTrx = {
        id: trxId,
        type: "TRANSFER",
        recipient: recipient || "Unknown Recipient",
        phone: phone || "",
        amount: numericAmount,
        currency: db.user.currency || "IQD",
        status: "SUCCESS",
        date: new Date().toISOString().split('T')[0]
    };

    if (!Array.isArray(db.recent_transactions)) {
        db.recent_transactions = [];
    }
    db.recent_transactions.unshift(newTrx);

    saveDatabase(db);
    return { success: true, newBalance: db.user.balance, transaction: newTrx };
}

function executeBillPaymentMutation({ billIds }) {
    const db = readDatabase();
    if (!Array.isArray(billIds) || billIds.length === 0) {
        throw new Error('لم يتم تحديد أي فاتورة للدفع.');
    }

    const billsToPay = (db.bills || []).filter(b => billIds.includes(b.id) && b.status === 'unpaid');
    if (billsToPay.length === 0) {
        throw new Error('لم يتم العثور على فواتير غير مدفوعة مطابقة في قاعدة البيانات.');
    }

    const totalAmount = billsToPay.reduce((sum, b) => sum + Number(b.amount || 0), 0);

    if (db.user.balance < totalAmount) {
        throw new Error(`الرصيد الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع مبلغ ${totalAmount.toLocaleString()} د.ع.`);
    }

    // Deduct balance
    db.user.balance -= totalAmount;

    const paidTransactions = [];
    for (const b of billsToPay) {
        b.status = 'paid';
        const trxId = `trx_${Date.now().toString().slice(-6)}_${Math.floor(Math.random() * 1000)}`;
        const newTrx = {
            id: trxId,
            type: "BILL_PAYMENT",
            biller: b.biller,
            account_number: b.account_number,
            amount: Number(b.amount),
            currency: db.user.currency || "IQD",
            status: "SUCCESS",
            date: new Date().toISOString().split('T')[0]
        };
        paidTransactions.push(newTrx);
        if (!Array.isArray(db.recent_transactions)) {
            db.recent_transactions = [];
        }
        db.recent_transactions.unshift(newTrx);
    }

    saveDatabase(db);
    console.log(`[Bill Payment Confirmed & Executed on DB]: Paid ${billsToPay.length} bill(s). Total: ${totalAmount.toLocaleString()} IQD. New Balance: ${db.user.balance.toLocaleString()} IQD`);

    return {
        success: true,
        newBalance: db.user.balance,
        totalAmount,
        paidBills: billsToPay,
        transactions: paidTransactions
    };
}

function addContactMutation({ name, phone, alias, wallet_provider }) {
    const db = readDatabase();

    if (!name || !phone) {
        throw new Error('Contact name and phone number are required.');
    }

    if (!Array.isArray(db.contacts)) {
        db.contacts = [];
    }

    const newId = `cnt_${Date.now().toString().slice(-4)}`;
    let formattedPhone = String(phone).trim();
    if (formattedPhone.startsWith('07')) {
        formattedPhone = '+964' + formattedPhone.slice(1);
    }

    const newContact = {
        id: newId,
        name: name.trim(),
        alias: (alias || name).trim(),
        phone: formattedPhone,
        wallet_provider: wallet_provider || "VI"
    };

    db.contacts.push(newContact);
    saveDatabase(db);
    return { success: true, contact: newContact };
}

let conversationHistory = [];
let pendingTransfer = null;
let pendingDisambiguation = null;
let pendingBillPayment = null;
let pendingTransferRecipient = null;


function normalizeArabic(text) {
    if (!text) return '';
    return text
        .trim()
        .toLowerCase()
        .replace(/[إأآا]/g, 'ا')
        .replace(/[ى]/g, 'ي')
        .replace(/[ة]/g, 'ه');
}

function extractAmount(text) {
    if (!text) return null;
    const clean = normalizeArabic(text);

    // 1. Spelled out Arabic amounts
    if (clean.includes('ميتين الف') || clean.includes('مئتان الف')) return 200000;
    if (clean.includes('ميه الف') || clean.includes('مية الف') || clean.includes('مئة الف') || clean.includes('ميه') || clean.includes('مية') || clean.includes('مئة')) {
        if (clean.includes('مية وخمسين') || clean.includes('مئة وخمسين')) return 150000;
        return 100000;
    }
    if (clean.includes('خمسين الف') || clean.includes('خمسين ألف')) return 50000;
    if (clean.includes('خمسه وعشرين الف') || clean.includes('خمسة وعشرين الف')) return 25000;
    if (clean.includes('عشرين الف') || clean.includes('عشرين ألف')) return 20000;
    if (clean.includes('عشره الاف') || clean.includes('عشرة الاف') || clean.includes('عشرة آلاف')) return 10000;
    if (clean.includes('خمسه الاف') || clean.includes('خمسة الاف') || clean.includes('خمسة آلاف')) return 5000;

    // 2. Numeric with thousand multiplier: e.g. "100 الف", "50 ألف", "25k"
    const thousandMatch = text.match(/(\d+[\d,.]*)\s*(ألف|الف|k)/i);
    if (thousandMatch) {
        const numStr = thousandMatch[1].replace(/[,.]/g, '');
        return parseInt(numStr, 10) * 1000;
    }

    // 3. Comma/dot separated numbers: e.g. "100,000" or "100.000"
    const formattedMatch = text.match(/\b(\d{1,3})[,.](\d{3})\b/);
    if (formattedMatch) {
        return parseInt(formattedMatch[1] + formattedMatch[2], 10);
    }

    // 4. Plain digits: e.g. "100000", "50000", "25000"
    const plainMatch = text.match(/\b(\d{4,7})\b/);
    if (plainMatch) {
        return parseInt(plainMatch[1], 10);
    }

    return null;
}

function findAmbiguousContacts(userMessage, contacts) {
    if (!userMessage || !Array.isArray(contacts)) return null;
    const normMsg = normalizeArabic(userMessage);

    // Group contacts by normalized base name
    const grouped = {};
    for (const c of contacts) {
        const baseNorm = normalizeArabic(c.name || '');
        if (!baseNorm) continue;
        if (!grouped[baseNorm]) {
            grouped[baseNorm] = [];
        }
        grouped[baseNorm].push(c);
    }

    // Check if userMessage mentions any name that has multiple contacts
    for (const [nameNorm, list] of Object.entries(grouped)) {
        if (list.length > 1) {
            const nameRegex = new RegExp(`(^|[\\s،,])(ل|الى\\s+|الي\\s+)?(${nameNorm})([\\s،,]|$)`, 'i');
            if (nameRegex.test(normMsg)) {
                const specificMatches = list.filter(c => {
                    const normAlias = normalizeArabic(c.alias || '');
                    const aliasWords = normAlias.split(/[\s()\/]+/).filter(w => w.length >= 3 && w !== nameNorm);
                    const hasAliasWord = aliasWords.some(w => normMsg.includes(w));

                    const phoneDigits = (c.phone || '').replace(/\D/g, '');
                    const hasPhone = phoneDigits.length >= 4 && normMsg.replace(/\D/g, '').includes(phoneDigits.slice(-6));

                    return hasAliasWord || hasPhone;
                });

                if (specificMatches.length !== 1) {
                    return {
                        baseName: list[0].name,
                        matches: list
                    };
                }
            }
        }
    }

    return null;
}

function resolveContactSelection(userMessage, matches) {
    if (!userMessage || !Array.isArray(matches)) return null;
    const raw = userMessage.trim().toLowerCase();
    const normalized = normalizeArabic(raw);

    // Number matching: "1", "2", "3" or "الاول", "الثاني", "الثالث"
    if (raw === '1' || normalized === 'الاول' || normalized.startsWith('الاول ')) {
        return matches[0];
    }
    if (raw === '2' || normalized === 'الثاني' || normalized.startsWith('الثاني ')) {
        return matches[1];
    }
    if (raw === '3' || normalized === 'الثالث' || normalized.startsWith('الثالث ')) {
        return matches[2];
    }

    // Phone digits matching:
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 4) {
        const found = matches.find(c => (c.phone || '').replace(/\D/g, '').includes(digits));
        if (found) return found;
    }

    // Distinguishing alias words (e.g. "كمال", "جاسم", "الفيترجي"):
    for (const c of matches) {
        const normAlias = normalizeArabic(c.alias || '');
        const normName = normalizeArabic(c.name || '');
        const words = normAlias.split(/[\s()\/]+/).filter(w => w.length >= 3 && w !== normName);
        for (const w of words) {
            if (normalized.includes(w)) {
                return c;
            }
        }
        if (normAlias && normalized.includes(normAlias)) return c;
    }

    return null;
}

function handleContactInquiry(userMessage, contacts) {
    if (!userMessage || !Array.isArray(contacts)) return null;
    const clean = normalizeArabic(userMessage);

    const hasInquiryKeywords = 
        clean.includes('قائم') || clean.includes('اقام') || clean.includes('جهات الاتصال') ||
        clean.includes('اصدقاء') || clean.includes('عندك رقم') || clean.includes('ما عندك رقم') ||
        clean.includes('مسجل عندك') || clean.includes('موجود عندك') || clean.includes('منو مسجل') ||
        clean.includes('شو مسجل') || clean.includes('شنو مسجل') || clean.includes('ارقام اصدقائي') ||
        clean.includes('هل رقم') || clean.includes('رقم منو') || clean.includes('عندك احد');

    if (!hasInquiryKeywords) return null;

    // Check if inquiring about all contacts (e.g. "منو مسجل عندي", "قائمة اتصالاتي", "جهات الاتصال")
    const isGeneralList = 
        clean.includes('منو مسجل') || clean.includes('كل جهات') || clean.includes('كل الاسماء') ||
        clean.includes('ارقام اصدقائي') || clean.includes('كل اصدقائي') ||
        (clean.includes('منو عندي') && (clean.includes('قائم') || clean.includes('اقام') || clean.includes('اتصال'))) ||
        (clean === 'قائمه اتصالاتي' || clean === 'قائمة اتصالاتي' || clean === 'جهات الاتصال' || clean === 'اصدقائي');

    if (isGeneralList) {
        if (contacts.length === 0) {
            return 'ما عندك أي جهات اتصال مسجلة بمحفظتك حالياً.';
        }
        const list = contacts.map((c, i) => `${i + 1}. ${c.alias || c.name} (${c.phone})`).join('\n');
        return `هاي قائمة بجهات الاتصال المسجلة بمحفظتك:\n\n${list}\n\n💡 تكدر تحول لأي شخص منهم بكتابة اسمه والمبلغ (مثلاً: "حول 50 الف لسيف").`;
    }

    // Specific contact inquiry: e.g. "ما عندك رقم جعفر اقامه اتصالاتي", "عندك رقم سيف؟", "هل جعفر مسجل؟"
    for (const c of contacts) {
        const normName = normalizeArabic(c.name || '');
        const normAlias = normalizeArabic(c.alias || '');
        if ((normName && clean.includes(normName)) || (normAlias && clean.includes(normAlias))) {
            return `اي نعم عيوني، مسجل عندك بمحفظتك:\n• الاسم: ${c.alias || c.name}\n• رقم الهاتف: ${c.phone}`;
        }
    }

    // Unknown contact - extract the target name
    const stopWords = ['عندك', 'ماعندك', 'ما', 'هل', 'رقم', 'هاتف', 'موجود', 'مسجل', 'بقائمه', 'باقامه', 'قائمه', 'اقامه', 'اتصالاتي', 'اصدقائي', 'محفظتي', 'حسابي', 'هو', 'هي', 'ليش', 'شنو', 'شو', 'اكو', 'ماكو', 'في', 'من'];
    const words = clean.split(/[\s،,?!.]+/).filter(w => w.length >= 3 && !stopWords.includes(w));
    const targetName = words.length > 0 ? words[0] : 'هذا الشخص';

    return `لا عيوني، ما لقيت أي شخص باسم "${targetName}" مسجل بقائمة اتصالاتك بمحفظتك.\nإذا تحب تكدر تدزلي اسمه ورقمه حتى أضيفه إلك بمحفظتك.`;
}

function handleDirectTransferIntent(userMessage, db) {
    if (!userMessage || !db) return null;
    const clean = normalizeArabic(userMessage);

    // Must have a transfer intent verb
    const transferVerbs = ['حول', 'تحول', 'احول', 'تحولي', 'تحوللي', 'تدز', 'دز', 'ادز', 'ارسل', 'ترسل', 'ابعت', 'ابعث'];
    const isTransferVerb = transferVerbs.some(v => {
        const regex = new RegExp(`(^|[\\s،,])(${v})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });
    if (!isTransferVerb) return null;

    // Exclude balance and transaction inquiries
    if (isBalanceInquiry(userMessage) || isTransactionsInquiry(userMessage)) return null;

    // Exclude bill inquiries/payments
    if (clean.includes('فاتور') || clean.includes('قائم')) return null;

    const amount = extractAmount(userMessage);
    const contacts = db.contacts || [];

    // Check for explicit phone number: 07[789]\d{8} or \+9647[789]\d{8}
    const phoneMatch = userMessage.match(/(?:\+964|00964|0)?(7[789]\d{8})\b/);
    const explicitPhone = phoneMatch ? ('+964' + phoneMatch[1]) : null;

    // Find matching contacts
    const matched = [];
    for (const c of contacts) {
        const normName = normalizeArabic(c.name || '');
        const normAlias = normalizeArabic(c.alias || '');
        const aliasWords = normAlias.split(/[\s()\/]+/).filter(w => w.length >= 3 && w !== normName);

        const nameRegex = new RegExp(`(^|[\\s،,])(ل|الى\\s+|الي\\s+)?(${normName})([\\s،,]|$)`, 'i');
        const matchesName = normName && nameRegex.test(clean);
        const matchesAlias = normAlias && clean.includes(normAlias);
        const matchesAliasWord = aliasWords.some(w => clean.includes(w) && (clean.includes('ل' + w) || clean.includes('الى ' + w) || clean.includes('الي ' + w)));

        if (matchesName || matchesAlias || matchesAliasWord) {
            matched.push(c);
        }
    }

    // 1. Multiple matches -> Disambiguation
    if (matched.length > 1) {
        pendingDisambiguation = {
            name: matched[0].name,
            matches: matched,
            amount: amount
        };
        const listText = matched.map((c, i) => `${i + 1}. ${c.alias || c.name} (${c.phone})`).join('\n');
        return `يا هلا عيوني، عندك أكثر من جهة اتصال باسم "${matched[0].name}" بمحفظتك:\n${listText}\n\nيا واحد منهم تقصد؟ يرجى كتابة الرقم أو الاسم الكامل حتى أجهّزلك التحويل.`;
    }

    // 2. Exactly ONE match
    if (matched.length === 1) {
        const selected = matched[0];
        if (amount) {
            if (db.user.balance < amount) {
                return `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${amount.toLocaleString()} د.ع.`;
            }
            pendingTransfer = {
                recipient: selected.alias || selected.name,
                phone: selected.phone,
                amount: amount
            };
            const remainingBal = db.user.balance - amount;
            return `تفاصيل التحويل:\n• المستلم: ${selected.alias || selected.name} (${selected.phone})\n• المبلغ: ${amount.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
        } else {
            pendingTransferRecipient = {
                name: selected.alias || selected.name,
                phone: selected.phone
            };
            return `صار عيوني، اخترت ${selected.alias || selected.name} (${selected.phone}).\nشكد المبلغ اللي تريد تحوله له؟`;
        }
    }

    // 3. ZERO matches - Did user provide a direct phone number?
    if (explicitPhone) {
        if (amount) {
            if (db.user.balance < amount) {
                return `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${amount.toLocaleString()} د.ع.`;
            }
            pendingTransfer = {
                recipient: `رقم الهاتف (${explicitPhone})`,
                phone: explicitPhone,
                amount: amount
            };
            const remainingBal = db.user.balance - amount;
            return `تفاصيل التحويل:\n• المستلم: رقم الهاتف (${explicitPhone})\n• المبلغ: ${amount.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
        } else {
            pendingTransferRecipient = {
                name: `رقم الهاتف (${explicitPhone})`,
                phone: explicitPhone
            };
            return `صار عيوني، تم تحديد الرقم (${explicitPhone}).\nشكد المبلغ اللي تريد تحوله له؟`;
        }
    }

    // 4. ZERO matches and NO phone number (e.g. "هل تقدر تحول لي لجعفر")
    const nameMatch = clean.match(/(?:ل|الى\s+|الي\s+)([\u0621-\u064A]{3,15})/);
    const ignoreList = ['حسابي', 'محفظتي', 'رصيدي', 'شخص', 'احد', 'واحد', 'صديق', 'فلوس', 'مبلغ', 'رقم'];
    let unknownName = 'هذا الشخص';
    if (nameMatch && !ignoreList.includes(nameMatch[1])) {
        unknownName = nameMatch[1];
    }

    if (amount) {
        return `يا هلا عيوني، ما لقيت أي شخص باسم "${unknownName}" بقائمة اتصالاتك بمحفظتك.\nحتى أجهّزلك تحويل مبلغ ${amount.toLocaleString()} د.ع، يرجى تزويدي برقم هاتفه.`;
    }

    return `يا هلا عيوني، ما لقيت أي شخص باسم "${unknownName}" بقائمة اتصالاتك بمحفظتك.\nإذا تريد تحول له، يرجى تزويدي برقم هاتفه والمبلغ اللي تريد تدزه.`;
}

const CANCELLATION_WORDS = ['لا', 'إلغاء', 'الغاء', 'بطلت', 'هونت', 'ما أريد', 'ما اريد', 'cancel'];

function isUserCancellation(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);
    return CANCELLATION_WORDS.some(w => {
        const nw = normalizeArabic(w);
        const regex = new RegExp(`(^|[\\s،,])(${nw})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });
}

const CONFIRMATION_PATTERNS = [
    'نعم', 'أكد', 'اكد', 'موافق', 'أي', 'اي', 'تمام', 'توكل', 'أكيد', 'اكيد',
    'أرسل', 'ارسل', 'دز', 'دزه', 'حول', 'حوله', 'ادفع', 'ادفعها', 'سدد', 'سددها', 'يلا', 'yes', 'ok', 'confirm', 'send'
];

function isUserConfirmation(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);
    if (isUserCancellation(text)) return false;

    return CONFIRMATION_PATTERNS.some(word => {
        const normWord = normalizeArabic(word);
        const regex = new RegExp(`(^|[\\s،,])(${normWord})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });
}

const GREETING_WORDS = [
    'اهلا', 'أهلا', 'مرحبا', 'مرحباً', 'هلا', 'هلو', 'يا هلا', 'سلام', 'السلام عليكم', 'سلام عليكم',
    'شلونك', 'شلونكم', 'شخبارك', 'صباح الخير', 'مساء الخير', 'يعطيك العافيه', 'يعطيك العافية'
];

function isGreeting(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length > 5) return false;
    return GREETING_WORDS.some(gw => {
        const normGw = normalizeArabic(gw);
        return clean === normGw || clean.startsWith(normGw + ' ') || clean.endsWith(' ' + normGw);
    });
}

function isBalanceInquiry(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);
    const hasInquiry = clean.includes('رصيد') || clean.includes('شكد عندي') || clean.includes('كم عندي') || clean.includes('فلوسي') || clean.includes('حسابي');
    const isTransfer = (clean.includes('حول') || clean.includes('ارسل') || clean.includes('دز') || clean.includes('ادفع') || clean.includes('سدد')) && (clean.includes('الف') || clean.includes('ألف') || /\d/.test(clean));
    return hasInquiry && !isTransfer;
}

function isTransactionsInquiry(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);
    return clean.includes('سجل الحركات') || clean.includes('سجل المعاملات') || clean.includes('اخر المعاملات') || clean.includes('اخر العمليات') || clean.includes('اخر الحركات') || clean.includes('تاريخ المعاملات') || clean.includes('المعاملات الاخيره') || clean.includes('الحركات الاخيره') || clean.includes('السجل');
}

function isBillInquiry(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);
    const hasBill = clean.includes('فاتوره') || clean.includes('فواتير') || clean.includes('قوائم') || clean.includes('قائمه');
    if (!hasBill) return false;

    // Remove bill inquiry descriptors before testing for payment action verbs
    const stripped = clean
        .replace(/غير\s*مدفوع[هة]?/g, '')
        .replace(/الغير\s*مدفوع[هة]?/g, '')
        .replace(/مدفوع[هة]?/g, '')
        .replace(/ما\s*مدفوع[هة]?/g, '')
        .replace(/مطلوب[هة]?/g, '')
        .replace(/المطلوب[هة]?/g, '');

    const isPayment = stripped.includes('ادفع') || stripped.includes('دفع') || stripped.includes('سدد') || stripped.includes('تسديد') || stripped.includes('سدلي') || stripped.includes('ادفعلي') || stripped.includes('حول');
    return !isPayment;
}

function isPayAllBillsRequest(text) {
    if (!text) return false;
    const clean = normalizeArabic(text);
    const hasPayment = clean.includes('ادفع') || clean.includes('دفع') || clean.includes('سدد') || clean.includes('تسديد') || clean.includes('سدلي') || clean.includes('ادفعلي');
    const hasAll = clean.includes('كل الفواتير') || clean.includes('جميع الفواتير') || clean.includes('الفواتير كلها') || clean.includes('كل فواتيري') || clean.includes('كل القوائم') || clean.includes('كلها');
    return hasPayment && hasAll;
}

function findMatchingBill(text, bills) {
    if (!text || !Array.isArray(bills)) return null;
    const clean = normalizeArabic(text);
    const unpaid = bills.filter(b => b.status === 'unpaid');

    // 1. Numeric / Ordinal selection from recent inquiry:
    // e.g. "1", "2", "3", "4", "رقم 1", "فاتورة 2", "نعم 2", "نعم مال 1"
    const singleNumMatch = clean.match(/(?:رقم|فاتوره|قائمه)?\s*([1-9])\b/);
    if (singleNumMatch && (clean.length <= 15 || clean.startsWith('نعم') || clean.startsWith('اي'))) {
        const idx = parseInt(singleNumMatch[1], 10) - 1;
        if (unpaid[idx]) return unpaid[idx];
    }

    if (clean.includes('الاول') || clean.includes('الاولى')) {
        if (unpaid[0]) return unpaid[0];
    }
    if (clean.includes('الثاني') || clean.includes('الثانيه')) {
        if (unpaid[1]) return unpaid[1];
    }
    if (clean.includes('الثالث') || clean.includes('الثالثه')) {
        if (unpaid[2]) return unpaid[2];
    }
    if (clean.includes('الرابع') || clean.includes('الرابعه')) {
        if (unpaid[3]) return unpaid[3];
    }

    // 2. Keyword matching on biller
    for (const b of bills) {
        const normBiller = normalizeArabic(b.biller);

        // Direct full match or account number
        if (clean.includes(normBiller)) return b;
        if (b.account_number && clean.includes(b.account_number.toLowerCase())) return b;

        // Electricity
        if ((clean.includes('كهرباء') || clean.includes('الكرخ')) && normBiller.includes('كهرباء')) {
            return b;
        }

        // Phone / Mobile Line
        if ((clean.includes('خط') || clean.includes('موبايل') || clean.includes('هاتف') || clean.includes('اتصال')) && (normBiller.includes('خط') || normBiller.includes('هاتف') || normBiller.includes('موبايل'))) {
            return b;
        }

        // Water
        if ((clean.includes('مياه') || clean.includes('ماء') || clean.includes('ماي') || clean.includes('البصره')) && normBiller.includes('مياه')) {
            return b;
        }

        // Internet (Match ONLY internet keywords, NEVER the assistant's name 'فاي' alone)
        if ((clean.includes('انترنت') || clean.includes('نت') || clean.includes('فايبر') || clean.includes('واي فاي') || clean.includes('شبكه')) && normBiller.includes('انترنت')) {
            return b;
        }
    }

    return null;
}

function detectBillPaymentIntent(userMessage, bills) {
    if (!userMessage || !Array.isArray(bills)) return null;
    const clean = normalizeArabic(userMessage);
    const unpaid = bills.filter(b => b.status === 'unpaid');

    // 1. Pay all bills
    if (isPayAllBillsRequest(userMessage)) {
        return { type: 'ALL', bills: unpaid };
    }

    // 2. Matching specific bill
    const matched = findMatchingBill(userMessage, bills);
    if (matched) {
        // Confirm it represents a genuine bill payment intent
        const isPaymentVerb = clean.includes('ادفع') || clean.includes('دفع') || clean.includes('سدد') || clean.includes('تسديد') || clean.includes('سدلي') || clean.includes('ادفعلي');
        const isBillKeyword = clean.includes('فاتوره') || clean.includes('قائمه') || clean.includes('حساب');

        if (isPaymentVerb || isBillKeyword) {
            return { type: 'SINGLE', bill: matched };
        }
    }

    return null;
}

function handleModelActions(rawReply, db, userMessage) {
    if (!rawReply || typeof rawReply !== 'string') return rawReply;

    const actionRegex = /<<<DB_ACTION>>>([\s\S]*?)<<<END_DB_ACTION>>>/;
    const match = rawReply.match(actionRegex);

    if (!match) {
        return rawReply;
    }

    try {
        const actionPayload = JSON.parse(match[1].trim());

        if (actionPayload.action === 'TRANSFER') {
            const numericAmt = Number(actionPayload.amount);

            if (db.user.balance < numericAmt) {
                return `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${numericAmt.toLocaleString()} د.ع.`;
            }

            if (pendingTransfer || isUserConfirmation(userMessage)) {
                const toExecute = pendingTransfer || {
                    recipient: actionPayload.recipient,
                    amount: numericAmt,
                    phone: actionPayload.phone
                };
                console.log('[Transfer Confirmed & Executed on DB]:', toExecute);
                const result = executeTransferMutation(toExecute);
                pendingTransfer = null;
                pendingDisambiguation = null;

                return `تم تأكيد التحويل بنجاح! دزيت ${toExecute.amount.toLocaleString()} د.ع إلى ${toExecute.recipient} (${toExecute.phone}). رصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
            } else {
                console.log('[Action Intercepted - Requiring Confirmation]:', actionPayload);
                pendingTransfer = {
                    recipient: actionPayload.recipient,
                    amount: numericAmt,
                    phone: actionPayload.phone
                };

                const remainingBal = db.user.balance - numericAmt;
                return `تفاصيل التحويل المطلوبة:\n• المستلم: ${pendingTransfer.recipient} (${pendingTransfer.phone})\n• المبلغ: ${pendingTransfer.amount.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
            }
        } else if (actionPayload.action === 'ADD_CONTACT') {
            const rawPhoneDigits = String(actionPayload.phone || '').replace(/\D/g, '');
            const userMessageDigits = userMessage.replace(/\D/g, '');

            const isAuthenticUserPhone = rawPhoneDigits.length >= 7 && userMessageDigits.includes(rawPhoneDigits.slice(-7));

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
        }
    } catch (err) {
        console.error('[Action Execution Error]', err.message);
    }

    return rawReply.replace(actionRegex, '').trim();
}

/* ==========================================================================
   Chat API Endpoint
   ========================================================================== */

app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    const selectedProvider = req.body.provider || req.body.model || 'local';

    if (!userMessage) {
        return res.status(400).json({ error: 'Message field is required.' });
    }

    // Prominent Terminal Log of the incoming user message
    console.log(`\n======================================================`);
    console.log(`📩 [Incoming User Message]: "${userMessage}"`);
    console.log(`⚙️  [Selected Provider]: "${selectedProvider}" (${PROVIDERS[selectedProvider]?.name || selectedProvider})`);
    console.log(`======================================================`);

    try {
        const db = readDatabase();

        // 0. Direct Balance Inquiry (ALWAYS from disk - Never hallucinated)
        if (isBalanceInquiry(userMessage)) {
            let reply = `رصيدك الحالي بمحفظتك هسة هو: ${db.user.balance.toLocaleString()} ${db.user.currency || 'IQD'}.`;
            if (pendingBillPayment) {
                reply += `\n\n(ملاحظة: عندك طلب معلق لتسديد فاتورة بقيمة ${pendingBillPayment.totalAmount.toLocaleString()} د.ع. إذا تريد تكمل كلي "نعم" أو "إلغاء").`;
            } else if (pendingTransfer) {
                reply += `\n\n(ملاحظة: عندك طلب معلق لتحويل ${pendingTransfer.amount.toLocaleString()} د.ع إلى ${pendingTransfer.recipient}. إذا تريد تكمل كلي "نعم" أو "إلغاء").`;
            }
            conversationHistory.push({ role: 'user', content: userMessage });
            conversationHistory.push({ role: 'assistant', content: reply });
            return res.json({ response: reply });
        }

        // 0b. Direct Transactions History Inquiry (from disk - Always 100% accurate)
        if (isTransactionsInquiry(userMessage)) {
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
            conversationHistory.push({ role: 'user', content: userMessage });
            conversationHistory.push({ role: 'assistant', content: reply });
            return res.json({ response: reply, openTransactionsDrawer: true });
        }


        // 1. Check for cancellation at any point
        if (isUserCancellation(userMessage)) {
            if (pendingTransfer || pendingDisambiguation || pendingBillPayment || pendingTransferRecipient) {
                console.log('\n❌ [Operation Cancelled by User]');
                pendingTransfer = null;
                pendingDisambiguation = null;
                pendingBillPayment = null;
                pendingTransferRecipient = null;
                const reply = 'صار عيوني، تم إلغاء العملية وما انخصم أي فلس من رصيدك.';
                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: reply });
                return res.json({ response: reply });
            }
        }

        // 2. Check if user is confirming an existing pending bill payment
        if (pendingBillPayment && isUserConfirmation(userMessage)) {
            try {
                const result = executeBillPaymentMutation(pendingBillPayment);
                const completed = pendingBillPayment;
                pendingBillPayment = null;

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

                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: reply });
                return res.json({ response: reply });
            } catch (mutationErr) {
                pendingBillPayment = null;
                console.error('[Bill Payment Error]:', mutationErr.message);
                const errorReply = `تعذر إتمام دفع الفاتورة: ${mutationErr.message}`;
                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: errorReply });
                return res.json({ response: errorReply });
            }
        }

        // 3. Check if user is confirming an existing pending transfer
        if (pendingTransfer && isUserConfirmation(userMessage)) {
            try {
                const result = executeTransferMutation(pendingTransfer);
                const completedTrx = pendingTransfer;
                pendingTransfer = null;
                pendingDisambiguation = null;

                console.log(`\n======================================================`);
                console.log(`✅ [TRANSACTION EXECUTED & SAVED TO DATABASE]`);
                console.log(`Transaction Type: TRANSFER`);
                console.log(`Recipient: ${completedTrx.recipient} (${completedTrx.phone})`);
                console.log(`Transfer Amount: ${completedTrx.amount.toLocaleString()} IQD`);
                console.log(`New Wallet Balance: ${result.newBalance.toLocaleString()} IQD`);
                console.log(`Database File: ${DB_FILE_PATH}`);
                console.log(`======================================================\n`);

                const reply = `تم تأكيد التحويل بنجاح! دزيت ${completedTrx.amount.toLocaleString()} د.ع إلى ${completedTrx.recipient} (${completedTrx.phone}). رصيدك الحالي هسة: ${result.newBalance.toLocaleString()} د.ع.`;
                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: reply });
                return res.json({ response: reply });
            } catch (mutationErr) {
                pendingTransfer = null;
                console.error('[Transfer Error]:', mutationErr.message);
                const errorReply = `تعذر إتمام التحويل: ${mutationErr.message}`;
                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: errorReply });
                return res.json({ response: errorReply });
            }
        }

        // 4. Check if user is inquiring about bills ("شنو الفواتير اللي عندي؟" / "شنو هي الفواتير الغير مدفوعة")
        if (isBillInquiry(userMessage)) {
            const unpaid = (db.bills || []).filter(b => b.status === 'unpaid');
            if (unpaid.length === 0) {
                const reply = 'ما عندك أي فواتير غير مدفوعة حالياً بمحفظتك، كل فواتيرك مسددة بالكامل! ✅';
                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: reply });
                return res.json({ response: reply });
            }

            const totalUnpaid = unpaid.reduce((sum, b) => sum + Number(b.amount || 0), 0);
            const list = unpaid.map((b, i) => `${i + 1}. ${b.biller} (رقم الحساب: ${b.account_number}) - المبلغ: ${b.amount.toLocaleString()} د.ع`).join('\n');
            const reply = `عندك ${unpaid.length} فواتير غير مدفوعة حالياً بمحفظتك:\n${list}\n\nالمجموع الكلي: ${totalUnpaid.toLocaleString()} د.ع.\n\nتريد تسدد أي وحدة منها؟ تكدر تكلي: "ادفع مال كهرباء" أو "ادفع رقم 1" أو "ادفع كل الفواتير".`;
            conversationHistory.push({ role: 'user', content: userMessage });
            conversationHistory.push({ role: 'assistant', content: reply });
            return res.json({ response: reply });
        }

        // 5. Check if user wants to pay ALL bills or a SPECIFIC bill
        const billIntent = detectBillPaymentIntent(userMessage, db.bills);
        if (billIntent) {
            if (billIntent.type === 'ALL') {
                const unpaid = (db.bills || []).filter(b => b.status === 'unpaid');
                if (unpaid.length === 0) {
                    const reply = 'ما عندك أي فواتير غير مدفوعة حالياً بمحفظتك، كل فواتيرك مسددة بالكامل! ✅';
                    conversationHistory.push({ role: 'user', content: userMessage });
                    conversationHistory.push({ role: 'assistant', content: reply });
                    return res.json({ response: reply });
                }

                const totalAmount = unpaid.reduce((sum, b) => sum + Number(b.amount || 0), 0);
                if (db.user.balance < totalAmount) {
                    const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع كل الفواتير البالغة ${totalAmount.toLocaleString()} د.ع.`;
                    conversationHistory.push({ role: 'user', content: userMessage });
                    conversationHistory.push({ role: 'assistant', content: reply });
                    return res.json({ response: reply });
                }

                pendingBillPayment = {
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

                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: reply });
                return res.json({ response: reply });
            } else if (billIntent.type === 'SINGLE') {
                const targetBill = billIntent.bill;
                if (targetBill.status === 'paid') {
                    const reply = `فاتورة "${targetBill.biller}" مسددة مسبقاً وما عليها أي مستحقات حالياً! ✅`;
                    conversationHistory.push({ role: 'user', content: userMessage });
                    conversationHistory.push({ role: 'assistant', content: reply });
                    return res.json({ response: reply });
                }

                if (db.user.balance < targetBill.amount) {
                    const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لدفع فاتورة ${targetBill.biller} البالغة ${targetBill.amount.toLocaleString()} د.ع.`;
                    conversationHistory.push({ role: 'user', content: userMessage });
                    conversationHistory.push({ role: 'assistant', content: reply });
                    return res.json({ response: reply });
                }

                pendingBillPayment = {
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

                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: reply });
                return res.json({ response: reply });
            }
        }

        // 7. Check if user is resolving an ambiguous contact (pendingDisambiguation)
        if (pendingDisambiguation) {
            const selected = resolveContactSelection(userMessage, pendingDisambiguation.matches);
            if (selected) {
                const amount = extractAmount(userMessage) || pendingDisambiguation.amount;
                pendingDisambiguation = null;

                if (amount) {
                    if (db.user.balance < amount) {
                        const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${amount.toLocaleString()} د.ع.`;
                        conversationHistory.push({ role: 'user', content: userMessage });
                        conversationHistory.push({ role: 'assistant', content: reply });
                        return res.json({ response: reply });
                    }

                    pendingTransfer = {
                        recipient: selected.alias || selected.name,
                        phone: selected.phone,
                        amount: amount
                    };

                    const remainingBal = db.user.balance - amount;

                    console.log(`\n⏳ [Transfer Step 1 - Awaiting User Confirmation]:`);
                    console.log(`   Recipient: ${pendingTransfer.recipient} (${pendingTransfer.phone})`);
                    console.log(`   Amount: ${pendingTransfer.amount.toLocaleString()} IQD`);
                    console.log(`   Remaining Balance After Transfer: ${remainingBal.toLocaleString()} IQD\n`);

                    const reply = `تمام عيوني، اخترت ${selected.alias || selected.name}.\n\nتفاصيل التحويل:\n• المستلم: ${selected.alias || selected.name} (${selected.phone})\n• المبلغ: ${amount.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                    conversationHistory.push({ role: 'user', content: userMessage });
                    conversationHistory.push({ role: 'assistant', content: reply });
                    return res.json({ response: reply });
                } else {
                    pendingTransferRecipient = {
                        name: selected.alias || selected.name,
                        phone: selected.phone
                    };
                    const reply = `صار عيوني، اخترت ${selected.alias || selected.name} (${selected.phone}).\nشكد المبلغ اللي تريد تحوله له؟`;
                    conversationHistory.push({ role: 'user', content: userMessage });
                    conversationHistory.push({ role: 'assistant', content: reply });
                    return res.json({ response: reply });
                }
            }
        }

        // 8. Check if the user message mentions a name matching multiple contacts
        const ambiguous = findAmbiguousContacts(userMessage, db.contacts);
        if (ambiguous) {
            const extractedAmt = extractAmount(userMessage);
            pendingDisambiguation = {
                name: ambiguous.baseName,
                matches: ambiguous.matches,
                amount: extractedAmt
            };

            console.log(`\n🔍 [Contact Disambiguation]: Found ${ambiguous.matches.length} contacts matching "${ambiguous.baseName}". Waiting for user selection.`);

            const listText = ambiguous.matches.map((c, i) => `${i + 1}. ${c.alias || c.name} (${c.phone})`).join('\n');
            const reply = `يا هلا عيوني، عندك أكثر من جهة اتصال باسم "${ambiguous.baseName}" بمحفظتك:\n${listText}\n\nيا واحد منهم تقصد؟ يرجى كتابة الرقم أو الاسم الكامل حتى أجهّزلك التحويل.`;
            conversationHistory.push({ role: 'user', content: userMessage });
            conversationHistory.push({ role: 'assistant', content: reply });
            return res.json({ response: reply });
        }

        // 9. Check if user is resolving a pending recipient waiting for an amount
        if (pendingTransferRecipient) {
            const extractedAmt = extractAmount(userMessage);
            if (extractedAmt) {
                const target = pendingTransferRecipient;
                pendingTransferRecipient = null;

                if (db.user.balance < extractedAmt) {
                    const reply = `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${extractedAmt.toLocaleString()} د.ع.`;
                    conversationHistory.push({ role: 'user', content: userMessage });
                    conversationHistory.push({ role: 'assistant', content: reply });
                    return res.json({ response: reply });
                }

                pendingTransfer = {
                    recipient: target.name,
                    phone: target.phone,
                    amount: extractedAmt
                };

                const remainingBal = db.user.balance - extractedAmt;
                const reply = `تفاصيل التحويل:\n• المستلم: ${target.name} (${target.phone})\n• المبلغ: ${extractedAmt.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: reply });
                return res.json({ response: reply });
            }
        }

        // 10. Check if user is inquiring about contacts ("ما عندك رقم جعفر؟", "منو مسجل عندي؟", "هل فلان مسجل؟")
        const contactInquiryReply = handleContactInquiry(userMessage, db.contacts);
        if (contactInquiryReply) {
            conversationHistory.push({ role: 'user', content: userMessage });
            conversationHistory.push({ role: 'assistant', content: contactInquiryReply });
            return res.json({ response: contactInquiryReply });
        }

        // 11. Check direct transfer intent (e.g. "هل تقدر تحول لي لجعفر", "حول لسيف", "حول 50 الف لحسين")
        const transferIntentReply = handleDirectTransferIntent(userMessage, db);
        if (transferIntentReply) {
            conversationHistory.push({ role: 'user', content: userMessage });
            conversationHistory.push({ role: 'assistant', content: transferIntentReply });
            return res.json({ response: transferIntentReply });
        }

        const dbData = JSON.stringify(db, null, 2);

        const systemPrompt = `You are "فاي" (VI) — a smart, friendly, highly capable Iraqi AI financial assistant for digital wallets.

IDENTITY & NAME RULES (MANDATORY):
- Your name is "فاي" (VI) — المساعد المالي الذكي.
- You are strictly an independent AI assistant. Your name is exclusively "فاي" (VI). NEVER claim any name other than "فاي (VI)" or associate your identity with any external telecom or wallet company.
- When asked "شنو اسمك؟", "منو انت؟", "مو اسمك فاي؟", or asked to introduce yourself: Always confirm with clarity, confidence, and warmth in Iraqi Arabic:
  "اسمي فاي (VI) - مساعدك المالي الذكي، وبخدمتك دائماً لمساعدتك في محفظتك الرقمية، التحويلات، ودفع الفواتير بكل سهولة وأمان!"

LANGUAGE & PERSONALITY:
- Always speak in authentic, warm, polite Iraqi Arabic dialect (لهجة عراقية محبوبة وراقية).
- Use natural expressions: "عيوني"، "تدلل"، "بخدمتك"، "شلون أگدر أساعدك"، "هسة"، "شكد"، "يا هلا"، "تسلم"، "ماكو".
- Strictly avoid Egyptian words (like "عايز", "عشان") or Gulf words (like "تبي"). You are proudly Iraqi.
- Be perceptive, intelligent, and understand the real meaning of the user's words.

CASUAL CONVERSATION & SOCIAL CHAT (CRITICAL):
- When the user talks to you socially or asks about your well-being:
  * "دا اسأل عليك" (I'm checking up on you / asking how you are) / "شلونك" / "شخبارك" / "شكو ماكو":
    The user is asking how YOU (فاي) are doing! Words like "عليك" or "فاي" are NEVER person names or recipients for a financial transfer!
    Reply politely and warmly: "تسلملي عيوني ويحفظك ربي! اني بخير وبأحسن حال وما قصرت بسؤالك يا طيب. بشرني أنت شلونك، وبشنو أگدر أساعدك بمحفظتك اليوم؟"
  * "شكراً" / "عاشت ايدك" / "تسلم" / "مشكور": Reply gracefully ("تدلل عيوني بخدمتك", "وايدك العايشة يا غالي").
- DO NOT treat friendly conversation as an error, and DO NOT say "هذا الشخص مو مسجل بقائمة اتصالاتك" unless the user is EXPLICITLY requesting to transfer money to a named person!

GENERAL INTELLIGENCE & OFF-TOPIC QUESTIONS:
- You are a fully capable AI model. If the user asks general questions (math, calculations, explanation, daily advice): Answer smartly, concisely, and helpfully in Iraqi Arabic, then politely remind them that you are also ready to assist with their wallet whenever they need.

CURRENT DATABASE CONTEXT:
${dbData}

CURRENT USER BALANCE:
${db.user.balance} IQD (${db.user.balance.toLocaleString()} دينار عراقي).

ARITHMETIC CHECK:
The user currently has ${db.user.balance.toLocaleString()} IQD. 
Transfer amounts such as 100,000 IQD (100 ألف) or 50,000 IQD are STRICTLY LESS than ${db.user.balance.toLocaleString()} IQD and ARE VALID. Do NOT claim the balance is insufficient when the requested amount is <= ${db.user.balance}!

CRITICAL TRUTH & ANTI-HALLUCINATION RULES:
1. NEVER INVENT PHONE NUMBERS: You are STRICTLY FORBIDDEN from inventing, fabricating, or guessing any phone number. You may ONLY use phone numbers explicitly provided by the user in their message or already stored in CURRENT DATABASE CONTEXT.
2. NEVER INVENT TRANSFER AMOUNTS: If the user didn't mention a specific amount, DO NOT assume a number! Always ask: "شكد المبلغ اللي تريد تحوله؟"
3. ONLY PROCESS TRANSFERS WHEN INTENT IS CLEAR: Only look for contacts when the user clearly asks to send money (e.g. "حول", "دز", "ارسل"). If an explicit recipient name does not exist in contacts and no phone number was given, explain: "هذا الشخص مو مسجل بقائمة اتصالاتك" and ask for their phone number.
4. NEVER CLAIM TO ADD A CONTACT unless the user explicitly provided both the name and a real phone number in their message.

DECISION FLOW (Evaluate in order):

1. BALANCE INQUIRY:
If the user asks about their balance, reply with their exact balance from user.balance (${db.user.balance.toLocaleString()} ${db.user.currency}). Do not guess.

2. AMOUNT CHECKS:
- If the amount is zero or negative: Reject in Iraqi dialect. Transfer amounts must be positive numbers.
- If the amount exceeds current balance (${db.user.balance} IQD): Stop immediately and explain that the balance is insufficient.

3. CONTACT CHECKS & INITIAL TRANSFER REQUEST (Search strictly in "contacts"):
- No Match: If the name does not exist at all, say that the contact is not in their list and ask for their phone number.
- Multiple Matches: If the user says a name that matches more than one entry, list all matching contacts with their full names and phone numbers. Ask the user to choose which one. DO NOT confirm or transfer yet.
- Single Match: Summarize recipient name, phone, amount, and remaining balance. Ask clearly: "متأكد تريد أحول؟ (يرجى الرد بـ نعم أو إلغاء)"
CRITICAL SECURITY RULE: NEVER output <<<DB_ACTION>>> in this step! You must WAIT for the user to explicitly confirm in their next message.

4. TRANSFER CONFIRMATION:
- If and ONLY IF the assistant previously asked for confirmation and the user replies with explicit confirmation (e.g. "نعم", "أكد", "موافق", "أي", "توكل", "أرسل", "دز"):
Confirm success warmly, and attach the action tag at the very end:
<<<DB_ACTION>>>
{
  "action": "TRANSFER",
  "recipient": "<Full Name>",
  "amount": <number>,
  "phone": "<Phone>"
}
<<<END_DB_ACTION>>>
- If the user says "لا" or "إلغاء": Confirm cancellation without any action tag.

5. ADD CONTACT:
- If the user asks to save or add a contact:
Confirm addition, and attach the action tag at the very end:
<<<DB_ACTION>>>
{
  "action": "ADD_CONTACT",
  "name": "<Name>",
  "alias": "<Name>",
  "phone": "<Phone>",
  "wallet_provider": "VI"
}
<<<END_DB_ACTION>>>`;

        conversationHistory.push({ role: "user", content: userMessage });

        if (conversationHistory.length > 12) {
            conversationHistory = conversationHistory.slice(-12);
        }

        const payloadMessages = [
            { role: "system", content: systemPrompt },
            ...conversationHistory
        ];

        let rawBotReply = '';
        try {
            console.log(`🤖 [Routing to Provider]: "${selectedProvider}" (${PROVIDERS[selectedProvider]?.name || selectedProvider})`);
            const completion = await callUnifiedChatCompletion(selectedProvider, payloadMessages, {
                temperature: 0.2,
                max_tokens: 500
            });
            rawBotReply = completion.choices?.[0]?.message?.content || "(لم يتم استلام رد من النموذج)";
        } catch (fetchErr) {
            console.error(`[${selectedProvider} Completion Error]:`, fetchErr.message);
            let offlineReply = '';
            if (selectedProvider === 'local') {
                offlineReply = '⚠️ عيوني، نموذج الذكاء الاصطناعي (LM Studio) غير متصل حالياً أو ما زال قيد التحميل في الحاسبة.\n\nيرجى التأكد من تشغيل السيرفر من داخل برنامج LM Studio (الضغط على Start Server على البورت 1234) حتى أگدر أفكر وأجاوبك مباشرة!';
            } else if (selectedProvider === 'gemini') {
                offlineReply = `⚠️ تعذر الاتصال بنموذج Google Gemini.\n\nالسبب: ${fetchErr.message}\n\n💡 يرجى التأكد من ضبط GEMINI_API_KEY داخل ملف .env والتأكد من توفر اتصال بالإنترنت.`;
            } else if (selectedProvider === 'groq') {
                offlineReply = `⚠️ تعذر الاتصال بنموذج Groq.\n\nالسبب: ${fetchErr.message}\n\n💡 يرجى التأكد من ضبط GROQ_API_KEY داخل ملف .env والتأكد من توفر اتصال بالإنترنت.`;
            } else {
                offlineReply = `⚠️ خطأ في الاتصال بالنموذج (${selectedProvider}): ${fetchErr.message}`;
            }
            conversationHistory.push({ role: "assistant", content: offlineReply });
            return res.json({ response: offlineReply });
        }

        const cleanBotReply = handleModelActions(rawBotReply, db, userMessage);
        conversationHistory.push({ role: "assistant", content: cleanBotReply });

        res.json({ response: cleanBotReply });

    } catch (error) {
        console.error('[Server Error]:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/db', (req, res) => {
    try {
        const db = readDatabase();
        res.json(db);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/transactions', (req, res) => {
    try {
        const db = readDatabase();
        const trxs = db.recent_transactions || [];
        const totalSpent = trxs.reduce((sum, t) => sum + Number(t.amount || 0), 0);
        res.json({
            transactions: trxs,
            balance: db.user.balance,
            currency: db.user.currency || 'IQD',
            userName: db.user.name || 'محمد',
            totalSpent,
            count: trxs.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/reset', (req, res) => {
    conversationHistory = [];
    pendingTransfer = null;
    pendingDisambiguation = null;
    pendingBillPayment = null;
    pendingTransferRecipient = null;
    resetDatabase();
    console.log('🔄 [Conversation history, pending state, and wallet database reset to defaults]');
    res.json({ status: 'Conversation history and database reset successful' });
});

/* ==========================================================================
   مسارات تسجيل تقييمات الذكاء الاصطناعي (Likes & Dislikes)
   ========================================================================== */

app.post('/api/feedback', (req, res) => {
    try {
        const { type, msgId, userMessage, botResponse, theme } = req.body || {};

        if (!type || !msgId) {
            return res.status(400).json({ error: 'Missing required feedback fields: type, msgId' });
        }

        let likes = readFeedbackFile(FEEDBACK_LIKES_PATH);
        let dislikes = readFeedbackFile(FEEDBACK_DISLIKES_PATH);

        // Remove any prior evaluation with the same msgId from both files to ensure clean state
        likes = likes.filter(item => item.msgId !== msgId);
        dislikes = dislikes.filter(item => item.msgId !== msgId);

        const now = new Date();
        const readableDate = now.toLocaleString('ar-IQ', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });

        if (type === 'like') {
            const record = {
                id: `fb_like_${Date.now()}`,
                msgId,
                type: 'like',
                userMessage: userMessage || '',
                botResponse: botResponse || '',
                theme: theme || 'dark',
                timestamp: now.toISOString(),
                readableDate
            };
            likes.unshift(record); // Prepend to top
            saveFeedbackFile(FEEDBACK_LIKES_PATH, likes);
            saveFeedbackFile(FEEDBACK_DISLIKES_PATH, dislikes);
            console.log(`👍 [Feedback] Like recorded for msgId: ${msgId}`);
            return res.json({ success: true, action: 'liked', recordId: record.id, totalLikes: likes.length });
        } else if (type === 'dislike') {
            const record = {
                id: `fb_dislike_${Date.now()}`,
                msgId,
                type: 'dislike',
                userMessage: userMessage || '',
                botResponse: botResponse || '',
                theme: theme || 'dark',
                timestamp: now.toISOString(),
                readableDate
            };
            dislikes.unshift(record); // Prepend to top
            saveFeedbackFile(FEEDBACK_DISLIKES_PATH, dislikes);
            saveFeedbackFile(FEEDBACK_LIKES_PATH, likes);
            console.log(`👎 [Feedback] Dislike recorded for msgId: ${msgId}`);
            return res.json({ success: true, action: 'disliked', recordId: record.id, totalDislikes: dislikes.length });
        } else if (type === 'remove') {
            saveFeedbackFile(FEEDBACK_LIKES_PATH, likes);
            saveFeedbackFile(FEEDBACK_DISLIKES_PATH, dislikes);
            console.log(`🔄 [Feedback] Feedback cleared for msgId: ${msgId}`);
            return res.json({ success: true, action: 'removed' });
        }

        res.status(400).json({ error: 'Invalid feedback type' });
    } catch (err) {
        console.error('[Feedback API Error]:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/feedback/likes', (req, res) => {
    try {
        const likes = readFeedbackFile(FEEDBACK_LIKES_PATH);
        res.json({ total: likes.length, items: likes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/feedback/dislikes', (req, res) => {
    try {
        const dislikes = readFeedbackFile(FEEDBACK_DISLIKES_PATH);
        res.json({ total: dislikes.length, items: dislikes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`  AI Financial Agent Backend running on port ${PORT}`);
    console.log(`  Connected to LM Studio: ${LM_STUDIO_URL}`);
    console.log(`  Database File: ${DB_FILE_PATH}`);
    console.log(`====================================================`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n[Notice]: Port ${PORT} is already in use by another running process.`);
        console.error(`If the server is already running, you do not need to start it again.\n`);
    } else {
        console.error('\n[Server Error]:', err.message);
    }
});