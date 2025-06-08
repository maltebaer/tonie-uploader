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
        const loginUrl = 'https://api.tonie.cloud/v2/user/login';

        const response = await fetch(loginUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'tonie-uploader/1.0',
            },
            body: JSON.stringify({
                email: process.env.TONIE_EMAIL,
                password: process.env.TONIE_PASSWORD
            })
        });

        const responseData = await response.json();

        if (!response.ok) {

            return {
                success: false,
                error: `HTTP ${response.status}: ${responseData.message || 'Authentication failed'}`
            };
        }

        // Extract session cookies or token from response
        const cookies = response.headers.get('set-cookie');
        let sessionToken = null;

        if (cookies) {
            // Parse session cookie if present
            const sessionMatch = cookies.match(/session[^=]*=([^;]+)/i);
            if (sessionMatch) {
                sessionToken = sessionMatch[1];
            }
        }

        // Some APIs return token in response body
        if (!sessionToken && responseData.token) {
            sessionToken = responseData.token;
        }

        // Some APIs return session info in response body
        if (!sessionToken && responseData.session) {
            sessionToken = responseData.session;
        }

        return {
            success: true,
            sessionToken: sessionToken,
            userData: responseData,
            cookies: cookies
        };

    } catch (error) {

        return {
            success: false,
            error: `Network error: ${error.message}`
        };
    }
}
