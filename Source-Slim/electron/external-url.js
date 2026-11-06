'use strict';


function isAllowedExternalUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === 'wa.me' && !url.username && !url.password;
  } catch (_) {
    return false;
  }
}

function isAllowedAppNavigation(value, { port = 3000, tlsPort = port + 1000 } = {}) {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'file:') return false;
    if (url.username || url.password) return false;
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    const allowedPort = [String(port), String(tlsPort)].includes(url.port || (url.protocol === 'https:' ? '443' : '80'));
    return localHost && allowedPort && ['http:', 'https:'].includes(url.protocol);
  } catch (_) {
    return false;
  }
}

module.exports = { isAllowedExternalUrl, isAllowedAppNavigation };
