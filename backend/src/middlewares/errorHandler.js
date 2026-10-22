/**
 * Global Error Handler Middleware
 */
function errorHandler(err, req, res, next) {
    console.error('[Unhandled Express Error]:', err.message);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
        error: err.message || 'Internal Server Error'
    });
}

module.exports = {
    errorHandler
};
