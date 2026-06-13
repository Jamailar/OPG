#!/bin/sh
set -eu

node <<'NODE'
const fs = require('fs');

const config = {
  VITE_API_BASE_URL: process.env.VITE_API_BASE_URL || '',
  VITE_PLATFORM_APP_SLUG: process.env.VITE_PLATFORM_APP_SLUG || '',
  VITE_PLATFORM_ADMIN_DOMAIN: process.env.VITE_PLATFORM_ADMIN_DOMAIN || '',
  VITE_ADMIN_PORTAL_MODE: process.env.VITE_ADMIN_PORTAL_MODE || '',
};

const output = `window.__APPADMIN_RUNTIME_CONFIG__ = ${JSON.stringify(config, null, 2)};\n`;
fs.writeFileSync('/app/dist/env.js', output, 'utf8');
NODE

exec serve -s dist -l 3000 --no-clipboard
