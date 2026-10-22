/**
 * Dual-Currency Exchange Rate Configuration (IQD ⇄ USD)
 * Default baseline: 100 USD = 153,000 IQD => 1 USD = 1,530 IQD
 * Configurable dynamically via process.env.IQD_PER_USD
 */
const EXCHANGE_RATE_CONFIG = {
    base_currency: 'IQD',
    target_currency: 'USD',
    iqd_per_usd: parseFloat(process.env.IQD_PER_USD || '1530'),
    usd_sample: 100,
    iqd_sample: 153000,
    formatted_rate: '100$ = 153,000 د.ع',
    rate_1_usd: 1530,
    last_updated: new Date().toISOString()
};

function getExchangeRate() {
    const rate = parseFloat(process.env.IQD_PER_USD || EXCHANGE_RATE_CONFIG.iqd_per_usd || '1530');
    return {
        ...EXCHANGE_RATE_CONFIG,
        iqd_per_usd: rate,
        rate_1_usd: rate,
        formatted_rate: `100$ = ${(rate * 100).toLocaleString('en-US')} د.ع`
    };
}

module.exports = {
    EXCHANGE_RATE_CONFIG,
    getExchangeRate
};
