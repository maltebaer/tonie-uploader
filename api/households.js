// api/households.js
import { authenticateWithTonie, verifyAppPassword, setCorsHeaders, makeTonieApiRequest } from '../utils/auth.js';

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
        const { appPassword, sessionToken } = req.body;

        // Verify app password first
        if (!verifyAppPassword(appPassword)) {
            res.status(401).json({ error: 'Invalid app password' });

            return;
        }

        // Check if session token is provided, if not authenticate
        let accessToken = sessionToken;
        if (!accessToken) {
            const tonieAuth = await authenticateWithTonie();
            if (!tonieAuth.success) {
                res.status(401).json({
                    error: 'Failed to authenticate with Tonie API',
                    details: tonieAuth.error
                });

                return;
            }
            accessToken = tonieAuth.sessionToken;
        }

        // Fetch households
        const householdsResult = await makeTonieApiRequest('/households', accessToken);

        if (!householdsResult.success) {
            res.status(householdsResult.status || 500).json({
                error: 'Failed to fetch households',
                details: householdsResult.error
            });

            return;
        }

        const households = householdsResult.data;

        // For each household, fetch creative tonies using the correct API endpoint
        const householdsWithTonies = await Promise.all(
            households.map(async (household) => {
                console.log(`\n=== Fetching Creative-Tonies for household: ${household.name} (${household.id}) ===`);

                // Use the correct Creative-Tonies endpoint from the API documentation
                const endpoint = `/households/${household.id}/creativetonies`;
                console.log(`Using endpoint: ${endpoint}`);
                
                const result = await makeTonieApiRequest(endpoint, accessToken);
                let creativeTonies = [];

                if (result.success) {
                    console.log(`✅ Success with endpoint: ${endpoint}`);
                    creativeTonies = Array.isArray(result.data) ? result.data : [];
                    console.log(`Found ${creativeTonies.length} Creative-Tonies`);
                } else {
                    console.log(`❌ Failed with endpoint: ${endpoint} - ${result.error}`);
                    // If the primary endpoint fails, try the hyphenated version as fallback
                    const fallbackEndpoint = `/households/${household.id}/creative-tonies`;
                    console.log(`Trying fallback endpoint: ${fallbackEndpoint}`);
                    const fallbackResult = await makeTonieApiRequest(fallbackEndpoint, accessToken);
                    
                    if (fallbackResult.success) {
                        console.log(`✅ Success with fallback endpoint: ${fallbackEndpoint}`);
                        creativeTonies = Array.isArray(fallbackResult.data) ? fallbackResult.data : [];
                        console.log(`Found ${creativeTonies.length} Creative-Tonies`);
                    } else {
                        console.warn(`No Creative-Tonies found for household ${household.id}. Error: ${fallbackResult.error}`);
                    }
                }

                // Map the creative tonies data (handle different possible structures)
                const mappedTonies = creativeTonies.map(tonie => {
                    console.log(`Processing tonie:`, JSON.stringify(tonie, null, 2));
                    return {
                        id: tonie.id,
                        name: tonie.name || tonie.title,
                        image: tonie.image || tonie.imageUrl,
                        live: tonie.live,
                        private: tonie.private,
                        noCloud: tonie.noCloud,
                        chaptersCount: tonie.chapters ? tonie.chapters.length : 0,
                        totalLength: tonie.totalLength,
                        lastContent: tonie.lastContent,
                        // Include raw data for debugging
                        _raw: tonie
                    };
                });

                return {
                    ...household,
                    creativeTonies: mappedTonies
                };
            })
        );

        res.status(200).json({
            success: true,
            households: householdsWithTonies,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Households error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
}
