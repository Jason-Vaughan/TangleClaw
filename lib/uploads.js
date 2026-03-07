'use strict';

const fs = require('fs');
const path = require('path');

const PROJECTS_DIR = path.join(process.env.HOME, 'Documents', 'Projects');
const GLOBAL_UPLOADS_DIR = path.join(process.env.HOME, '.tangleclaw', 'uploads');

function getUploadsDir(project) {
  if (project) {
    return path.join(PROJECTS_DIR, project, '.uploads');
  }
  return GLOBAL_UPLOADS_DIR;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let _counter = 0;

function save(filename, base64Data, project) {
  const dir = getUploadsDir(project);
  ensureDir(dir);

  // Sanitize: preserve extension, clean the rest
  const ext = path.extname(filename);
  const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  _counter++;
  const finalName = `${ts}_${_counter}_${base}${ext}`;
  const filePath = path.join(dir, finalName);

  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(filePath, buffer);

  return {
    name: finalName,
    path: filePath,
    size: buffer.length,
    project: project || null,
  };
}

function list(project, count = 20) {
  const dir = getUploadsDir(project);
  ensureDir(dir);

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile())
      .map(e => {
        const filePath = path.join(dir, e.name);
        const stat = fs.statSync(filePath);
        return {
          name: e.name,
          path: filePath,
          size: stat.size,
          created: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.created - a.created)
      .slice(0, count);
  } catch {
    return [];
  }
}

module.exports = { save, list, getUploadsDir };
