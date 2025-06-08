// api/upload-file.js
import { authenticateWithTonie, verifyAppPassword, setCorsHeaders, makeTonieApiRequest } from '../utils/auth.js';

// Supported audio formats based on Tonie API documentation
const SUPPORTED_FORMATS = [
    'aac', 'aiff', 'aif', 'flac', 'mp3', 'm4a', 'm4b',
    'oga', 'ogg', 'opus', 'wav', 'wma'
];

const MAX_FILE_SIZE = 1073741824; // 1 GB in bytes
const MAX_FILENAME_LENGTH = 128;

/**
 * Validate uploaded file against Tonie API requirements
 */
function validateFile(file, filename) {
    const errors = [];

    // Check file size (max 1 GB)
    if (file.length > MAX_FILE_SIZE) {
        errors.push(`File size (${Math.round(file.length / 1024 / 1024)}MB) exceeds maximum allowed size of 1GB`);
    }

    // Check filename length (max 128 characters)
    if (filename.length > MAX_FILENAME_LENGTH) {
        errors.push(`Filename length (${filename.length}) exceeds maximum allowed length of 128 characters`);
    }

    // Check file format
    const extension = filename.toLowerCase().split('.').pop();
    if (!SUPPORTED_FORMATS.includes(extension)) {
        errors.push(`File format "${extension}" is not supported. Supported formats: ${SUPPORTED_FORMATS.join(', ')}`);
    }

    return errors;
}

/**
 * Parse multipart form data manually (since Vercel doesn't support multer)
 * More robust version with better error handling
 */
function parseMultipartData(body, contentType) {
    console.log('Starting parseMultipartData...');

    const boundaryMatch = contentType.match(/boundary=([^;]+)/);
    if (!boundaryMatch) {
        throw new Error('Invalid multipart data: no boundary found in content-type');
    }

    const boundary = boundaryMatch[1].replace(/"/g, ''); // Remove quotes if present
    console.log(`Boundary: ${boundary}`);

    // Split by boundary
    const parts = body.split(`--${boundary}`);
    console.log(`Found ${parts.length} parts`);

    const fields = {};
    let fileData = null;
    let filename = '';

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        console.log(`Processing part ${i}, length: ${part.length}`);

        if (!part.includes('Content-Disposition')) {
            console.log(`Skipping part ${i} - no Content-Disposition`);
            continue;
        }

        try {
            const lines = part.split('\r\n');
            const disposition = lines.find(line => line.includes('Content-Disposition'));

            if (!disposition) {
                console.log(`Skipping part ${i} - no disposition line found`);
                continue;
            }

            console.log(`Disposition: ${disposition}`);

            // Parse field name
            const nameMatch = disposition.match(/name="([^"]+)"/);
            if (!nameMatch) {
                console.log(`Skipping part ${i} - no name found`);
                continue;
            }

            const fieldName = nameMatch[1];
            console.log(`Field name: ${fieldName}`);

            // Check if this is a file field
            const filenameMatch = disposition.match(/filename="([^"]+)"/);

            if (filenameMatch) {
                // This is a file
                filename = filenameMatch[1];
                console.log(`File field found: ${filename}`);

                const dataStartIndex = part.indexOf('\r\n\r\n') + 4;
                const dataEndIndex = part.lastIndexOf('\r\n');

                if (dataStartIndex < 4 || dataEndIndex <= dataStartIndex) {
                    console.error(`Invalid file data boundaries: start=${dataStartIndex}, end=${dataEndIndex}`);
                    continue;
                }

                fileData = Buffer.from(part.slice(dataStartIndex, dataEndIndex), 'binary');
                console.log(`File data extracted: ${fileData.length} bytes`);
            } else {
                // This is a regular field
                const dataStartIndex = part.indexOf('\r\n\r\n') + 4;
                const dataEndIndex = part.lastIndexOf('\r\n');

                if (dataStartIndex < 4 || dataEndIndex <= dataStartIndex) {
                    console.log(`Invalid field data boundaries for ${fieldName}`);
                    continue;
                }

                fields[fieldName] = part.slice(dataStartIndex, dataEndIndex);
                console.log(`Field ${fieldName}: ${fields[fieldName]}`);
            }
        } catch (error) {
            console.error(`Error processing part ${i}:`, error);
            continue;
        }
    }

    console.log('Parsing complete:', {
        fieldsCount: Object.keys(fields).length,
        hasFileData: !!fileData,
        filename
    });

    return { fields, fileData, filename };
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

    try {
        const contentType = req.headers['content-type'];

        if (!contentType || !contentType.includes('multipart/form-data')) {
            res.status(400).json({
                error: 'Invalid content type. Expected multipart/form-data'
            });
            return;
        }

        // Parse multipart form data
        console.log('Starting multipart parsing...');
        let rawBody;
        try {
            rawBody = await new Promise((resolve, reject) => {
                let data = '';
                req.setEncoding('binary');
                req.on('data', chunk => {
                    console.log(`Received chunk of size: ${chunk.length}`);
                    data += chunk;
                });
                req.on('end', () => {
                    console.log(`Total body size: ${data.length}`);
                    resolve(data);
                });
                req.on('error', reject);
            });
        } catch (error) {
            console.error('Error reading request body:', error);
            res.status(400).json({
                error: 'Failed to read request body',
                details: error.message
            });
            return;
        }

        console.log('Parsing multipart data...');
        let parsedData;
        try {
            parsedData = parseMultipartData(rawBody, contentType);
        } catch (error) {
            console.error('Error parsing multipart data:', error);
            res.status(400).json({
                error: 'Failed to parse multipart data',
                details: error.message
            });
            return;
        }

        const { fields, fileData, filename } = parsedData;

        // Validate required fields
        const { appPassword, tonieId, title } = fields;

        console.log('Parsed fields:', { appPassword: '***', tonieId, title, filename, fileSize: fileData?.length });

        if (!appPassword || !tonieId || !title || !fileData) {
            res.status(400).json({
                error: 'Missing required fields: appPassword, tonieId, title, and file are required',
                debug: {
                    hasAppPassword: !!appPassword,
                    hasTonieId: !!tonieId,
                    hasTitle: !!title,
                    hasFileData: !!fileData,
                    filename
                }
            });
            return;
        }

        // Verify app password
        if (!verifyAppPassword(appPassword)) {
            res.status(401).json({ error: 'Invalid app password' });
            return;
        }

        // Validate file
        const validationErrors = validateFile(fileData, filename);
        if (validationErrors.length > 0) {
            res.status(400).json({
                error: 'File validation failed',
                details: validationErrors
            });
            return;
        }

        // Debug mode: if title starts with "DEBUG", return parsing info without uploading
        if (title.startsWith('DEBUG')) {
            res.status(200).json({
                success: true,
                debug: true,
                message: 'Debug mode - multipart parsing successful',
                parsedData: {
                    filename,
                    fileSize: fileData.length,
                    title,
                    tonieId,
                    validationPassed: true
                }
            });
            return;
        }

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

        // Debug: log upload request structure
        console.log('Upload request structure:', {
            fileId: uploadRequest.fileId,
            url: uploadRequest.request?.url,
            fieldsCount: Object.keys(uploadRequest.request?.fields || {}).length
        });

        // Step 2: Upload file to Amazon S3
        console.log('Uploading file to Amazon S3...');
        try {
            const fileId = await uploadToS3(uploadRequest, fileData, filename);
            console.log(`File uploaded successfully with ID: ${fileId}`);

            // Step 3: Add chapter to Creative-Tonie
            console.log(`Adding chapter "${title}" to tonie ${tonieId}...`);

            // Parse tonieId to extract household and tonie IDs
            const [householdId, creativeTonnieId] = tonieId.split('/');
            console.log(`Parsed household ID: ${householdId}, Creative-Tonie ID: ${creativeTonnieId}`);

            // First, let's verify the Creative-Tonie exists by getting household data
            console.log('Verifying Creative-Tonie exists...');
            const householdResult = await makeTonieApiRequest(
                `/households/${householdId}/creativetonies`,
                accessToken
            );

            if (!householdResult.success) {
                console.error('Failed to get household Creative-Tonies:', householdResult.error);
                res.status(householdResult.status || 500).json({
                    error: 'Failed to verify Creative-Tonie exists',
                    details: householdResult.error,
                    debug: {
                        householdId,
                        creativeTonnieId,
                        endpoint: `/households/${householdId}/creativetonies`
                    }
                });
                return;
            }

            // Check if the Creative-Tonie ID exists
            const creativetonies = householdResult.data || [];
            const targetTonie = creativetonies.find(tonie => tonie.id === creativeTonnieId);

            if (!targetTonie) {
                console.error(`Creative-Tonie ${creativeTonnieId} not found in household ${householdId}`);
                console.log('Available Creative-Tonies:', creativetonies.map(t => ({ id: t.id, name: t.name })));

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

            // Now add the chapter
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
                message: `Successfully uploaded "${filename}" as chapter "${title}"`,
                fileId: fileId,
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
        console.error('Upload file error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
}
