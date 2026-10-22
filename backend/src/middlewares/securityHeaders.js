/**
 * Security & Cache Control Middleware
 * Sets strict cache-invalidation headers to ensure fresh financial state.
 */

function securityHeaders(req, res, next) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
}

module.exports = {
    securityHeaders
};
