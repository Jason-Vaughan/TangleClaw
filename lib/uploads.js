'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');

const log = createLogger('uploads');

const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.pdf',
  '.md', '.txt', '.json', '.yaml', '.yml'
]);

/**
 * Save an uploaded file to the project's .uploads/ directory.
 * @param {string} projectPath - Absolute path to the project directory
 * @param {string} filename - Original filename
 * @param {string} base64Data - Base64-encoded file content
 * @returns {{ path: string, name: string, size: number, createdAt: string }}
 */
function saveUpload(projectPath, filename, base64Data) {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('projectPath is required');
  }
  if (!filename || typeof filename !== 'string') {
    throw new Error('filename is required');
  }
  if (!base64Data || typeof base64Data !== 'string') {
    throw new Error('base64Data is required');
  }

  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`File type "${ext}" is not allowed. Allowed: ${Array.from(ALLOWED_EXTENSIONS).join(', ')}`);
  }

  // Sanitize the base filename (remove path separators, limit chars)
  const baseName = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeName = `${timestamp}-${baseName}${ext}`;

  const uploadsDir = path.join(projectPath, '.uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const filePath = path.join(uploadsDir, safeName);
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(filePath, buffer);

  log.info('File uploaded', { path: filePath, size: buffer.length });

  return {
    path: filePath,
    name: safeName,
    size: buffer.length,
    createdAt: now.toISOString()
  };
}

/**
 * List all uploads in a project's .uploads/ directory.
 * @param {string} projectPath - Absolute path to the project directory
 * @returns {Array<{ path: string, name: string, size: number, createdAt: string }>}
 */
function listUploads(projectPath) {
  const uploadsDir = path.join(projectPath, '.uploads');
  if (!fs.existsSync(uploadsDir)) {
    return [];
  }

  const entries = fs.readdirSync(uploadsDir);
  const uploads = [];

  for (const name of entries) {
    const filePath = path.join(uploadsDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      uploads.push({
        path: filePath,
        name,
        size: stat.size,
        createdAt: stat.birthtime.toISOString()
      });
    } catch (err) {
      log.warn('Failed to stat upload', { name, error: err.message });
    }
  }

  // Sort newest first
  uploads.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return uploads;
}

module.exports = { saveUpload, listUploads, ALLOWED_EXTENSIONS };
