// api/upload-from-youtube.js
import ytdl from '@distube/ytdl-core';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { authenticateWithTonie, verifyAppPassword, setCorsHeaders, makeTonieApiRequest } from '../utils/auth.js';

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);

// Supported audio formats based on Tonie API documentation
const SUPPORTED_FORMATS = [
    'aac', 'aiff', 'aif', 'flac', 'mp3', 'm4a', 'm4b',
    'oga', 'ogg', 'opus', 'wav', 'wma'
];

const MAX_FILE_SIZE = 536870912; // 512 MB in bytes (Vercel tmp storage limit)
const MAX_FILENAME_LENGTH = 128;
const DOWNLOAD_TIMEOUT = 60000; // 60 seconds

/**
 * Validate YouTube URL
 */
function validateYouTubeUrl(url) {
    if (!ytdl.validateURL(url)) {
        throw new Error('Invalid YouTube URL format');
    }
}

/**
 * Extract video info from YouTube URL
 */
async function getVideoInfo(url) {
    try {
        const info = await ytdl.getInfo(url);

        // Check if video is available
        if (info.videoDetails.isLiveContent) {
            throw new Error('Live streams cannot be downloaded');
        }

        if (info.videoDetails.isPrivate) {
            throw new Error('Video is private and cannot be downloaded');
        }

        return {
            title: info.videoDetails.title,
            duration: parseInt(info.videoDetails.lengthSeconds),
            author: info.videoDetails.author.name,
            videoId: info.videoDetails.videoId,
            description: info.videoDetails.description
        };
    } catch (error) {
        if (error.message.includes('Video unavailable')) {
            throw new Error('Video is unavailable or has been removed');
        }
        if (error.message.includes('Private video')) {
            throw new Error('Video is private or restricted');
        }
        if (error.message.includes('age')) {
            throw new Error('Age-restricted content cannot be downloaded');
        }
        throw new Error(`Failed to get video information: ${error.message}`);
    }
}

/**
 * Generate clean filename from video title and ID
 */
function cleanFilename(title, videoId) {
    // Remove special characters but keep spaces, hyphens, underscores, parentheses
    const cleaned = title.replace(/[^a-zA-Z0-9\s\-\_\(\)]/g, '').trim();

    // Truncate if too long (leave room for videoId and extension)
    const maxTitleLength = MAX_FILENAME_LENGTH - videoId.length - 20; // 20 chars for " (videoId).m4a"
    const truncatedTitle = cleaned.length > maxTitleLength
        ? cleaned.substring(0, maxTitleLength).trim()
        : cleaned;

    return `${truncatedTitle} (${videoId}).m4a`;
}

/**
 * Validate file against Tonie API requirements
 */
function validateFile(fileSize, filename) {
    const errors = [];

    // Check file size (max 512 MB for Vercel)
    if (fileSize > MAX_FILE_SIZE) {
        errors.push(`File size (${Math.round(fileSize / 1024 / 1024)}MB) exceeds maximum allowed size of 512MB`);
    }

    // Check filename length
    if (filename.length > MAX_FILENAME_LENGTH) {
        errors.push(`Filename length (${filename.length}) exceeds maximum allowed length of 128 characters`);
    }

    // Check file format (should always be m4a for YouTube downloads)
    const extension = filename.toLowerCase().split('.').pop();
    if (!SUPPORTED_FORMATS.includes(extension)) {
        errors.push(`File format "${extension}" is not supported. Supported formats: ${SUPPORTED_FORMATS.join(', ')}`);
    }

    return errors;
}

/**
 * Download YouTube audio to temporary file
 */
async function downloadYouTubeAudio(url, tempFilePath, videoInfo) {
    return new Promise((resolve, reject) => {
        console.log(`Starting download of: ${videoInfo.title}`);

        // Get audio stream with highest quality
        const audioStream = ytdl(url, {
            quality: 'highestaudio',
            filter: 'audioonly',
            format: 'mp4'
        });

        const writeStream = fs.createWriteStream(tempFilePath);
        let downloadedBytes = 0;

        // Set timeout
        const timeout = setTimeout(() => {
            audioStream.destroy();
            writeStream.destroy();
            reject(new Error('Download timeout after 60 seconds'));
        }, DOWNLOAD_TIMEOUT);

        audioStream.on('data', (chunk) => {
            downloadedBytes += chunk.length;

            // Check if exceeding size limit
            if (downloadedBytes > MAX_FILE_SIZE) {
                audioStream.destroy();
                writeStream.destroy();
                clearTimeout(timeout);
                reject(new Error(`Download aborted: File size exceeds 512MB limit`));
                return;
            }
        });

        audioStream.on('error', (error) => {
            clearTimeout(timeout);
            writeStream.destroy();

            if (error.message.includes('403')) {
                reject(new Error('Video access forbidden - may be geo-restricted or require authentication'));
            } else if (error.message.includes('404')) {
                reject(new Error('Video not found or has been removed'));
            } else {
                reject(new Error(`Download failed: ${error.message}`));
            }
        });

        writeStream.on('error', (error) => {
            clearTimeout(timeout);
            audioStream.destroy();
            reject(new Error(`File write error: ${error.message}`));
        });

        writeStream.on('finish', () => {
            clearTimeout(timeout);
            console.log(`Download completed: ${downloadedBytes} bytes`);
            resolve(downloadedBytes);
        });

        audioStream.pipe(writeStream);
    });
}

/**
 * Upload file to Amazon S3 using the provided upload request
 */
async function uploadToS3(uploadRequest, fileData, filename) {
    // For Node.js environment, we need to use a different approach for multipart uploads
    const boundary = `----formdata-${Math.random().toString(36).substring(2)}`;
    let body = '';

    // Add all the fields from the upload request
    Object.entries(uploadRequest.request.fields).forEach(([key, value]) => {
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
        body += `${value}\r\n`;
    });

    // Add the file last (this is important for S3)
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`;
    body += `Content-Type: application/octet-stream\r\n\r\n`;

    // Convert body to Buffer and append file data
    const bodyBuffer = Buffer.from(body, 'utf8');
    const endBoundary = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const completeBody = Buffer.concat([bodyBuffer, fileData, endBoundary]);

    const response = await fetch(uploadRequest.request.url, {
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body: completeBody
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`S3 upload failed: ${response.status} ${errorText}`);
    }

    return uploadRequest.fileId;
}

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

    let tempFilePath = null;

    try {
        const { appPassword, tonieId, title, url } = req.body;

        console.log('YouTube upload request:', { tonieId, title, url: url ? 'provided' : 'missing' });

        // Validate required fields
        if (!appPassword || !tonieId || !title || !url) {
            res.status(400).json({
                error: 'Missing required fields',
                details: 'appPassword, tonieId, title, and url are required'
            });
            return;
        }

        // Verify app password
        if (!verifyAppPassword(appPassword)) {
            res.status(401).json({ error: 'Invalid app password' });
            return;
        }

        // Validate YouTube URL
        console.log('Validating YouTube URL...');
        try {
            validateYouTubeUrl(url);
        } catch (error) {
            res.status(400).json({
                error: 'Invalid YouTube URL',
                details: error.message
            });
            return;
        }

        // Get video information
        console.log('Getting video info...');
        let videoInfo;
        try {
            videoInfo = await getVideoInfo(url);
            console.log('Video info:', videoInfo);
        } catch (error) {
            res.status(400).json({
                error: 'Failed to get video information',
                details: error.message
            });
            return;
        }

        // Generate filename
        const filename = cleanFilename(videoInfo.title, videoInfo.videoId);
        console.log('Generated filename:', filename);

        // Validate filename
        const validationErrors = validateFile(0, filename); // Size will be checked during download
        if (validationErrors.length > 1) { // Ignore size error for now
            res.status(400).json({
                error: 'File validation failed',
                details: validationErrors.filter(e => !e.includes('File size'))
            });
            return;
        }

        // Create temporary file path
        tempFilePath = path.join('/tmp', `youtube_${Date.now()}_${videoInfo.videoId}.m4a`);
        console.log(`Downloading to: ${tempFilePath}`);

        // Download YouTube audio
        console.log('Starting YouTube audio download...');
        let fileSize;
        try {
            fileSize = await downloadYouTubeAudio(url, tempFilePath, videoInfo);
            console.log(`Download completed: ${fileSize} bytes`);
        } catch (error) {
            res.status(400).json({
                error: 'Failed to download YouTube audio',
                details: error.message
            });
            return;
        }

        // Final file size validation
        const finalValidationErrors = validateFile(fileSize, filename);
        if (finalValidationErrors.length > 0) {
            res.status(400).json({
                error: 'Downloaded file validation failed',
                details: finalValidationErrors
            });
            return;
        }

        // Read the downloaded file
        console.log('Reading downloaded file...');
        const fileData = await readFile(tempFilePath);

        // Authenticate with Tonie API
        console.log('Authenticating with Tonie API...');
        const tonieAuth = await authenticateWithTonie();
        if (!tonieAuth.success) {
            res.status(401).json({
                error: 'Failed to authenticate with Tonie API',
                details: tonieAuth.error
            });
            return;
        }

        const accessToken = tonieAuth.sessionToken;

        // Step 1: Request upload URL from Tonie API
        console.log('Requesting upload URL from Tonie API...');
        const uploadRequestResult = await makeTonieApiRequest('/file', accessToken, {
            method: 'POST'
        });

        if (!uploadRequestResult.success) {
            res.status(uploadRequestResult.status || 500).json({
                error: 'Failed to get upload URL from Tonie API',
                details: uploadRequestResult.error
            });
            return;
        }

        const uploadRequest = uploadRequestResult.data;
        console.log(`Received upload request with fileId: ${uploadRequest.fileId}`);

        // Step 2: Upload file to Amazon S3
        console.log('Uploading file to Amazon S3...');
        try {
            const fileId = await uploadToS3(uploadRequest, fileData, filename);
            console.log(`File uploaded successfully with ID: ${fileId}`);

            // Verify the Creative-Tonie exists using the correct API pattern
            console.log('Verifying Creative-Tonie exists...');

            // Parse tonieId to extract household and tonie IDs
            const [householdId, creativeTonnieId] = tonieId.split('/');
            console.log(`Parsed household ID: ${householdId}, Creative-Tonie ID: ${creativeTonnieId}`);

            // First, verify household exists
            const householdsResult = await makeTonieApiRequest('/households', accessToken);

            if (!householdsResult.success) {
                res.status(householdsResult.status || 500).json({
                    error: 'Failed to fetch households',
                    details: householdsResult.error
                });
                return;
            }

            const households = householdsResult.data || [];
            const targetHousehold = households.find(h => h.id === householdId);

            if (!targetHousehold) {
                res.status(404).json({
                    error: 'Household not found',
                    details: `Household with ID "${householdId}" not found`,
                    availableHouseholds: households.map(h => ({ id: h.id, name: h.name }))
                });
                return;
            }

            console.log(`Found household: ${targetHousehold.name}`);

            // Get Creative-Tonies for this household using the correct endpoint
            const creativeToniesEndpoint = `/households/${householdId}/creativetonies`;
            console.log(`Fetching Creative-Tonies from: ${creativeToniesEndpoint}`);

            const creativeToniesResult = await makeTonieApiRequest(creativeToniesEndpoint, accessToken);

            if (!creativeToniesResult.success) {
                // Try fallback endpoint with hyphenated name
                const fallbackEndpoint = `/households/${householdId}/creative-tonies`;
                console.log(`Trying fallback endpoint: ${fallbackEndpoint}`);
                const fallbackResult = await makeTonieApiRequest(fallbackEndpoint, accessToken);

                if (!fallbackResult.success) {
                    res.status(creativeToniesResult.status || 500).json({
                        error: 'Failed to fetch Creative-Tonies',
                        details: creativeToniesResult.error,
                        debug: {
                            householdId,
                            endpoint: creativeToniesEndpoint,
                            fallbackEndpoint,
                            fallbackError: fallbackResult.error
                        }
                    });
                    return;
                }

                // Use fallback result
                creativeToniesResult.data = fallbackResult.data;
                creativeToniesResult.success = true;
            }

            const creativetonies = Array.isArray(creativeToniesResult.data) ? creativeToniesResult.data : [];
            console.log(`Found ${creativetonies.length} Creative-Tonies`);

            const targetTonie = creativetonies.find(tonie => tonie.id === creativeTonnieId);

            if (!targetTonie) {
                res.status(404).json({
                    error: 'Creative-Tonie not found',
                    details: `Creative-Tonie with ID "${creativeTonnieId}" not found in household "${householdId}"`,
                    availableCreativetonies: creativetonies.map(t => ({
                        id: t.id,
                        name: t.name,
                        chapters: t.chapters?.length || 0
                    }))
                });
                return;
            }

            console.log(`Found Creative-Tonie: ${targetTonie.name} (ID: ${targetTonie.id})`);

            // Step 3: Add chapter to Creative-Tonie
            console.log(`Adding chapter "${title}" to tonie ${tonieId}...`);
            const chapterEndpoint = `/households/${householdId}/creativetonies/${creativeTonnieId}/chapters`;
            console.log(`Adding chapter to endpoint: ${chapterEndpoint}`);

            const addChapterResult = await makeTonieApiRequest(
                chapterEndpoint,
                accessToken,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        title: title,
                        file: fileId
                    })
                }
            );

            if (!addChapterResult.success) {
                console.error('Add chapter failed:', addChapterResult.error);
                res.status(addChapterResult.status || 500).json({
                    error: 'Failed to add chapter to Creative-Tonie',
                    details: addChapterResult.error,
                    debug: {
                        householdId,
                        creativeTonnieId,
                        chapterEndpoint,
                        fileId,
                        title
                    }
                });
                return;
            }

            // Success!
            res.status(200).json({
                success: true,
                message: `Successfully uploaded "${videoInfo.title}" as chapter "${title}"`,
                videoInfo: {
                    title: videoInfo.title,
                    author: videoInfo.author,
                    duration: videoInfo.duration,
                    videoId: videoInfo.videoId
                },
                fileId: fileId,
                filename: filename,
                fileSize: fileSize,
                chapterData: addChapterResult.data,
                timestamp: new Date().toISOString()
            });

        } catch (s3Error) {
            console.error('S3 upload error:', s3Error);
            res.status(500).json({
                error: 'Failed to upload file to storage',
                details: s3Error.message
            });
            return;
        }

    } catch (error) {
        console.error('YouTube upload error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    } finally {
        // Clean up temporary file
        if (tempFilePath) {
            try {
                await unlink(tempFilePath);
                console.log(`Cleaned up temporary file: ${tempFilePath}`);
            } catch (cleanupError) {
                console.error(`Failed to cleanup temporary file: ${cleanupError.message}`);
            }
        }
    }
}
