// utils/auth.js
// Shared authentication utilities for Tonie API

/**
 * Authenticate with the Tonie API using OAuth2 password flow
 * @returns {Object} Authentication result with success status and tokens
 */
export async function authenticateWithTonie() {
    try {
        // Use OpenID Connect endpoint for authentication
        const tokenUrl = 'https://login.tonies.com/auth/realms/tonies/protocol/openid-connect/token';

        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'tonie-uploader/1.0',
            },
            body: new URLSearchParams({
                'grant_type': 'password',
                'client_id': 'my-tonies',
                'scope': 'openid',
                'username': process.env.TONIE_EMAIL,
                'password': process.env.TONIE_PASSWORD
            })
        });

        if (!response.ok) {
            const errorText = await response.text();

            return {
                success: false,
                error: `HTTP ${response.status}: ${errorText || 'Authentication failed'}`
            };
        }

        const responseData = await response.json();

        // The access token is what we need for subsequent API calls
        const accessToken = responseData.access_token;

        if (!accessToken) {

            return {
                success: false,
                error: 'No access token received from authentication'
            };
        }

        return {
            success: true,
            sessionToken: accessToken,
            tokenType: responseData.token_type || 'Bearer',
            expiresIn: responseData.expires_in,
            refreshToken: responseData.refresh_token,
            userData: responseData
        };
    } catch (error) {

        return {
            success: false,
            error: `Network error: ${error.message}`
        };
    }
}

/**
 * Verify app password
 * @param {string} providedPassword - Password provided by user
 * @returns {boolean} True if password is valid
 */
export function verifyAppPassword(providedPassword) {
    return providedPassword && providedPassword === process.env.APP_PASSWORD;
}

/**
 * Make authenticated request to Tonie API
 * @param {string} endpoint - API endpoint (e.g., '/households')
 * @param {string} accessToken - JWT access token
 * @param {Object} options - Additional fetch options
 * @returns {Promise<Object>} API response
 */
export async function makeTonieApiRequest(endpoint, accessToken, options = {}) {
    const baseUrl = 'https://api.tonie.cloud/v2';
    const url = `${baseUrl}${endpoint}`;

    const defaultOptions = {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'tonie-uploader/1.0',
        },
        ...options
    };

    try {
        const response = await fetch(url, defaultOptions);

        if (!response.ok) {
            const errorText = await response.text();

            return {
                success: false,
                error: `HTTP ${response.status}: ${errorText || 'API request failed'}`,
                status: response.status
            };
        }

        const data = await response.json();

        return {
            success: true,
            data: data
        };
    } catch (error) {

        return {
            success: false,
            error: `Network error: ${error.message}`
        };
    }
}

/**
 * Set standard CORS headers for API responses
 * @param {Object} res - Response object
 */
export function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
