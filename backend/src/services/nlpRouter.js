function normalizeDigits(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/[٠۰]/g, '0')
        .replace(/[١۱]/g, '1')
        .replace(/[٢۲]/g, '2')
        .replace(/[٣۳]/g, '3')
        .replace(/[٤۴]/g, '4')
        .replace(/[٥۵]/g, '5')
        .replace(/[٦۶]/g, '6')
        .replace(/[٧۷]/g, '7')
        .replace(/[٨۸]/g, '8')
        .replace(/[٩۹]/g, '9');
}

function normalizeArabic(text) {
    if (!text || typeof text !== 'string') return '';
    return normalizeDigits(text)
        .trim()
        .toLowerCase()
        .replace(/[إأآا]/g, 'ا')
        .replace(/[ى]/g, 'ي')
        .replace(/[ة]/g, 'ه');
}

function extractAmount(text) {
    if (!text) return null;
    const clean = normalizeArabic(text);

    // 1. Spelled out Arabic amounts - Millions (checked first to avoid collisions with "مليون")
    if (clean.includes('مليونين ونص') || clean.includes('مليونين ونصف')) return 2500000;
    if (clean.includes('مليونين')) return 2000000;
    if (clean.includes('مليون ونص') || clean.includes('مليون ونصف')) return 1500000;
    if (clean.includes('مليون وربع')) return 1250000;
    if (clean.includes('نص مليون') || clean.includes('نصف مليون')) return 500000;
    if (clean.includes('ربع مليون')) return 250000;

    // Numeric with million multiplier: e.g. "2 مليون", "1.5 مليون", "3 مليون" (checked before single "مليون")
    const millionMatch = clean.match(/(\d+(?:[.,]\d+)?)\s*(?:مليون|ملايين)(?:[\s،,?!.]|$)/);
    if (millionMatch) {
        const numStr = millionMatch[1].replace(',', '.');
        return Math.round(parseFloat(numStr) * 1000000);
    }

    if (clean.includes('ثلاث ملايين') || clean.includes('ثلاثة ملايين')) return 3000000;
    if (clean.includes('اربع ملايين') || clean.includes('اربعة ملايين')) return 4000000;
    if (clean.includes('خمس ملايين') || clean.includes('خمسة ملايين')) return 5000000;
    if (clean.includes('مليون') || clean.includes('ملايين')) return 1000000;

    // 2. Spelled out Arabic amounts - Thousands
    if (clean.includes('خمسمية الف') || clean.includes('خمسمائة الف') || clean.includes('خمس مية الف')) return 500000;
    if (clean.includes('اربعمية الف') || clean.includes('اربعمائة الف') || clean.includes('اربع مية الف')) return 400000;
    if (clean.includes('ثلاثمية الف') || clean.includes('ثلاثمائة الف') || clean.includes('ثلاث مية الف')) return 300000;
    if (clean.includes('ميتين وخمسين الف') || clean.includes('مئتان وخمسين الف')) return 250000;
    if (clean.includes('ميتين الف') || clean.includes('مئتان الف')) return 200000;
    if (clean.includes('مية وخمسين') || clean.includes('مئة وخمسين')) return 150000;
    if (clean.includes('مية الف') || clean.includes('مئة الف') || clean.includes('ميه الف')) return 100000;
    if (clean.includes('تسعين الف') || clean.includes('تسعين ألف')) return 90000;
    if (clean.includes('ثمانين الف') || clean.includes('ثمانين ألف')) return 80000;
    if (clean.includes('سبعين الف') || clean.includes('سبعين ألف')) return 70000;
    if (clean.includes('خمسة وسبعين الف') || clean.includes('خمسة وسبعين ألف') || clean.includes('خمسه وسبعين الف')) return 75000;
    if (clean.includes('ستين الف') || clean.includes('ستين ألف')) return 60000;
    if (clean.includes('خمسين الف') || clean.includes('خمسين ألف')) return 50000;
    if (clean.includes('خمسة واربعين الف') || clean.includes('خمسة واربعين ألف') || clean.includes('خمسه واربعين الف')) return 45000;
    if (clean.includes('اربعين الف') || clean.includes('اربعين ألف') || clean.includes('أربعين الف') || clean.includes('أربعين ألف')) return 40000;
    if (clean.includes('خمسة وثلاثين الف') || clean.includes('خمسة وثلاثين ألف') || clean.includes('خمسه وثلاثين الف')) return 35000;
    if (clean.includes('ثلاثين الف') || clean.includes('ثلاثين ألف')) return 30000;
    if (clean.includes('خمسه وعشرين الف') || clean.includes('خمسة وعشرين الف') || clean.includes('خمسة وعشرين ألف') || clean.includes('خمسه وعشرين ألف')) return 25000;
    if (clean.includes('عشرين الف') || clean.includes('عشرين ألف')) return 20000;
    if (clean.includes('خمسطاش الف') || clean.includes('خمسة عشر الف') || clean.includes('خمسه عشر الف')) return 15000;
    if (clean.includes('عشره الاف') || clean.includes('عشرة الاف') || clean.includes('عشرة آلاف') || clean.includes('عشره آلاف')) return 10000;
    if (clean.includes('تسعه الاف') || clean.includes('تسعة الاف') || clean.includes('تسعة آلاف')) return 9000;
    if (clean.includes('ثمانيه الاف') || clean.includes('ثمانية الاف') || clean.includes('ثمانية آلاف')) return 8000;
    if (clean.includes('سبعه الاف') || clean.includes('سبعة الاف') || clean.includes('سبعة آلاف')) return 7000;
    if (clean.includes('سته الاف') || clean.includes('ستة الاف') || clean.includes('ستة آلاف')) return 6000;
    if (clean.includes('خمسه الاف') || clean.includes('خمسة الاف') || clean.includes('خمسة آلاف') || clean.includes('خمسه آلاف')) return 5000;
    if (clean.includes('اربعه الاف') || clean.includes('اربعة الاف') || clean.includes('أربعة آلاف')) return 4000;
    if (clean.includes('ثلاث الاف') || clean.includes('ثلاثة الاف') || clean.includes('تلاث الاف')) return 3000;
    if (clean.includes('الفين') || clean.includes('ألفين')) return 2000;
    if (clean.includes('ميه') || clean.includes('مية') || clean.includes('مئة')) return 100000;

    // 4. Numeric with thousand multiplier: e.g. "100 الف", "50 ألف", "25k"
    const thousandMatch = clean.match(/(\d+[\d,.]*)\s*(?:ألف|الف|آلاف|الاف|k)(?:[\s،,?!.]|$)/i);
    if (thousandMatch) {
        const numStr = thousandMatch[1].replace(/[,.]/g, '');
        return Math.round(parseFloat(numStr) * 1000);
    }

    // 5. Explicit currency suffix: e.g. "500 دينار", "25000 د.ع", "50000 iqd"
    const currencyMatch = clean.match(/(?:^|[\s،,])(\d+[\d,.]*)\s*(?:دينار|د\.ع|iqd)(?:[\s،,?!.]|$)/i);
    if (currencyMatch) {
        return parseInt(currencyMatch[1].replace(/[,.]/g, ''), 10);
    }

    // 6. Comma/dot separated numbers: e.g. "100,000", "1,000,000"
    const formattedMatch = clean.match(/(?:^|[\s،,])(\d{1,3}(?:[,.]\d{3})+)(?:[\s،,?!.]|$)/);
    if (formattedMatch) {
        return parseInt(formattedMatch[1].replace(/[,.]/g, ''), 10);
    }

    // Prepare text for plain digit matching: remove phone numbers (078/077/075...) and account numbers
    let plainClean = clean
        .replace(/(?:(?:\+|00)?964[\s-]*)?0?7[578][\s\d-]{7,15}(?:[\s،,?!.]|$)/g, ' ')
        .replace(/(?:حساب|بطاق[هة]|ماستركارد|ماستر\s*كارد|فيزا|account|card|mastercard)[\s:]*(?:رقم[\s:]*)?[0-9\s-]{4,20}/gi, ' ');

    // 7. Plain digits: e.g. "100000", "50000", "25000" (4 to 8 digits)
    const plainMatch = plainClean.match(/(?:^|[\s،,])(\d{4,8})(?:[\s،,?!.]|$)/);
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
    if (!userMessage || !Array.isArray(matches) || matches.length === 0) return null;
    const cleanDigits = normalizeDigits(userMessage);
    const raw = userMessage.trim().toLowerCase();
    const normalized = normalizeArabic(cleanDigits).replace(/[.,!?،؟\-_()]/g, ' ').trim();

    // 1. Direct number / Arabic word / Ordinal mapping:
    const numMap = {
        '1': 0, 'واحد': 0, 'الاول': 0, 'اول': 0,
        '2': 1, 'اثنين': 1, 'ثنين': 1, 'الثاني': 1, 'ثاني': 1,
        '3': 2, 'تلاثة': 2, 'ثلاثة': 2, 'الثالث': 2, 'ثالث': 2,
        '4': 3, 'اربعة': 3, 'أربعة': 3, 'الرابع': 3, 'رابع': 3,
        '5': 4, 'خمسة': 4, 'الخامس': 4, 'خامس': 4
    };

    // Check direct word / prefix matching:
    for (const [kw, idx] of Object.entries(numMap)) {
        if (matches[idx]) {
            if (normalized === kw || 
                normalized === `رقم ${kw}` || 
                normalized === `الرقم ${kw}` || 
                normalized === `خيار ${kw}` || 
                normalized === `الخيار ${kw}` ||
                normalized === `خيار رقم ${kw}` ||
                normalized === `الخيار رقم ${kw}` ||
                normalized.startsWith(`${kw} `) ||
                normalized.endsWith(` ${kw}`)) {
                return matches[idx];
            }
        }
    }

    // Direct single digit regex anywhere in string (e.g. "1", "1.", "رقم 1", "الخيار 1", "١")
    const digitMatch = normalized.match(/(?:^|\s)(?:رقم\s*|الرقم\s*|خيار\s*|الخيار\s*)?([1-9])(?:\s|$)/);
    if (digitMatch) {
        const idx = parseInt(digitMatch[1], 10) - 1;
        if (matches[idx]) return matches[idx];
    }

    // Phone digits matching:
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 4) {
        const found = matches.find(c => (c.phone || '').replace(/\D/g, '').includes(digits));
        if (found) return found;
    }

    // Distinguishing alias words (e.g. "كمال", "جاسم", "الفيترجي", "المصلح", "صديق الجامعة"):
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
        if (normName && normalized.includes(normName)) return c;
    }

    return null;
}

function isDisambiguationAbandonment(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = normalizeArabic(text);
    return clean.includes('ما اعرفه') || clean.includes('ما اعرفة') || clean.includes('ما اعرفها') ||
           clean.includes('ما اعرف') || clean.includes('ما ادري') || clean.includes('ولا واحد') ||
           clean.includes('ولا شخص') || clean.includes('ولا وحده') || clean.includes('ولا وحدة') ||
           clean.includes('مو ذولي') || clean.includes('مو هذولي') || clean.includes('مو ذولة') ||
           clean.includes('مو هما') || clean.includes('مو هم') || clean.includes('مو هو') || clean.includes('مو هذا') ||
           clean.includes('عوفه') || clean.includes('اتركه') || clean.includes('اترك الموضوع') ||
           clean.includes('انسى') || clean.includes('بطلت') || clean.includes('ما اريد احول') ||
           clean.includes('ما اريد') || clean.includes('هونت');
}

function extractUserPhoneCandidates(text) {
    if (!text || typeof text !== 'string') return [];
    const norm = normalizeDigits(text);
    const regex = /(?:^|[^\d+])(?:(?:\+|00)?964[\s-]*)?0?(7[578](?:[\s-]*\d)+)(?!\d)/g;
    const results = [];
    let match;
    while ((match = regex.exec(norm)) !== null) {
        const rawDigits = match[1].replace(/\D/g, '');
        const full = '0' + rawDigits;
        if (!results.includes(full)) {
            results.push(full);
        }
    }
    return results;
}

function isContactCreationIntent(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = normalizeArabic(text);

    // Common Iraqi contact creation phrases
    const directPhrases = [
        'ضيفه عندك', 'ضيفة عندك', 'احفظه عندك', 'احفظة عندك', 'سجله عندك', 'سجلة عندك',
        'ضيف هذا الرقم', 'احفظ هذا الرقم', 'سجل هذا الرقم', 'خزن هذا الرقم',
        'اي ضيفه عندك', 'اي ضيفه', 'اي احفظه', 'اي سجله', 'إي ضيفه عندك', 'إي ضيفه', 'إي احفظه', 'إي سجله',
        'ضيف جهة اتصال', 'احفظ جهة اتصال', 'اضافة جهة اتصال'
    ];

    if (directPhrases.some(p => clean.includes(p))) return true;

    // Standalone single-word action commands with strict word boundaries
    const singleWordActions = ['ضيفه', 'ضيفة', 'احفظه', 'احفظة', 'سجله', 'سجلة', 'خزنه', 'خزنة'];
    const hasStandaloneAction = singleWordActions.some(w => {
        const regex = new RegExp(`(^|[\\s،,])(${w})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });
    if (hasStandaloneAction) return true;

    const hasAddVerb = clean.includes('ضيف') || clean.includes('اضف') || clean.includes('احفظ') ||
                       (/(^|[\s،,])سجل([\s،,]|$)/.test(clean)) || clean.includes('خزن') || clean.includes('اضافة') || clean.includes('حفظ');

    const hasContactContext = clean.includes('عندك') || clean.includes('بمحفظتك') || clean.includes('بجهات') ||
                             clean.includes('جهات الاتصال') || clean.includes('بالاسماء') || clean.includes('بالاصدقاء') ||
                             clean.includes('رقم') || clean.includes('الرقم') || clean.includes('باسم') ||
                             clean.includes('اسمه') || clean.includes('اسم');

    return hasAddVerb && hasContactContext;
}

function extractContactNameFromMessage(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.trim();

    // Match "باسم ...", "اسمه ...", "سميه ...", "اسم ..."
    const nameMatch = clean.match(/(?:باسم|اسمه|سميه|اسم)\s+([^\s,،]+(?:\s+[^\s,،]+)?)/i);
    if (nameMatch) {
        const rawName = nameMatch[1].trim();
        const stopWords = ['عندك', 'محفظتك', 'رقم', 'هاتف', 'هذا', 'جهة', 'اتصال'];
        if (!stopWords.includes(rawName)) {
            return rawName;
        }
    }

    return null;
}

function isContactsListInquiry(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = normalizeArabic(text);

    // If it's a contact creation/addition, it is NOT an inquiry to show the list!
    if (isContactCreationIntent(text) || clean.includes('ضيف') || clean.includes('اضف') || clean.includes('احفظ') || clean.includes('اضافة') || clean.includes('حفظ')) {
        return false;
    }

    // Direct phrases (including speech-to-text slips like جهاز instead of جهات)
    const phrases = [
        'جهات اتصالي', 'جهات اتصالاتي', 'جهات الاتصال', 'جهات اتصال',
        'جهاز اتصالي', 'جهاز اتصالاتي', 'جهاز الاتصال', 'جهاز اتصال',
        'قائمه اتصالي', 'قائمة اتصالي', 'قائمه اتصالاتي', 'قائمة اتصالاتي', 'قائمه الاتصال', 'قائمة الاتصال', 'قائمه اتصال', 'قائمة اتصال',
        'قائمه جهات اتصال', 'قائمة جهات اتصال', 'قائمه جهات اتصالي', 'قائمة جهات اتصالي', 'قائمه جهات اتصالاتي', 'قائمة جهات اتصالاتي',
        'قائمه جهاز اتصال', 'قائمة جهاز اتصال', 'قائمه جهاز اتصالي', 'قائمة جهاز اتصالي', 'قائمه جهاز اتصالاتي', 'قائمة جهاز اتصالاتي',
        'قائمه الاسماء', 'قائمة الاسماء', 'قائمه اصدقائي', 'قائمة اصدقائي', 'قائمه المعارف', 'قائمة المعارف',
        'منو مسجل عندي', 'منو مسجل بمحفظتي', 'منو مسجل', 'منو عندي',
        'الاشخاص المسجلين', 'الاشخاص اللي مسجلهم', 'الاشخاص المسجله', 'الاشخاص اللي مسجلين',
        'الاسماء المسجله', 'الاسماء اللي مسجلها', 'الارقام المسجله', 'الارقام اللي مسجلها',
        'كل الاسماء', 'ارقام اصدقائي', 'كل جهات الاتصال', 'كل جهات اتصالي'
    ];
    if (phrases.some(p => clean.includes(p))) {
        return true;
    }

    // "اعرض / شوفني / طلعلي / اريد اشوف / شنو / انطيني" + (جهات / جهاز / قائمه / اسماء / اشخاص / اصدقاء / اتصال)
    const hasInquiryLead = clean.includes('اعرض') || clean.includes('عرض') || clean.includes('شوفني') || clean.includes('طلعلي') || clean.includes('اريد اشوف') || clean.includes('شنو') || clean.includes('شو') || clean.includes('انطيني') || clean.includes('طيني') || clean.includes('اريدك');
    const hasContactConcept = clean.includes('اتصال') || clean.includes('اتصالاتي') || clean.includes('اتصالي') || clean.includes('اسماء') || clean.includes('اشخاص') || clean.includes('اصدقاء') || clean.includes('معارف');
    if (hasInquiryLead && hasContactConcept) {
        return true;
    }

    // "قائمه" + ("اتصال" or "اتصالي" or "اتصالاتي" or "اصدقاء" or "اسماء" or "اشخاص" or "معارف" or "جهاز")
    if (clean.includes('قائم') && (clean.includes('اتصال') || clean.includes('اصدقاء') || clean.includes('اسماء') || clean.includes('اشخاص') || clean.includes('معارف') || clean.includes('جهاز'))) {
        return true;
    }

    return false;
}

function handleContactInquiry(userMessage, contacts) {
    if (!userMessage || !Array.isArray(contacts)) return null;
    const clean = normalizeArabic(userMessage);

    const hasInquiryKeywords = 
        isContactsListInquiry(userMessage) ||
        clean.includes('قائم') || clean.includes('اقام') || clean.includes('جهات الاتصال') ||
        clean.includes('اصدقاء') || clean.includes('عندك رقم') || clean.includes('ما عندك رقم') ||
        clean.includes('مسجل عندك') || clean.includes('موجود عندك') || clean.includes('منو مسجل') ||
        clean.includes('شو مسجل') || clean.includes('شنو مسجل') || clean.includes('ارقام اصدقائي') ||
        clean.includes('هل رقم') || clean.includes('رقم منو') || clean.includes('عندك احد');

    if (!hasInquiryKeywords) return null;

    // Check if inquiring about all contacts (e.g. "منو مسجل عندي", "قائمة اتصالاتي", "جهات الاتصال")
    const isGeneralList = 
        isContactsListInquiry(userMessage) ||
        clean.includes('منو مسجل') || clean.includes('كل جهات') || clean.includes('كل الاسماء') ||
        clean.includes('ارقام اصدقائي') || clean.includes('كل اصدقائي') ||
        (clean.includes('منو عندي') && (clean.includes('قائم') || clean.includes('اقام') || clean.includes('اتصال'))) ||
        (clean === 'قائمه اتصالاتي' || clean === 'قائمة اتصالاتي' || clean === 'جهات الاتصال' || clean === 'اصدقائي');

    if (isGeneralList) {
        if (contacts.length === 0) {
            return 'ما عندك أي جهات اتصال مسجلة بمحفظتك حالياً.';
        }
        const list = contacts.map((c, i) => `${i + 1}. ${c.alias || c.name} (${c.phone})`).join('\n');
        return `هاي قائمة بجهات الاتصال المسجلة بمحفظتك:\n\n${list}\n\n💡 تكدر تختار أي شخص منهم وتكلي: "حول 50 الف لسيف" أو "حول 25 الف لأحمد".`;
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

function classifyRecipient(text, contacts = []) {
    if (!text || typeof text !== 'string') {
        return { type: 'NO_RECIPIENT', valid: false };
    }

    const normText = normalizeDigits(text);
    const clean = normalizeArabic(text);

    // 1. Explicit Account or Card labels
    const accountLabelRegex = /(?:لحساب|للحساب|حساب(?:\s+مصرفي|\s+بنكي)?|رقم\s+حساب|حساب\s+رقم|لبطاق[هة]|للبطاق[هة]|بطاق[هة](?:\s+مصرفي[هة]|\s+بنكي[هة]|\s+دفع)?|رقم\s+بطاق[هة]|بطاق[هة]\s+رقم|ماستركارد|ماستر\s*كارد|ماستر|فيزا(?:\s*كارد)?|account|card|mastercard|visa)/i;

    if (accountLabelRegex.test(clean)) {
        const acctMatch = normText.match(/(?:(?:لحساب|للحساب|حساب(?:\s+مصرفي|\s+بنكي)?|رقم\s+حساب|حساب\s+رقم|لبطاق[هة]|للبطاق[هة]|بطاق[هة](?:\s+مصرفي[هة]|\s+بنكي[هة]|\s+دفع)?|رقم\s+بطاق[هة]|بطاق[هة]\s+رقم|ماستركارد|ماستر\s*كارد|ماستر|فيزا(?:\s*كارد)?|account|card|mastercard|visa)[\s:]*(?:رقم[\s:]*)?)([0-9\s-]{3,30})/i);

        let candidateDigits = '';
        if (acctMatch) {
            candidateDigits = acctMatch[1].replace(/\D/g, '');
        } else {
            const digitsMatch = normText.match(/\b\d{4,20}\b/);
            if (digitsMatch) {
                candidateDigits = digitsMatch[0];
            }
        }

        if (candidateDigits) {
            const isPhoneShaped = /^0?7[578]\d{8}$/.test(candidateDigits) || /^(?:964)?7[578]\d{8}$/.test(candidateDigits);
            if (!isPhoneShaped) {
                if (candidateDigits.length >= 10 && candidateDigits.length <= 16) {
                    const isCard = /(?:بطاق|ماستر|فيزا|card|visa|mastercard)/i.test(clean);
                    const label = isCard ? `بطاقة مصرفية (${candidateDigits})` : `حساب مصرفي (${candidateDigits})`;
                    return {
                        type: 'ACCOUNT_CARD',
                        valid: true,
                        recipient: label,
                        phone: candidateDigits,
                        accountNumber: candidateDigits,
                        display: label,
                        isCard
                    };
                } else {
                    return {
                        type: 'INVALID_ACCOUNT_CARD',
                        valid: false,
                        error: 'رقم الحساب أو البطاقة المصرفية غير صحيح. يجب أن يتكون من 10 إلى 16 رقماً.',
                        rawDigits: candidateDigits
                    };
                }
            }
        }
    }

    // 2. Iraqi Mobile Phone Detection (Zain 078, Asiacell 077, Korek 075)
    const phoneCandidateRegex = /(?:^|[^\d+])(?:(?:\+|00)?964[\s-]*)?0?(7[578](?:[\s-]*\d)+)(?!\d)/g;
    let match;
    const phoneCandidates = [];
    while ((match = phoneCandidateRegex.exec(normText)) !== null) {
        const rawDigits = match[1].replace(/\D/g, '');
        const full = '0' + rawDigits;
        phoneCandidates.push(full);
    }

    if (phoneCandidates.length > 0) {
        const primaryPhone = phoneCandidates[0];

        // Check for unsupported Iraqi operators (Asiacell 077, Korek 075)
        if (primaryPhone.startsWith('075') || primaryPhone.startsWith('077')) {
            return {
                type: 'UNSUPPORTED_PHONE',
                valid: false,
                error: 'حالياً التحويل مدعوم لأرقام زين اللي تبدي بـ 078 فقط، أو لأرقام الحسابات والبطاقات المصرفية من 10 إلى 16 رقم. أرقام الهاتف اللي تبدي بـ 075 أو 077 غير مدعومة.',
                rawNumber: primaryPhone
            };
        }

        // Check for Zain (078)
        if (primaryPhone.startsWith('078')) {
            if (primaryPhone.length === 11) {
                return {
                    type: 'SUPPORTED_PHONE',
                    valid: true,
                    recipient: `رقم الهاتف (${primaryPhone})`,
                    phone: primaryPhone,
                    display: `رقم الهاتف (${primaryPhone})`
                };
            } else {
                return {
                    type: 'INVALID_PHONE',
                    valid: false,
                    error: 'رقم هاتف زين غير صحيح. يجب أن يتكون الرقم من 11 رقماً ويبدأ بـ 078 (مثال: 07801234567).',
                    rawNumber: primaryPhone
                };
            }
        }
    }

    // 3. Unlabeled Arbitrary Digits
    const allNumberMatches = normText.match(/\b\d{9,18}\b/g);
    if (allNumberMatches && allNumberMatches.length > 0) {
        return {
            type: 'UNKNOWN_DIGITS',
            valid: false,
            error: 'الرقم المدخل غير معروف. يرجى تزويدي برقم هاتف زين يبدأ بـ 078 (11 رقماً)، أو تحديد رقم الحساب أو البطاقة المصرفية صراحة (من 10 إلى 16 رقماً، مثال: لحساب رقم ...).'
        };
    }

    // 4. Contact Book Lookup
    if (Array.isArray(contacts) && contacts.length > 0) {
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

        if (matched.length > 1) {
            return {
                type: 'CONTACT_AMBIGUOUS',
                valid: false,
                matches: matched,
                baseName: matched[0].name
            };
        }

        if (matched.length === 1) {
            return {
                type: 'CONTACT',
                valid: true,
                recipient: matched[0].alias || matched[0].name,
                phone: matched[0].phone,
                contact: matched[0]
            };
        }
    }

    // 5. Unknown Name Check
    const nameMatch = clean.match(/(?:^|[\s،,])(?:ل|الى\s+|الي\s+)([\u0621-\u064A]{3,15})(?:[\s،,]|$)/);
    const ignoreList = [
        'حسابي', 'محفظتي', 'رصيدي', 'شخص', 'احد', 'واحد', 'صديق', 'فلوس', 'مبلغ', 'رقم',
        'اتي', 'اتصال', 'اتصالي', 'اتصالاتي', 'جهات', 'قائمه', 'قائمة', 'بينهم', 'اي'
    ];
    if (nameMatch && !ignoreList.includes(nameMatch[1])) {
        return {
            type: 'UNKNOWN_NAME',
            valid: false,
            name: nameMatch[1]
        };
    }

    return {
        type: 'NO_RECIPIENT',
        valid: false
    };
}

function handleDirectTransferIntent(userMessage, db, session = null) {
    if (!userMessage || !db) return null;
    const clean = normalizeArabic(userMessage);

    // Exclude balance and transaction inquiries
    if (isBalanceInquiry(userMessage) || isTransactionsInquiry(userMessage)) return null;

    // Exclude bill inquiries/payments
    if (clean.includes('فاتور') || clean.includes('قائم')) return null;

    const transferVerbs = ['حول', 'تحول', 'احول', 'تحولي', 'تحوللي', 'تدز', 'دز', 'ادز', 'ارسل', 'ترسل', 'ابعت', 'ابعث'];
    const isTransferVerb = transferVerbs.some(v => {
        const regex = new RegExp(`(^|[\\s،,])(${v})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });

    const normText = normalizeDigits(userMessage);
    const hasPhoneCandidate = /(?:(?:\+|00)?964[\s-]*)?0?7[578]/.test(normText);
    const hasAccountLabel = /(?:حساب|بطاق[هة]|ماستركارد|ماستر\s*كارد|فيزا|account|card|mastercard|visa)/i.test(clean);

    if (!isTransferVerb && !hasPhoneCandidate && !hasAccountLabel) return null;

    const contacts = db.contacts || [];
    const recipientInfo = classifyRecipient(userMessage, contacts);
    const amount = extractAmount(userMessage);

    // 1. Unsupported Iraqi mobile numbers (075 or 077)
    if (recipientInfo.type === 'UNSUPPORTED_PHONE') {
        return recipientInfo.error;
    }

    // 2. Invalid Zain phone (e.g. invalid length)
    if (recipientInfo.type === 'INVALID_PHONE') {
        return recipientInfo.error;
    }

    // 3. Invalid Account / Card number (length not 10-16)
    if (recipientInfo.type === 'INVALID_ACCOUNT_CARD') {
        return recipientInfo.error;
    }

    // 4. Arbitrary unlabelled digits
    if (recipientInfo.type === 'UNKNOWN_DIGITS') {
        return recipientInfo.error;
    }

    // 5. Ambiguous Contacts (e.g. "أحمد")
    if (recipientInfo.type === 'CONTACT_AMBIGUOUS') {
        if (session) {
            session.pendingDisambiguation = {
                name: recipientInfo.baseName,
                matches: recipientInfo.matches,
                amount: amount
            };
        }
        const listText = recipientInfo.matches.map((c, i) => `${i + 1}. ${c.alias || c.name} (${c.phone})`).join('\n');
        return `يا هلا عيوني، عندك أكثر من جهة اتصال باسم "${recipientInfo.baseName}" بمحفظتك:\n${listText}\n\nيا واحد منهم تقصد؟ يرجى كتابة الرقم أو الاسم الكامل حتى أجهّزلك التحويل.`;
    }

    // 6. Valid Recipient (SUPPORTED_PHONE, ACCOUNT_CARD, CONTACT)
    if (recipientInfo.valid) {
        const targetRecipient = recipientInfo.recipient;
        const targetPhone = recipientInfo.phone;
        const targetDisplay = (targetRecipient.includes(targetPhone) || !targetPhone)
            ? targetRecipient
            : `${targetRecipient} (${targetPhone})`;

        if (amount) {
            if (amount < 250) {
                return 'أقل مبلغ تحويل مسموح به هو 250 د.ع.';
            }
            if (db.user.balance < amount) {
                return `رصيدك الحالي (${db.user.balance.toLocaleString()} د.ع) غير كافي لتحويل مبلغ ${amount.toLocaleString()} د.ع.`;
            }
            if (session) {
                session.pendingTransfer = {
                    recipient: targetRecipient,
                    phone: targetPhone,
                    amount: amount
                };
            }
            const remainingBal = db.user.balance - amount;
            return `تفاصيل التحويل:\n• المستلم: ${targetDisplay}\n• المبلغ: ${amount.toLocaleString()} د.ع\n• الرصيد بعد التحويل: ${remainingBal.toLocaleString()} د.ع\n\nمتأكد تريد أحول؟ (يرجى الرد بـ "نعم" للتأكيد أو "إلغاء" للتراجع).`;
        } else {
            if (session) {
                session.pendingTransferRecipient = {
                    name: targetRecipient,
                    phone: targetPhone
                };
            }
            return `صار عيوني، تم تحديد المستلم: ${targetDisplay}.\nشكد المبلغ اللي تريد تحوله له؟`;
        }
    }

    // 7. Unknown Name Check (e.g. "حول لجعفر")
    if (recipientInfo.type === 'UNKNOWN_NAME') {
        if (amount) {
            return `يا هلا عيوني، ما لقيت أي شخص باسم "${recipientInfo.name}" بقائمة اتصالاتك بمحفظتك.\nحتى أجهّزلك تحويل مبلغ ${amount.toLocaleString()} د.ع، يرجى تزويدي برقم هاتفه.`;
        }
        return `يا هلا عيوني، ما لقيت أي شخص باسم "${recipientInfo.name}" بقائمة اتصالاتك بمحفظتك.\nإذا تريد تحول له، يرجى تزويدي برقم هاتفه والمبلغ اللي تريد تدزه.`;
    }

    // 8. NO_RECIPIENT with transfer verb
    if (isTransferVerb) {
        if (amount) {
            if (session) {
                session.pendingTransferAmount = amount;
            }
            return `شكد حلو! تريد تحول مبلغ ${amount.toLocaleString()} د.ع، بس لمنو تريد تدزه؟ يرجى كتابة اسم الشخص من جهات اتصالك أو رقم هاتف زين (078...) أو رقم حساب/بطاقة مصرفية.`;
        }
        return `تدلل عيوني، لمنو تريد تحول وشكد المبلغ اللي تريد تدزه؟ تكدر تدزلي اسم الشخص أو رقم هاتف زين (078...) أو رقم الحساب/البطاقة.`;
    }

    return null;
}

const CANCELLATION_WORDS = ['لا', 'إلغاء', 'الغاء', 'بطلت', 'هونت', 'ما أريد', 'ما اريد', 'cancel'];

function isUserCancellation(text) {
    if (!text) return false;
    const clean = normalizeArabic(text).trim();

    const topicWords = ['قائم', 'جهات', 'اتصال', 'اتصالي', 'اتصالاتي', 'جهاز', 'اسماء', 'اشخاص', 'رصيد', 'فلوس', 'فواتير', 'فاتور', 'كهرباء', 'مياه', 'ماء', 'انترنت', 'حول', 'دز', 'ارسل', 'ادفع', 'سدد'];
    const hasTopicWord = topicWords.some(tw => clean.includes(tw));
    if (hasTopicWord) {
        const explicitCancel = clean.includes('الغاء') || clean.includes('الغي') || clean.includes('إلغاء') || clean.includes('بطلت') || clean.includes('هونت') || clean.includes('ما اريد') || clean.includes('ما أريد') || clean.includes('cancel');
        return explicitCancel;
    }

    if (/^لا\s+(مو|اقصد|أقصد|اعرض|أعرض|شوفني|طلع|غلط|ليس|اريد|أريد|خليني)/.test(clean) || clean.includes('لا مو')) {
        return false;
    }

    return CANCELLATION_WORDS.some(w => {
        const nw = normalizeArabic(w);
        const regex = new RegExp(`(^|[\\s،,])(${nw})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });
}

const EXPLICIT_AFFIRMATIONS = [
    'نعم', 'أكد', 'اكد', 'موافق', 'أي', 'اي', 'تمام', 'توكل', 'أكيد', 'اكيد',
    'يلا', 'yes', 'ok', 'confirm'
];

const ACTION_CONFIRMATIONS = [
    'أرسل', 'ارسل', 'دز', 'دزه', 'دزها', 'حول', 'حوله', 'حولها',
    'ادفع', 'ادفعها', 'سدد', 'سددها', 'send'
];

function isUserConfirmation(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = normalizeArabic(text).trim();
    if (isUserCancellation(text)) return false;

    // 1. Explicit affirmative responses
    const hasAffirmation = EXPLICIT_AFFIRMATIONS.some(word => {
        const normWord = normalizeArabic(word);
        const regex = new RegExp(`(^|[\\s،,])(${normWord})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });
    if (hasAffirmation) return true;

    // 2. Action verbs
    const hasActionVerb = ACTION_CONFIRMATIONS.some(word => {
        const normWord = normalizeArabic(word);
        const regex = new RegExp(`(^|[\\s،,])(${normWord})([\\s،,]|$)`, 'i');
        return regex.test(clean);
    });

    if (hasActionVerb) {
        const isInitialCommand = clean.includes('فاتور') || clean.includes('فواتير') || clean.includes('قائم') || clean.includes('قوائم') || clean.includes('حساب') ||
                                 clean.includes('كهرباء') || clean.includes('مياه') || clean.includes('ماء') || clean.includes('ماي') || clean.includes('انترنت') ||
                                 clean.includes('فايبر') || clean.includes('زين') || clean.includes('اسياسيل') || clean.includes('كورك') ||
                                 extractAmount(text) !== null;
        if (!isInitialCommand) {
            return true;
        }
    }

    return false;
}

function isStandaloneNumberedChoice(text) {
    if (!text || typeof text !== 'string') return false;
    const cleanDigits = normalizeDigits(text);
    const clean = normalizeArabic(cleanDigits).replace(/[.,!?،؟]/g, '').trim();

    if (/^[1-9]$/.test(clean)) return true;
    if (/^(رقم|خيار|الخيار)\s*[1-9]$/.test(clean)) return true;

    const ordinals = ['الاول', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس'];
    if (ordinals.includes(clean)) return true;
    if (/^(رقم|خيار|الخيار)\s*(الاول|الأول|الثاني|الثالث|الرابع|الخامس|السادس)$/.test(clean)) return true;

    return false;
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
    if (clean.includes('وين راحت') || clean.includes('وين طارت') || clean.includes('شصرفت') || clean.includes('صرفت')) {
        return false;
    }
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

    if (isContactsListInquiry(text) || isTransactionsInquiry(text) || isBalanceInquiry(text)) return false;
    if (clean.includes('اتصال') || clean.includes('اتصالاتي') || clean.includes('اتصالي') || clean.includes('اصدقاء') || clean.includes('اسماء') || clean.includes('اشخاص') || clean.includes('جهاز') || clean.includes('سجل')) return false;

    const hasBillKeyword = clean.includes('فاتوره') || clean.includes('فواتير');
    const hasUtilityContext = clean.includes('كهرباء') || clean.includes('مياه') || clean.includes('ماء') || clean.includes('ماي') || clean.includes('انترنت') || clean.includes('نت') || clean.includes('فايبر') || clean.includes('غير مدفوع') || clean.includes('مطلوب');
    const hasBillList = (clean.includes('قوائم') || clean.includes('قائمه')) && hasUtilityContext;

    if (!hasBillKeyword && !hasBillList) return false;

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

    for (const b of bills) {
        const normBiller = normalizeArabic(b.biller);

        if (clean.includes(normBiller)) return b;
        if (b.account_number && clean.includes(b.account_number.toLowerCase())) return b;

        if ((clean.includes('كهرباء') || clean.includes('الكرخ')) && normBiller.includes('كهرباء')) {
            return b;
        }

        if ((clean.includes('خط') || clean.includes('موبايل') || clean.includes('هاتف') || clean.includes('اتصال')) && (normBiller.includes('خط') || normBiller.includes('هاتف') || normBiller.includes('موبايل'))) {
            return b;
        }

        if ((clean.includes('مياه') || clean.includes('ماء') || clean.includes('ماي') || clean.includes('البصره')) && normBiller.includes('مياه')) {
            return b;
        }

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

    if (isPayAllBillsRequest(userMessage)) {
        return { type: 'ALL', bills: unpaid };
    }

    const matched = findMatchingBill(userMessage, bills);
    if (matched) {
        const isPaymentVerb = clean.includes('ادفع') || clean.includes('دفع') || clean.includes('سدد') || clean.includes('تسديد') || clean.includes('سدلي') || clean.includes('ادفعلي');
        const isBillKeyword = clean.includes('فاتوره') || clean.includes('قائمه') || clean.includes('حساب');

        if (isPaymentVerb || isBillKeyword) {
            return { type: 'SINGLE', bill: matched };
        }
    }

    return null;
}

const {
    classifySemanticIntent,
    CONFIDENCE_THRESHOLD,
    normalizeForVector,
    extractNgrams,
    cosineSimilarity
} = require('./semanticClassifier');
const { performance } = require('perf_hooks');

/**
 * Two-Tier Hybrid NLP Intent Router
 * Tier 1: Fast Path - Ultrafast deterministic regex rules (<0.2ms)
 * Tier 2: Semantic Fallback - Local zero-dependency cosine similarity classifier (>=0.82 confidence, <3ms)
 * Escalates to LLM only when both tiers yield no confident match.
 */
function evaluateHybridIntent(userMessage, context = {}) {
    const t0 = performance.now();
    if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
        return {
            tier: 1,
            intent: null,
            confidence: 0,
            fastPath: true,
            latencyMs: 0
        };
    }

    const { bills, contacts } = context;

    // Tier 1: Fast Path (<0.2ms) - Deterministic regex rules
    if (isBalanceInquiry(userMessage)) {
        return {
            tier: 1,
            intent: 'BALANCE_INQUIRY',
            confidence: 1.0,
            fastPath: true,
            latencyMs: Number((performance.now() - t0).toFixed(4))
        };
    }

    if (isTransactionsInquiry(userMessage)) {
        return {
            tier: 1,
            intent: 'TRANSACTIONS_INQUIRY',
            confidence: 1.0,
            fastPath: true,
            latencyMs: Number((performance.now() - t0).toFixed(4))
        };
    }

    if (isContactsListInquiry(userMessage)) {
        return {
            tier: 1,
            intent: 'CONTACTS_INQUIRY',
            confidence: 1.0,
            fastPath: true,
            latencyMs: Number((performance.now() - t0).toFixed(4))
        };
    }

    if (isBillInquiry(userMessage)) {
        return {
            tier: 1,
            intent: 'BILL_INQUIRY',
            confidence: 1.0,
            fastPath: true,
            latencyMs: Number((performance.now() - t0).toFixed(4))
        };
    }

    if (Array.isArray(bills)) {
        const billPayIntent = detectBillPaymentIntent(userMessage, bills);
        if (billPayIntent) {
            return {
                tier: 1,
                intent: 'BILL_PAYMENT',
                confidence: 1.0,
                fastPath: true,
                details: billPayIntent,
                latencyMs: Number((performance.now() - t0).toFixed(4))
            };
        }
    }

    if (Array.isArray(contacts)) {
        const directTransfer = handleDirectTransferIntent(userMessage, contacts);
        if (directTransfer) {
            return {
                tier: 1,
                intent: 'TRANSFER',
                confidence: 1.0,
                fastPath: true,
                details: directTransfer,
                latencyMs: Number((performance.now() - t0).toFixed(4))
            };
        }
    }

    if (isContactCreationIntent(userMessage)) {
        return {
            tier: 1,
            intent: 'CONTACT_CREATION',
            confidence: 1.0,
            fastPath: true,
            latencyMs: Number((performance.now() - t0).toFixed(4))
        };
    }

    if (isUserConfirmation(userMessage)) {
        return {
            tier: 1,
            intent: 'CONFIRMATION',
            confidence: 1.0,
            fastPath: true,
            latencyMs: Number((performance.now() - t0).toFixed(4))
        };
    }

    if (isUserCancellation(userMessage)) {
        return {
            tier: 1,
            intent: 'CANCELLATION',
            confidence: 1.0,
            fastPath: true,
            latencyMs: Number((performance.now() - t0).toFixed(4))
        };
    }

    // Tier 2: Semantic Fallback (<3ms offline) - Zero-shot colloquial user utterances
    const threshold = typeof context.threshold === 'number' ? context.threshold : CONFIDENCE_THRESHOLD;
    const semantic = classifySemanticIntent(userMessage, { threshold });
    const latency = Number((performance.now() - t0).toFixed(4));

    if (semantic.isConfident && semantic.intent) {
        return {
            tier: 2,
            intent: semantic.intent,
            confidence: semantic.confidence,
            semanticFallback: true,
            scores: semantic.scores,
            rawCosine: semantic.rawCosine,
            latencyMs: latency
        };
    }

    return {
        tier: 2,
        intent: null,
        topCandidate: semantic.topCandidate,
        confidence: semantic.confidence,
        escalateToLLM: true,
        scores: semantic.scores,
        rawCosine: semantic.rawCosine,
        latencyMs: latency
    };
}

module.exports = {
    normalizeDigits,
    normalizeArabic,
    extractAmount,
    findAmbiguousContacts,
    resolveContactSelection,
    isDisambiguationAbandonment,
    extractUserPhoneCandidates,
    isContactCreationIntent,
    extractContactNameFromMessage,
    isContactsListInquiry,
    handleContactInquiry,
    classifyRecipient,
    handleDirectTransferIntent,
    isUserCancellation,
    isUserConfirmation,
    isStandaloneNumberedChoice,
    isGreeting,
    isBalanceInquiry,
    isTransactionsInquiry,
    isBillInquiry,
    isPayAllBillsRequest,
    findMatchingBill,
    detectBillPaymentIntent,
    evaluateHybridIntent,
    classifySemanticIntent,
    CONFIDENCE_THRESHOLD,
    normalizeForVector,
    extractNgrams,
    cosineSimilarity
};
