const express = require('express');
const path = require('path');
const fs = require('fs');
const postmanToOpenAPI = require('@readme/postman-to-openapi');
const swaggerUi = require('swagger-ui-express');
const chokidar = require('chokidar');
const lockfile = require('proper-lockfile');
const debounce = require('lodash.debounce');
const yaml = require('js-yaml');
const multer = require('multer');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3001;

// Paths
const POSTMAN_JSON_PATH = path.join(__dirname, 'postman_collection.json');
const OPENAPI_JSON_PATH = path.join(__dirname, 'openapi.json');
const BACKUP_DIR = path.join(__dirname, 'backups');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Configure middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Set up multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, __dirname);
    },
    filename: (req, file, cb) => {
        // Always save as postman_collection.json
        cb(null, 'postman_collection.json');
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit
    fileFilter: (req, file, cb) => {
        // Accept only json files
        if (!file.originalname.match(/\.(json)$/)) {
            return cb(new Error('Only JSON files are allowed'), false);
        }
        cb(null, true);
    }
});

// Function to convert Postman JSON to OpenAPI JSON with improved error handling and versioning
async function convertPostmanToOpenAPI() {
    let release;
    try {
        // Make sure the openapi.json file exists before trying to lock it
        if (!fs.existsSync(OPENAPI_JSON_PATH)) {
            fs.writeFileSync(OPENAPI_JSON_PATH, '{}', 'utf8');
        }
        
        // Acquire a lock on the OpenAPI file
        release = await lockfile.lock(OPENAPI_JSON_PATH, { retries: 5 });

        // Validate that the Postman JSON is valid
        const postmanData = JSON.parse(fs.readFileSync(POSTMAN_JSON_PATH, 'utf8'));
        
        // Backup existing OpenAPI file
        if (fs.existsSync(OPENAPI_JSON_PATH) && fs.statSync(OPENAPI_JSON_PATH).size > 2) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = path.join(BACKUP_DIR, `openapi-${timestamp}.json`);
            fs.copyFileSync(OPENAPI_JSON_PATH, backupPath);
            console.log(`Backed up existing OpenAPI file to ${backupPath}`);
        }

        // Create a temporary file for conversion output
        const tempOutputPath = path.join(__dirname, 'temp-openapi.json');

        // Proceed with conversion
        await postmanToOpenAPI(POSTMAN_JSON_PATH, tempOutputPath, { 
            defaultTag: 'General',
            outputFormat: 'json'  // Explicitly request JSON output
        });
        
        // Read the output file
        const openApiContent = fs.readFileSync(tempOutputPath, 'utf8');
        
        // Check if it's YAML (starts with 'openapi:') and convert if needed
        if (openApiContent.trim().startsWith('openapi:')) {
            console.log('Detected YAML output, converting to JSON...');
            try {
                const yamlObject = yaml.load(openApiContent);
                fs.writeFileSync(OPENAPI_JSON_PATH, JSON.stringify(yamlObject, null, 2));
            } catch (yamlError) {
                console.error('Error converting YAML to JSON:', yamlError.message);
                throw yamlError;
            }
        } else {
            // It's already JSON or another format, just copy it
            fs.copyFileSync(tempOutputPath, OPENAPI_JSON_PATH);
        }
        
        // Clean up temp file
        if (fs.existsSync(tempOutputPath)) {
            fs.unlinkSync(tempOutputPath);
        }
        
        console.log('Postman JSON converted to OpenAPI JSON successfully.');
        
        // Check if output is valid without strict JSON parsing
        const finalContent = fs.readFileSync(OPENAPI_JSON_PATH, 'utf8');
        if (!finalContent || finalContent.trim() === '') {
            throw new Error('Generated OpenAPI file is empty');
        }
        
        // Try to parse as JSON to verify
        try {
            JSON.parse(finalContent);
        } catch (jsonError) {
            console.warn('Warning: Output file is not valid JSON. Swagger UI may not work correctly.');
        }
        
        return true;
    } catch (error) {
        console.error('Error converting Postman JSON:', error.message);
        
        // Restore from the most recent backup if the current conversion failed
        const backupFiles = fs.readdirSync(BACKUP_DIR).filter(file => file.startsWith('openapi-'));
        if (backupFiles.length > 0) {
            // Sort by timestamp (newest first)
            backupFiles.sort().reverse();
            const latestBackup = path.join(BACKUP_DIR, backupFiles[0]);
            console.log(`Restoring from backup: ${latestBackup}`);
            fs.copyFileSync(latestBackup, OPENAPI_JSON_PATH);
        }
        
        return false;
    } finally {
        // Always release the lock
        if (release) await release();
    }
}

// Create a debounced version of the conversion function
const debouncedConvert = debounce(() => {
    console.log('Detected change in Postman JSON. Converting...');
    convertPostmanToOpenAPI();
}, 2000); // Wait 2 seconds after the last change before converting

// HTML Templates for the UI
const getBaseHTML = (content) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API Endpoint Manager</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body { padding-top: 20px; }
        .container { max-width: 960px; }
        pre { background-color: #f8f9fa; padding: 15px; border-radius: 5px; max-height: 500px; overflow: auto; }
        .nav-tabs { margin-bottom: 20px; }
        #editor { height: 500px; border: 1px solid #ced4da; border-radius: 5px; }
        .alert-fixed { position: fixed; top: 20px; right: 20px; width: 300px; z-index: 9999; }
    </style>
</head>
<body>
    <div class="container">
        <h1 class="mb-4">API Endpoint Manager</h1>
        <ul class="nav nav-tabs" id="myTab" role="tablist">
            <li class="nav-item" role="presentation">
                <button class="nav-link active" id="editor-tab" data-bs-toggle="tab" data-bs-target="#editor-tab-pane" type="button" role="tab">Editor</button>
            </li>
            <li class="nav-item" role="presentation">
                <button class="nav-link" id="upload-tab" data-bs-toggle="tab" data-bs-target="#upload-tab-pane" type="button" role="tab">Upload</button>
            </li>
            <li class="nav-item" role="presentation">
                <button class="nav-link" id="status-tab" data-bs-toggle="tab" data-bs-target="#status-tab-pane" type="button" role="tab">Status</button>
            </li>
        </ul>
        
        <div class="tab-content" id="myTabContent">
            ${content}
        </div>
    </div>

    <div id="alertContainer"></div>
    
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/js/bootstrap.bundle.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/ace/1.23.4/ace.js"></script>
    <script>
        // Initialize Ace Editor
        const editor = ace.edit("editor");
        editor.setTheme("ace/theme/monokai");
        editor.session.setMode("ace/mode/json");
        
        // Function to show alerts
        function showAlert(message, type = 'success') {
            const alertHTML = \`
                <div class="alert alert-\${type} alert-dismissible fade show alert-fixed" role="alert">
                    \${message}
                    <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
                </div>
            \`;
            document.getElementById('alertContainer').innerHTML = alertHTML;
            
            // Auto-dismiss after 5 seconds
            setTimeout(() => {
                const alertElement = document.querySelector('.alert');
                if (alertElement) {
                    const bsAlert = bootstrap.Alert.getInstance(alertElement);
                    if (bsAlert) {
                        bsAlert.close();
                    }
                }
            }, 5000);
        }
        
        // Load Postman Collection into Editor
        async function loadPostmanCollection() {
            try {
                const response = await fetch('/api/collection');
                if (!response.ok) {
                    throw new Error('Failed to load collection');
                }
                const data = await response.json();
                editor.setValue(JSON.stringify(data, null, 2));
                editor.clearSelection();
            } catch (error) {
                console.error('Error loading collection:', error);
                showAlert('Error loading collection: ' + error.message, 'danger');
            }
        }
        
        // Save Collection from Editor
        async function saveCollection() {
            try {
                const editorContent = editor.getValue();
                
                // Validate JSON
                try {
                    JSON.parse(editorContent);
                } catch (e) {
                    showAlert('Invalid JSON: ' + e.message, 'danger');
                    return;
                }
                
                const response = await fetch('/api/collection', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: editorContent
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(errorText || 'Failed to save collection');
                }
                
                showAlert('Collection saved successfully!');
                
                // Trigger conversion
                await triggerConversion();
            } catch (error) {
                console.error('Error saving collection:', error);
                showAlert('Error saving collection: ' + error.message, 'danger');
            }
        }
        
        // Trigger conversion
        async function triggerConversion() {
            try {
                const response = await fetch('/api/update', {
                    method: 'POST'
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(errorText || 'Failed to trigger conversion');
                }
                
                showAlert('Conversion triggered successfully!');
                
                // Refresh status
                await refreshStatus();
            } catch (error) {
                console.error('Error triggering conversion:', error);
                showAlert('Error triggering conversion: ' + error.message, 'danger');
            }
        }
        
        // Refresh Status
        async function refreshStatus() {
            try {
                const healthResponse = await fetch('/health');
                const healthData = await healthResponse.json();
                
                let statusHtml = \`<div class="card mb-3">
                    <div class="card-header bg-\${healthData.status === 'ok' ? 'success' : 'danger'} text-white">
                        Service Status: \${healthData.status.toUpperCase()}
                    </div>
                    <div class="card-body">
                        <p>\${healthData.message}</p>
                    </div>
                </div>\`;
                
                // Get backups
                const backupsResponse = await fetch('/api/backups');
                if (backupsResponse.ok) {
                    const backupsData = await backupsResponse.json();
                    
                    statusHtml += \`<div class="card mb-3">
                        <div class="card-header">Backup Files</div>
                        <div class="card-body">
                            <table class="table table-striped">
                                <thead>
                                    <tr>
                                        <th>Filename</th>
                                        <th>Created</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>\`;
                    
                    backupsData.forEach(backup => {
                        const filename = backup.filename;
                        const date = new Date(backup.created).toLocaleString();
                        statusHtml += \`
                            <tr>
                                <td>\${filename}</td>
                                <td>\${date}</td>
                                <td>
                                    <button class="btn btn-sm btn-warning" onclick="restoreBackup('\${filename}')">Restore</button>
                                </td>
                            </tr>
                        \`;
                    });
                    
                    statusHtml += \`</tbody></table></div></div>\`;
                }
                
                document.getElementById('status-content').innerHTML = statusHtml;
            } catch (error) {
                console.error('Error refreshing status:', error);
                document.getElementById('status-content').innerHTML = \`
                    <div class="alert alert-danger">
                        Error loading status: \${error.message}
                    </div>
                \`;
            }
        }
        
        // Restore backup
        async function restoreBackup(filename) {
            try {
                const response = await fetch(\`/api/restore/\${filename}\`, {
                    method: 'POST'
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(errorText || 'Failed to restore backup');
                }
                
                showAlert('Backup restored successfully!');
                
                // Refresh status
                await refreshStatus();
                
                // Reload editor content
                await loadPostmanCollection();
            } catch (error) {
                console.error('Error restoring backup:', error);
                showAlert('Error restoring backup: ' + error.message, 'danger');
            }
        }
        
        // Load initial data
        document.addEventListener('DOMContentLoaded', () => {
            loadPostmanCollection();
            refreshStatus();
            
            // Set up tab change event
            const triggerTabList = document.querySelectorAll('#myTab button');
            triggerTabList.forEach(triggerEl => {
                triggerEl.addEventListener('click', event => {
                    const tabTarget = event.target.getAttribute('data-bs-target');
                    if (tabTarget === '#status-tab-pane') {
                        refreshStatus();
                    }
                });
            });
        });
    </script>
</body>
</html>
`;

const editorTabContent = `
<div class="tab-pane fade show active" id="editor-tab-pane" role="tabpanel" aria-labelledby="editor-tab" tabindex="0">
    <div class="card mb-3">
        <div class="card-header">Edit Postman Collection JSON</div>
        <div class="card-body">
            <div id="editor"></div>
            <div class="mt-3">
                <button class="btn btn-primary" onclick="saveCollection()">Save Collection</button>
                <button class="btn btn-secondary" onclick="loadPostmanCollection()">Reload</button>
                <button class="btn btn-success" onclick="triggerConversion()">Convert to OpenAPI</button>
                <a href="/docs" class="btn btn-info" target="_blank">View Swagger UI</a>
            </div>
        </div>
    </div>
</div>
`;

const uploadTabContent = `
<div class="tab-pane fade" id="upload-tab-pane" role="tabpanel" aria-labelledby="upload-tab" tabindex="0">
    <div class="card mb-3">
        <div class="card-header">Upload Postman Collection</div>
        <div class="card-body">
            <form id="uploadForm" action="/api/upload" method="post" enctype="multipart/form-data">
                <div class="mb-3">
                    <label for="collectionFile" class="form-label">Postman Collection JSON File</label>
                    <input class="form-control" type="file" id="collectionFile" name="collectionFile" accept=".json">
                    <div class="form-text">Upload a Postman Collection JSON file (max 50MB)</div>
                </div>
                <button type="submit" class="btn btn-primary">Upload</button>
            </form>
        </div>
    </div>
</div>
`;

const statusTabContent = `
<div class="tab-pane fade" id="status-tab-pane" role="tabpanel" aria-labelledby="status-tab" tabindex="0">
    <div id="status-content">
        <div class="d-flex justify-content-center">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    </div>
</div>
`;

// Root route
app.get('/', (req, res) => {
    const htmlContent = getBaseHTML(editorTabContent + uploadTabContent + statusTabContent);
    res.send(htmlContent);
});

// API endpoints for UI
app.get('/api/collection', (req, res) => {
    try {
        if (fs.existsSync(POSTMAN_JSON_PATH)) {
            const data = JSON.parse(fs.readFileSync(POSTMAN_JSON_PATH, 'utf8'));
            res.json(data);
        } else {
            res.status(404).send('Postman collection not found');
        }
    } catch (error) {
        res.status(500).send(`Error reading collection: ${error.message}`);
    }
});

app.post('/api/collection', (req, res) => {
    try {
        // Make a backup of the current file
        if (fs.existsSync(POSTMAN_JSON_PATH)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = path.join(BACKUP_DIR, `postman-${timestamp}.json`);
            fs.copyFileSync(POSTMAN_JSON_PATH, backupPath);
        }
        
        // Save the new collection
        fs.writeFileSync(POSTMAN_JSON_PATH, JSON.stringify(req.body, null, 2));
        res.send('Collection saved successfully');
    } catch (error) {
        res.status(500).send(`Error saving collection: ${error.message}`);
    }
});

app.post('/api/upload', upload.single('collectionFile'), (req, res) => {
    try {
        res.redirect('/?success=true#upload-tab-pane');
    } catch (error) {
        res.status(500).send(`Error uploading file: ${error.message}`);
    }
});

app.get('/api/backups', (req, res) => {
    try {
        const backupFiles = fs.readdirSync(BACKUP_DIR);
        const backups = backupFiles
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const filePath = path.join(BACKUP_DIR, file);
                const stats = fs.statSync(filePath);
                return {
                    filename: file,
                    created: stats.mtime,
                    size: stats.size
                };
            })
            .sort((a, b) => new Date(b.created) - new Date(a.created));
            
        res.json(backups);
    } catch (error) {
        res.status(500).send(`Error getting backups: ${error.message}`);
    }
});

app.post('/api/restore/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const backupPath = path.join(BACKUP_DIR, filename);
        
        if (!fs.existsSync(backupPath)) {
            return res.status(404).send('Backup file not found');
        }
        
        // If it's an OpenAPI backup, restore to openapi.json
        if (filename.startsWith('openapi-')) {
            fs.copyFileSync(backupPath, OPENAPI_JSON_PATH);
        }
        // If it's a Postman backup, restore to postman_collection.json
        else if (filename.startsWith('postman-')) {
            fs.copyFileSync(backupPath, POSTMAN_JSON_PATH);
            // Trigger conversion after restoring Postman collection
            convertPostmanToOpenAPI();
        }
        
        res.send('Backup restored successfully');
    } catch (error) {
        res.status(500).send(`Error restoring backup: ${error.message}`);
    }
});

// Serve OpenAPI JSON dynamically
app.get('/api/openapi', (req, res) => {
    if (fs.existsSync(OPENAPI_JSON_PATH)) {
        res.sendFile(OPENAPI_JSON_PATH);
    } else {
        res.status(404).send('OpenAPI JSON not found. Please upload a valid Postman JSON.');
    }
});

// Add an endpoint to manually trigger the conversion
app.post('/api/update', async (req, res) => {
    console.log('Manual update triggered');
    const success = await convertPostmanToOpenAPI();
    if (success) {
        res.send('Conversion triggered successfully');
    } else {
        res.status(500).send('Error occurred during conversion. Check server logs.');
    }
});

// Add a health check endpoint
app.get('/health', (req, res) => {
    if (fs.existsSync(OPENAPI_JSON_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(OPENAPI_JSON_PATH, 'utf8'));
            res.status(200).json({ status: 'ok', message: 'Service is healthy' });
        } catch (error) {
            res.status(500).json({ status: 'error', message: 'OpenAPI file exists but is not valid JSON' });
        }
    } else {
        res.status(503).json({ status: 'error', message: 'OpenAPI file does not exist' });
    }
});

// Serve Swagger UI
app.use('/docs', swaggerUi.serve, swaggerUi.setup(null, { 
    swaggerOptions: { 
        url: '/api/openapi',
        displayRequestDuration: true,
        defaultModelsExpandDepth: -1 // Hide schemas section by default
    }
}));

// Watch for changes in the Postman JSON file
chokidar.watch(POSTMAN_JSON_PATH, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100
    }
}).on('change', () => {
    debouncedConvert();
});

// Initial conversion on startup
if (fs.existsSync(POSTMAN_JSON_PATH)) {
    convertPostmanToOpenAPI();
} else {
    console.warn('Postman JSON file not found at startup. Please place a valid file at:', POSTMAN_JSON_PATH);
    // Create empty openapi.json to avoid issues
    fs.writeFileSync(OPENAPI_JSON_PATH, '{}', 'utf8');
}

// Start the server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Web UI available at http://localhost:${PORT}`);
    console.log(`Swagger UI available at http://localhost:${PORT}/docs`);
    console.log(`Manual update endpoint at http://localhost:${PORT}/api/update (POST)`);
    console.log(`Health check endpoint at http://localhost:${PORT}/health`);
    console.log('Watching Postman JSON file at:', POSTMAN_JSON_PATH);
});
