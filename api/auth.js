// api/auth.js
export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();

        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });

        return;
    }

    try {
        const { appPassword, action } = req.body;

        // Verify app password first
        if (!appPassword || appPassword !== process.env.APP_PASSWORD) {
            res.status(401).json({ error: 'Invalid app password' });

            return;
        }

        if (action === 'verify') {
            // Just verify app password
            res.status(200).json({
                success: true,
                message: 'App password verified',
                timestamp: new Date().toISOString()
            });

            return;
        }

        if (action === 'tonie-login') {
            // Authenticate with Tonie API
            const tonieAuth = await authenticateWithTonie();

            if (tonieAuth.success) {
                res.status(200).json({
                    success: true,
                    message: 'Successfully authenticated with Tonie API',
                    sessionToken: tonieAuth.sessionToken,
                    timestamp: new Date().toISOString()
                });
            } else {
                res.status(401).json({
                    error: 'Failed to authenticate with Tonie API',
                    details: tonieAuth.error
                });
            }

            return;
        }

        res.status(400).json({ error: 'Invalid action. Use "verify" or "tonie-login"' });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
}

async function authenticateWithTonie() {
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
