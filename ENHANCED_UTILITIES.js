// Background Service Worker for Add to NotebookLM - Enhanced Version
// Handles API calls and message passing between content scripts and popup
// This is an improved version with security enhancements

importScripts('lib/youtube-comments-api.js', 'lib/comments-to-md.js');

// ============================================
// Constants
// ============================================

const CONSTANTS = {
    TOKEN_LIFETIME_MS: 30 * 60 * 1000, // 30 minutes
    RATE_LIMIT_INTERVAL_MS: 500, // 500ms between API calls
    REQUEST_TIMEOUT_MS: 30000, // 30 seconds
    MAX_RETRY_ATTEMPTS: 3,
};

// ============================================
// Utilities
// ============================================

// Rate Limiter - prevents excessive API calls
const RateLimiter = {
    lastCall: 0,
    minInterval: CONSTANTS.RATE_LIMIT_INTERVAL_MS,

    async throttle(fn) {
        const now = Date.now();
        const timeSinceLastCall = now - this.lastCall;

        if (timeSinceLastCall < this.minInterval) {
            // Wait for remaining time
            await new Promise(resolve => setTimeout(resolve, this.minInterval - timeSinceLastCall));
        }

        this.lastCall = Date.now();
        return await fn();
    }
};

// Response Validator - validates API responses
const ResponseValidator = {
    /**
     * Validate that response is from expected origin
     */
    validateOrigin(url, expectedOrigin) {
        if (!url || typeof url !== 'string') {
            throw new Error('Invalid URL');
        }

        try {
            const urlObj = new URL(url);
            if (!urlObj.origin.includes(expectedOrigin)) {
                throw new Error(`Invalid response origin: expected ${expectedOrigin}, got ${urlObj.origin}`);
            }
        } catch (error) {
            throw new Error(`Invalid URL format: ${error.message}`);
        }
    },

    /**
     * Validate RPC response structure
     */
    validateRpcResponse(responseText) {
        if (!responseText || typeof responseText !== 'string') {
            throw new Error('Invalid RPC response: expected string, got ' + typeof responseText);
        }

        // Check for common error patterns
        if (responseText.includes('"error"') || responseText.includes('Error')) {
            console.warn('Possible error in RPC response');
        }

        return true;
    },

    /**
     * Validate notebook ID format (UUID)
     */
    validateNotebookId(id) {
        const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        if (!id || !uuidRegex.test(id)) {
            throw new Error(`Invalid notebook ID format: ${id}`);
        }
        return true;
    },

    /**
     * Validate URL format
     */
    validateUrl(url) {
        if (!url || typeof url !== 'string') {
            throw new Error('Invalid URL: must be a string');
        }

        try {
            new URL(url);
        } catch (error) {
            throw new Error(`Invalid URL format: ${url}`);
        }

        return true;
    }
};

// Enhanced Error Handler
const ErrorHandler = {
    /**
     * Map error to user-friendly message
     */
    getUserFriendlyMessage(error) {
        const errorMap = {
            'Failed to fetch': 'Network error. Please check your internet connection.',
            'Not authorized': 'Please login to NotebookLM first.',
            'Invalid notebook ID': 'Invalid notebook selected. Please try again.',
            'Invalid URL': 'Invalid URL provided. Please check the address.',
            'AbortError': 'Request timeout. Please try again.',
            'Request timeout': 'Request timeout. Please try again.',
            'Invalid response origin': 'Security error: unexpected response source.',
            'Invalid HTML response': 'Invalid response from NotebookLM. Please try logging in again.',
        };

        const errorMessage = error.message || error.toString();

        for (const [key, value] of Object.entries(errorMap)) {
            if (errorMessage.includes(key)) {
                return value;
            }
        }

        return 'An unexpected error occurred. Please try again.';
    },

    /**
     * Log error with context
     */
    logError(context, error, additionalInfo = {}) {
        console.error(`[${context}]`, error.message || error, additionalInfo);
    }
};

async function fetchWithTimeout(url, options = {}, timeout = CONSTANTS.REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return response;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Request timeout');
        }
        throw error;
    } finally {
        clearTimeout(id);
    }
}

// ============================================
// INSTRUCTIONS FOR INTEGRATION
// ============================================
/*
 * To integrate these improvements into the existing background.js:
 * 
 * 1. Copy the utility functions (RateLimiter, ResponseValidator, ErrorHandler) to the top of background.js
 * 
 * 2. Update NotebookLMAPI.getTokens():
 *    - Add TOKEN_LIFETIME_MS constant
 *    - Check token timestamp before making request
 *    - Add timestamp when storing tokens
 *    - Use RateLimiter.throttle() for token refresh
 *    - Use ResponseValidator.validateOrigin() after fetch
 *    - Use ErrorHandler for better error messages
 * 
 * 3. Update NotebookLMAPI.rpc():
 *    - Check token expiration before RPC call
 *    - Use RateLimiter.throttle() for API calls
 *    - Use ResponseValidator.validateRpcResponse() on response
 *    - Improve error handling with ErrorHandler
 * 
 * 4. Update message handlers:
 *    - Validate notebookId with ResponseValidator.validateNotebookId()
 *    - Validate URLs with ResponseValidator.validateUrl()
 *    - Use ErrorHandler.getUserFriendlyMessage() for all errors
 * 
 * Example token management:
 * --------------------------
 * In getTokens(), add:
 *   this.tokens = { bl, at, authuser, timestamp: Date.now() };
 * 
 * Before RPC calls, check:
 *   if (this.tokens.timestamp && Date.now() - this.tokens.timestamp > CONSTANTS.TOKEN_LIFETIME_MS) {
 *     await this.getTokens(this.tokens.authuser, true);
 *   }
 */

console.log('Enhanced utilities loaded. See comments for integration instructions.');
