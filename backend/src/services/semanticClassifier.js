/**
 * High-Performance Local Semantic Vector Similarity Classifier (Zero-Dependency)
 * 
 * Performs fast offline sub-millisecond intent categorization against pre-calibrated
 * intent centroids using character and word n-gram token vectors.
 * 
 * Calibrated for Iraqi Arabic dialect financial expressions (slang transfers, bill debts,
 * address book / contacts retrieval, balance inquiries, and transaction histories).
 */

const { performance } = require('perf_hooks');

const CONFIDENCE_THRESHOLD = 0.82;

/**
 * Normalizes Arabic text for feature extraction:
 * - Digits to ASCII 0-9
 * - Alif, Ya, Ta Marbuta normalization
 * - Diacritic stripping
 * - Punctuation to space
 */
function normalizeForVector(text) {
    if (!text || typeof text !== 'string') return '';
    return text.toLowerCase()
        .replace(/[\u064B-\u065F\u0670]/g, '') // Remove Arabic harakat/tashkeel
        .replace(/[٠۰]/g, '0').replace(/[١۱]/g, '1').replace(/[٢۲]/g, '2').replace(/[٣۳]/g, '3').replace(/[٤۴]/g, '4')
        .replace(/[٥۵]/g, '5').replace(/[٦۶]/g, '6').replace(/[٧۷]/g, '7').replace(/[٨۸]/g, '8').replace(/[٩۹]/g, '9')
        .replace(/[إأآا]/g, 'ا')
        .replace(/[ى]/g, 'ي')
        .replace(/[ة]/g, 'ه')
        .replace(/[^\w\s\u0621-\u064A]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extracts weighted word and character n-grams from Arabic text:
 * - Word unigrams (weight: 1.2)
 * - Word bigrams (weight: 1.8)
 * - Character 3-grams (weight: 0.5)
 * - Character 4-grams (weight: 0.7)
 * Produces an L2-normalized sparse vector representation.
 */
function extractNgrams(text) {
    const clean = normalizeForVector(text);
    if (!clean) return {};

    const words = clean.split(/\s+/).filter(Boolean);
    const features = {};

    function addFeature(token, weight = 1.0) {
        features[token] = (features[token] || 0) + weight;
    }

    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        // Word unigram
        addFeature('w:' + w, 1.2);

        // Word bigram
        if (i < words.length - 1) {
            addFeature('wb:' + w + '_' + words[i + 1], 1.8);
        }

        // Subword Character 3-grams
        if (w.length >= 3) {
            for (let c = 0; c <= w.length - 3; c++) {
                addFeature('c3:' + w.substring(c, c + 3), 0.5);
            }
        }

        // Subword Character 4-grams
        if (w.length >= 4) {
            for (let c = 0; c <= w.length - 4; c++) {
                addFeature('c4:' + w.substring(c, c + 4), 0.7);
            }
        }
    }

    // L2 Normalization (Unit length vector)
    let sumSq = 0;
    for (const k in features) {
        sumSq += features[k] * features[k];
    }
    const magnitude = Math.sqrt(sumSq) || 1.0;
    for (const k in features) {
        features[k] /= magnitude;
    }

    return features;
}

/**
 * Builds a unit-length normalized centroid vector from training example phrases
 */
function buildCentroid(examples) {
    const accumulator = {};
    for (const ex of examples) {
        const vec = extractNgrams(ex);
        for (const k in vec) {
            accumulator[k] = (accumulator[k] || 0) + vec[k];
        }
    }

    let sumSq = 0;
    for (const k in accumulator) {
        sumSq += accumulator[k] * accumulator[k];
    }
    const magnitude = Math.sqrt(sumSq) || 1.0;
    for (const k in accumulator) {
        accumulator[k] /= magnitude;
    }

    return accumulator;
}

/**
 * Computes cosine similarity between two unit-normalized sparse vectors.
 * Since vectors are pre-normalized, cosine similarity equals the dot product.
 */
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB) return 0;
    let dot = 0;
    for (const k in vecA) {
        if (vecB[k]) {
            dot += vecA[k] * vecB[k];
        }
    }
    return dot;
}

/**
 * Pre-calibrated Iraqi Arabic Intent Archetypes & Slang Seed Corpora.
 * Covers colloquial multi-dialect Iraqi financial vocabulary including
 * slang variants of money transfer, bill payments/inquiries, contacts retrieval,
 * balance inquiries, and transaction histories.
 */
const INTENT_SEED_CORPORA = {
    TRANSFER: [
        'طيرلي مبلغ لحساب شخص شمر فلوس عبر كاش دز كارتات',
        'طير خمسين الف لسيف شمر خمسين الف لمحمد عبر خمسين الف لاحمد',
        'دزلي حوالة وفلوس انقل لحساب ارسل بيزات كاش دز فليسات',
        'دزلي فليسات لأبو علي شمر فليسات حول بيزات دز كروة لابو فلان',
        'حول رصيد ومبلغ لشخص شمر رصيد طيرله حواله دز فليسات',
        'دز كاش طيرلي خمسين الف لسيف شمر مبلغ لاحمد عبرله كاش بيزات',
        'طيرلي رصيد شمرلي فلوس عبرلي بيزات لحسابي ومحفظتي دزلي فليسات',
        'سويلي تحويل شمر فلوس عبر حوالة دز كارت طير رصيد فليسات كروة',
        'دز فليسات لفلان حول بيزات ارسل كروة انقل فلوس كاش'
    ],
    BILL_INQUIRY: [
        'صفّيلي اشتراك النت سدلي اشتراك النت صفي حساب النت وقوائم الفواتير',
        'شنو القوائم اللي مكسورة علية شكد مطلوب فواتير للكهرباء والماي',
        'اكو فواتير مكسورة علية شكو قوائم ديون مكسورة ما مسددها',
        'شوفلي فواتير الكهرباء والماي شكد واصلة مطلوب انترنت فايبر وصفّيلي النت',
        'طلعلي شكو قوائم وفواتير غير مدفوعة ومطلوبة علية ديون',
        'شكو علية قوائم مكسورة فواتير كهرباء ماي انترنت متراكمة صفّيلي اشتراك',
        'شكد مكسور علية فواتير وقوائم مال كهرباء ومياه وانترنت وسددلي النت',
        'صفّيلي اشتراك النت والكهرباء والماي ودفع فواتير وقوائم مطلوبة'
    ],
    CONTACTS_INQUIRY: [
        'منو مسجل يمي بالدفتر شوفلي ارقام جماعتي بالدفتر مسيف عندي',
        'طلعلي قائمة المعارف الاسماء المخزونة عندي بالدفتر وربعي',
        'منو اصدقائي بالدفتر ارقام جماعتي ومعارفي منو عندي بالدليل',
        'قائمة الاشخاص المسجلين طلع ارقام تلفونات ربعي وجماعتي منو مسيف',
        'منو عندي بالدفتر ارقام جماعتي وربعي المسجلين بمحفظتي مسيفين',
        'شوفلي دليل المعارف والارقام المسجلة بالدفتر عندي وجهات الاتصال'
    ],
    BALANCE_INQUIRY: [
        'شكد باقي بجيبي بالمحفظة شوفلي الخردة والفلوس اللي عندي',
        'شكد كاعد بمحفظتي هسة كلي شكد واصل رصيدي بالمحفظة كاش',
        'شكد كاش باقي عندي كم فلس عندي بالمحفظة خردة وفلوس',
        'شكد باقي بجيبي فلوس رصيدي شكد هسة كاش بمحفظتي',
        'كم فلس باقي بجيبي شوفلي رصيدي شكد كاش بالمحفظة فلوسي شكد'
    ],
    TRANSACTIONS_INQUIRY: [
        'وين راحت فلوسي هالشهر شصرفت هالايام بمحفظتي شسويت تحويلات',
        'حركات الحساب والمصاريف الاخيرة شنو داز وشنو مستلم بالسجل',
        'كشف الحساب وسجل التحويلات وين طارت الفلوس والبيزات والحركات',
        'شكد صرفت هالشهر سجل الحركات والمصروفات الاخيرة والتحويلات',
        'وين راحت البيزات والمصاريف شصرفت هالفترة بالسجل شسويت تحويلات'
    ]
};

// Pre-compute normalized centroid vectors for each archetype
const INTENT_CENTROIDS = {};
for (const [intent, corpora] of Object.entries(INTENT_SEED_CORPORA)) {
    INTENT_CENTROIDS[intent] = corpora.map(extractNgrams);
}

/**
 * Calibrates raw cosine similarity against dense centroid models to a standard confidence scale:
 * Raw similarity >= 0.35 against broad multi-term centroids maps monotonically to [0.82, 0.99].
 * Raw similarity < 0.35 scales down sharply toward 0.0 to prevent false positives.
 */
function calibrateConfidence(rawCosine) {
    if (rawCosine <= 0.05) return 0.0;
    if (rawCosine >= 0.35) {
        // High semantic alignment: map [0.35, 0.70] -> [0.82, 0.99]
        const scaled = 0.82 + ((rawCosine - 0.35) / 0.35) * 0.17;
        return Number(Math.min(0.99, Math.max(0.82, scaled)).toFixed(4));
    }
    // Below threshold: scale smoothly down
    const scaled = (rawCosine / 0.35) * 0.80;
    return Number(Math.max(0.0, scaled).toFixed(4));
}

/**
 * Classifies an incoming utterance using zero-dependency local semantic vector similarity.
 * Runs in under 1ms entirely offline without network latency.
 * 
 * @param {string} text - User message in Iraqi Arabic
 * @param {object} options - Configuration options (e.g. threshold)
 * @returns {object} { intent, confidence, isConfident, rawCosine, scores, latencyMs }
 */
function classifySemanticIntent(text, options = {}) {
    const t0 = performance.now();
    const threshold = typeof options.threshold === 'number' ? options.threshold : CONFIDENCE_THRESHOLD;

    if (!text || typeof text !== 'string' || !text.trim()) {
        return {
            intent: null,
            confidence: 0.0,
            isConfident: false,
            rawCosine: 0.0,
            scores: {},
            latencyMs: 0.0
        };
    }

    const queryVec = extractNgrams(text);
    const scores = {};
    let bestIntent = null;
    let maxRawCosine = 0.0;

    for (const [intent, archetypeVecs] of Object.entries(INTENT_CENTROIDS)) {
        let intentMax = 0.0;
        for (const archVec of archetypeVecs) {
            const sim = cosineSimilarity(queryVec, archVec);
            if (sim > intentMax) {
                intentMax = sim;
            }
        }
        scores[intent] = intentMax;

        if (intentMax > maxRawCosine) {
            maxRawCosine = intentMax;
            bestIntent = intent;
        }
    }

    const confidence = calibrateConfidence(maxRawCosine);
    const t1 = performance.now();
    const latencyMs = Number((t1 - t0).toFixed(4));
    const isConfident = confidence >= threshold;

    return {
        intent: isConfident ? bestIntent : null,
        topCandidate: bestIntent,
        confidence,
        isConfident,
        rawCosine: Number(maxRawCosine.toFixed(4)),
        scores,
        latencyMs
    };
}

module.exports = {
    CONFIDENCE_THRESHOLD,
    normalizeForVector,
    extractNgrams,
    buildCentroid,
    cosineSimilarity,
    calibrateConfidence,
    classifySemanticIntent,
    INTENT_CENTROIDS,
    INTENT_SEED_CORPORA
};
