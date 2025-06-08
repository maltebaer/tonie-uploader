# Tonie App - File Structure & Implementation Plan

## Project Structure
```
/
├── index.html          # Main frontend interface
├── style.css           # Styling
├── script.js           # Frontend JavaScript
├── vercel.json         # Vercel configuration
├── package.json        # Dependencies
├── .env.local          # Environment variables (local dev)
└── api/
    ├── auth.js         # Authenticate with Tonie API
    ├── households.js   # Get households and tonies
    ├── upload-file.js  # Handle file uploads
    └── upload-url.js   # Handle URL downloads & upload
```

## Environment Variables (Vercel Dashboard)
```
TONIE_EMAIL=your@email.com
TONIE_PASSWORD=yourpassword
APP_PASSWORD=yourappsecret
```

## Frontend Features
- Simple, clean interface
- Password protection for uploads
- Tonie selection dropdown
- File upload + URL input
- Upload progress indicator
- Success/error feedback

## API Endpoints
- `POST /api/auth` - Verify app password
- `GET /api/households` - Get households and creative tonies
- `POST /api/upload-file` - Upload file to selected tonie
- `POST /api/upload-url` - Download URL and upload to tonie

## Implementation Order
1. Project structure
2. Basic auth function
3. Households listing function
4. File upload function
5. URL upload function
6. Frontend interface
7. Styling and polish

## Next Steps
- [x] Create basic project structure
- [x] Create authentication flow
- [x] Build households listing
- [ ] Implement upload functionality
