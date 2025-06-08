// api/auth.js
import { authenticateWithTonie, verifyAppPassword, setCorsHeaders } from '../utils/auth.js';

export default async function handler(req, res) {
    // Set CORS headers
    setCorsHeaders(res);

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
        if (!verifyAppPassword(appPassword)) {
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
