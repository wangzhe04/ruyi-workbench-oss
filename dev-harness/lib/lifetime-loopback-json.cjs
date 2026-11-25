'use strict';

const http = require('node:http');

function requestJson(url, token, route, input, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const headers = { 'x-wcw-token': token };
    const bytes = input === undefined ? null : Buffer.from(JSON.stringify(input));
    if (bytes) Object.assign(headers, { 'content-type': 'application/json', 'content-length': bytes.length, origin: new URL(url).origin });
    const request = http.request(new URL(route, url), { method: bytes ? 'POST' : 'GET', agent: false, headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => {
        try { resolve({ status: response.statusCode, value: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
      response.once('error', reject);
    });
    request.once('error', reject);
    const timer = setTimeout(() => request.destroy(Error(route + ' timeout')), timeoutMs);
    request.once('close', () => clearTimeout(timer));
    request.end(bytes);
  });
}

module.exports = { requestJson };
