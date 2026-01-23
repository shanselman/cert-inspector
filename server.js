const express = require('express');
const { chromium } = require('playwright');
const dns = require('dns').promises;
const tls = require('tls');
const https = require('https');
const { execSync, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTO_OPEN = process.env.NO_OPEN !== '1'; // Set NO_OPEN=1 to disable

// Check if Playwright browsers are installed, offer to install if not
async function ensureBrowserInstalled() {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    console.log('✅ Playwright browser found');
    return true;
  } catch (error) {
    if (error.message.includes('Executable doesn\'t exist') || error.message.includes('browserType.launch')) {
      console.log('\n⚠️  Playwright browser not found!');
      console.log('📦 Installing Chromium browser (this only happens once)...\n');
      
      try {
        // Use direct node execution instead of npx for standalone executables
        const path = require('path');
        const playwrightPath = require.resolve('playwright');
        const playwrightCliPath = path.join(path.dirname(playwrightPath), 'cli.js');
        execSync(`node "${playwrightCliPath}" install chromium`, { stdio: 'inherit' });
        console.log('\n✅ Browser installed successfully!\n');
        return true;
      } catch (installError) {
        console.error('\n❌ Failed to install browser automatically.');
        console.error('Please try running manually with node installed.\n');
        return false;
      }
    }
    throw error;
  }
}

async function getCertificate(hostname, port = 443) {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect(port, hostname, { servername: hostname, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate(true);
      const responseTime = Date.now() - startTime;
      const tlsVersion = socket.getProtocol();
      socket.end();
      if (cert && cert.subject) {
        const chain = [];
        let current = cert;
        while (current && current.issuerCertificate && current.issuerCertificate !== current) {
          chain.push({ subject: current.subject?.CN || current.subject?.O, issuer: current.issuer?.CN || current.issuer?.O });
          current = current.issuerCertificate;
        }
        if (current && current.subject) {
          chain.push({ subject: current.subject?.CN || current.subject?.O, issuer: current.issuer?.CN || current.issuer?.O });
        }
        resolve({
          subject: cert.subject.CN || cert.subject.O,
          issuer: cert.issuer?.CN || cert.issuer?.O,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          serialNumber: cert.serialNumber,
          fingerprint: cert.fingerprint,
          tlsVersion,
          responseTime,
          chain: chain.length > 1 ? chain : null
        });
      } else {
        resolve(null);
      }
    });
    socket.on('error', () => resolve(null));
    socket.setTimeout(5000, () => { socket.destroy(); resolve(null); });
  });
}

async function getHstsStatus(hostname) {
  return new Promise((resolve) => {
    const req = https.request({ hostname, port: 443, method: 'HEAD', timeout: 5000 }, (res) => {
      const hsts = res.headers['strict-transport-security'];
      resolve(hsts ? { enabled: true, value: hsts } : { enabled: false });
    });
    req.on('error', () => resolve({ enabled: false }));
    req.on('timeout', () => { req.destroy(); resolve({ enabled: false }); });
    req.end();
  });
}

async function getDnsInfo(hostname) {
  const result = { hostname, addresses: [], cname: null, error: null };
  try { result.addresses = await dns.resolve4(hostname); } catch (e) {
    try { result.addresses = await dns.resolve6(hostname); } catch (e2) { result.error = 'Could not resolve'; }
  }
  try { const cnames = await dns.resolveCname(hostname); result.cname = cnames[0] || null; } catch (e) { }
  return result;
}

function getCertHealth(cert) {
  if (!cert) return { status: 'none', icon: '⚪', class: 'none', message: 'No HTTPS', days: null };
  const now = new Date();
  const validTo = new Date(cert.validTo);
  const validFrom = new Date(cert.validFrom);
  const daysUntilExpiry = Math.floor((validTo - now) / (1000 * 60 * 60 * 24));
  if (now < validFrom) return { status: 'error', icon: '🔴', class: 'error', message: 'Not yet valid', days: daysUntilExpiry };
  if (now > validTo) return { status: 'error', icon: '🔴', class: 'error', message: 'EXPIRED', days: daysUntilExpiry };
  if (daysUntilExpiry <= 7) return { status: 'critical', icon: '🔴', class: 'error', message: `Expires in ${daysUntilExpiry} days!`, days: daysUntilExpiry };
  if (daysUntilExpiry <= 30) return { status: 'warning', icon: '🟡', class: 'warning', message: `Expires in ${daysUntilExpiry} days`, days: daysUntilExpiry };
  return { status: 'ok', icon: '🟢', class: 'ok', message: `Valid for ${daysUntilExpiry} days`, days: daysUntilExpiry };
}

function getDnsHealth(d) {
  if (d.error || !d.addresses || d.addresses.length === 0) return { icon: '🔴', class: 'error' };
  return { icon: '🟢', class: 'ok' };
}

// Normalize URL - add https:// if missing
function normalizeUrl(input) {
  let url = input.trim();
  if (!url) return null;
  // Add protocol if missing
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  // Validate it's a proper URL
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

// Streaming endpoint for real-time progress
app.get('/inspect-stream', async (req, res) => {
  const url = normalizeUrl(req.query.url);
  if (!url) {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let browser;
  try {
    send({ phase: '🚀 Launching browser...' });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const domains = new Set();

    send({ phase: '🌐 Loading page...', log: `Navigating to ${url}` });

    page.on('request', (request) => {
      try {
        const u = new URL(request.url());
        if (u.protocol === 'https:' || u.protocol === 'http:') {
          const isNew = !domains.has(u.hostname);
          domains.add(u.hostname);
          if (isNew) {
            send({ log: `Found: ${u.hostname}`, type: 'domain', domainCount: domains.size });
          }
        }
      } catch (e) { }
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    send({ phase: '⏳ Waiting for additional requests...', log: 'Page loaded, waiting for lazy resources...' });
    await page.waitForTimeout(2000);
    await browser.close();
    browser = null;

    const domainList = Array.from(domains).sort();
    send({ phase: `🔍 Inspecting ${domainList.length} domains...`, domainCount: domainList.length });

    let checked = 0;
    for (const hostname of domainList) {
      send({ log: `Checking ${hostname}...`, type: 'info', checked: checked });
      const [dnsInfo, certInfo, hstsInfo] = await Promise.all([
        getDnsInfo(hostname),
        getCertificate(hostname),
        getHstsStatus(hostname)
      ]);
      checked++;
      const health = getCertHealth(certInfo);
      send({ 
        log: `✓ ${hostname}: ${health.message}`, 
        type: health.status === 'ok' ? 'success' : (health.status === 'warning' ? 'warn' : (health.status === 'none' ? 'info' : 'error')),
        checked: checked 
      });
    }

    send({ phase: '✅ Complete!', log: `Finished inspecting ${domainList.length} domains`, done: true });
  } catch (error) {
    if (browser) await browser.close();
    send({ error: error.message });
  }
  res.end();
});

app.get('/inspect', async (req, res) => {
  const url = normalizeUrl(req.query.url);
  if (!url) return res.status(400).json({ error: 'Invalid URL' });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const domains = new Set();

    page.on('request', (request) => {
      try { const u = new URL(request.url()); if (u.protocol === 'https:' || u.protocol === 'http:') domains.add(u.hostname); } catch (e) { }
    });
    page.on('response', (response) => {
      try { const u = new URL(response.url()); if (u.protocol === 'https:' || u.protocol === 'http:') domains.add(u.hostname); } catch (e) { }
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await browser.close();
    browser = null;

    const results = [];
    for (const hostname of Array.from(domains).sort()) {
      const [dnsInfo, certInfo, hstsInfo] = await Promise.all([getDnsInfo(hostname), getCertificate(hostname), getHstsStatus(hostname)]);
      results.push({ domain: hostname, dns: dnsInfo, certificate: certInfo, hsts: hstsInfo });
    }

    if (req.accepts('html')) res.send(renderHtml(url, results));
    else res.json({ url, domains: results });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  }
});

app.get('/export', (req, res) => {
  const data = req.query.data;
  const format = req.query.format || 'json';
  if (!data) return res.status(400).json({ error: 'Missing data' });
  try {
    const results = JSON.parse(decodeURIComponent(data));
    if (format === 'csv') {
      const headers = ['Domain', 'Status', 'Days Until Expiry', 'Valid From', 'Valid To', 'Issuer', 'TLS Version', 'HSTS', 'Response Time (ms)', 'IP Addresses'];
      const rows = results.map(r => {
        const cert = r.certificate;
        const health = getCertHealth(cert);
        return [r.domain, health.status, health.days ?? 'N/A', cert?.validFrom || 'N/A', cert?.validTo || 'N/A', cert?.issuer || 'N/A', cert?.tlsVersion || 'N/A', r.hsts?.enabled ? 'Yes' : 'No', cert?.responseTime || 'N/A', r.dns.addresses?.join('; ') || 'N/A'].map(v => `"${v}"`).join(',');
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="cert-inspection.csv"');
      res.send([headers.join(','), ...rows].join('\n'));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="cert-inspection.json"');
      res.send(JSON.stringify(results, null, 2));
    }
  } catch (e) { res.status(400).json({ error: 'Invalid data' }); }
});

function renderHtml(url, results) {
  const healthOrder = { error: 0, critical: 0, warning: 1, ok: 2, none: 3 };
  results.sort((a, b) => healthOrder[getCertHealth(a.certificate).status] - healthOrder[getCertHealth(b.certificate).status]);

  const summary = {
    total: results.length,
    ok: results.filter(r => getCertHealth(r.certificate).status === 'ok').length,
    warning: results.filter(r => getCertHealth(r.certificate).status === 'warning').length,
    error: results.filter(r => ['error', 'critical'].includes(getCertHealth(r.certificate).status)).length,
    none: results.filter(r => getCertHealth(r.certificate).status === 'none').length
  };

  const byIssuer = {};
  results.forEach(r => { const issuer = r.certificate?.issuer || 'No Certificate'; if (!byIssuer[issuer]) byIssuer[issuer] = []; byIssuer[issuer].push(r); });
  const issuerOptions = Object.keys(byIssuer).map(i => `<option value="${i}">${i} (${byIssuer[i].length})</option>`).join('');

  const rows = results.map((r, idx) => {
    const cert = r.certificate;
    const certHealth = getCertHealth(cert);
    const dnsHealth = getDnsHealth(r.dns);
    const favicon = `https://www.google.com/s2/favicons?domain=${r.domain}&sz=32`;
    const daysDisplay = cert ? `<div class="days-number ${certHealth.class}">${certHealth.days}</div><div class="days-label">days</div>` : '<div class="days-number none">—</div>';
    const chainHtml = cert?.chain ? cert.chain.map((c, i) => `<div class="chain-item" style="margin-left: ${i * 15}px">↳ ${c.subject}</div>`).join('') : '';
    const certDetails = cert
      ? `<div class="cert-summary"><strong>Subject:</strong> ${cert.subject}<br><strong>Issuer:</strong> ${cert.issuer}<br><strong>Valid:</strong> ${cert.validFrom} → ${cert.validTo}</div>
         <div class="cert-details" id="details-${idx}" style="display:none">
           <strong>Serial:</strong> <span class="copyable" onclick="copyText('${cert.serialNumber}')">${cert.serialNumber}</span><br>
           <strong>Fingerprint:</strong> <span class="copyable" onclick="copyText('${cert.fingerprint}')">${cert.fingerprint}</span><br>
           <strong>TLS:</strong> <span class="tls-badge ${cert.tlsVersion === 'TLSv1.3' ? 'tls13' : 'tls12'}">${cert.tlsVersion}</span>
           <strong>Response:</strong> ${cert.responseTime}ms
           <strong>HSTS:</strong> ${r.hsts?.enabled ? '✅' : '❌'}<br>
           ${chainHtml ? `<strong>Chain:</strong><div class="chain">${chainHtml}</div>` : ''}
         </div>` : '<em>No HTTPS cert</em>';
    return `<tr class="row-${certHealth.class}" data-status="${certHealth.status}" data-issuer="${cert?.issuer || 'none'}" data-domain="${r.domain}">
      <td class="status-cell">${certHealth.icon}</td>
      <td class="domain-cell"><img src="${favicon}" class="favicon" onerror="this.style.display='none'"><strong class="copyable" onclick="copyText('${r.domain}')">${r.domain}</strong></td>
      <td class="days-cell">${daysDisplay}</td>
      <td class="dns-cell">${dnsHealth.icon} ${r.dns.addresses?.join(', ') || r.dns.error || 'N/A'}<br><small>CNAME: ${r.dns.cname || '-'}</small></td>
      <td class="cert-cell">${certDetails}${cert ? `<button class="expand-btn" onclick="toggleDetails(${idx})">Details ▼</button>` : ''}<span class="health-badge ${certHealth.class}">${certHealth.message}</span></td>
    </tr>`;
  }).join('');

  const summaryCards = results.map(r => {
    const health = getCertHealth(r.certificate);
    return `<div class="summary-card ${health.class}" data-status="${health.status}" data-domain="${r.domain}">
      <img src="https://www.google.com/s2/favicons?domain=${r.domain}&sz=32" onerror="this.style.display='none'">
      <span class="domain">${r.domain}</span><span class="days ${health.class}">${health.days ?? '—'}</span>
    </div>`;
  }).join('');

  const timelineData = JSON.stringify(results.filter(r => r.certificate).map(r => ({ domain: r.domain, expiry: new Date(r.certificate.validTo).getTime(), health: getCertHealth(r.certificate).class })).sort((a, b) => a.expiry - b.expiry));
  const exportData = encodeURIComponent(JSON.stringify(results));

  return `<!DOCTYPE html>
<html>
<head>
  <title>Certificate Inspector</title>
  <style>
    :root { --bg: #f5f5f5; --card-bg: white; --text: #333; --border: #ddd; --hover: #f0f7ff; }
    .dark { --bg: #1a1a2e; --card-bg: #16213e; --text: #eee; --border: #333; --hover: #1f3460; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background: var(--bg); color: var(--text); transition: all 0.3s; }
    h1 { color: var(--text); }
    .url { background: var(--card-bg); padding: 10px; border-radius: 4px; word-break: break-all; margin-bottom: 20px; border: 1px solid var(--border); }
    .controls { display: flex; gap: 15px; flex-wrap: wrap; margin-bottom: 20px; align-items: center; }
    .view-toggle, .filter-group { display: flex; gap: 5px; align-items: center; }
    .view-toggle button, .export-btn { padding: 8px 16px; border: 1px solid var(--border); background: var(--card-bg); color: var(--text); cursor: pointer; border-radius: 4px; }
    .view-toggle button.active, .export-btn:hover { background: #4a90d9; color: white; border-color: #4a90d9; }
    .filter-group label { display: flex; align-items: center; gap: 4px; cursor: pointer; padding: 5px 10px; background: var(--card-bg); border-radius: 4px; border: 1px solid var(--border); }
    .search-box { padding: 8px 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--card-bg); color: var(--text); min-width: 200px; }
    select { padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--card-bg); color: var(--text); }
    .dark-toggle { margin-left: auto; }
    .progress-bar { display: flex; height: 24px; border-radius: 4px; overflow: hidden; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .progress-segment { display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; font-weight: bold; }
    .progress-ok { background: #28a745; }
    .progress-warning { background: #ffc107; color: #333; }
    .progress-error { background: #dc3545; }
    .progress-none { background: #6c757d; }
    .summary { margin: 20px 0; padding: 15px; background: var(--card-bg); border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); display: flex; gap: 20px; flex-wrap: wrap; }
    .summary-item { display: flex; align-items: center; gap: 8px; }
    table { border-collapse: collapse; width: 100%; background: var(--card-bg); box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { border: 1px solid var(--border); padding: 12px; text-align: left; vertical-align: top; }
    th { background: #4a90d9; color: white; position: sticky; top: 0; }
    tr:hover { background: var(--hover); }
    small { color: #888; }
    .status-cell { text-align: center; font-size: 1.2em; width: 40px; }
    .domain-cell { display: flex; align-items: center; gap: 8px; }
    .favicon { width: 16px; height: 16px; }
    .days-cell { text-align: center; width: 80px; }
    .days-number { font-size: 1.8em; font-weight: bold; }
    .days-number.ok { color: #28a745; }
    .days-number.warning { color: #ffc107; }
    .days-number.error { color: #dc3545; }
    .days-number.none { color: #6c757d; }
    .days-label { font-size: 0.8em; color: #888; }
    .health-badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 0.85em; margin-top: 5px; }
    .health-badge.ok { background: #d4edda; color: #155724; }
    .health-badge.warning { background: #fff3cd; color: #856404; }
    .health-badge.error { background: #f8d7da; color: #721c24; }
    .health-badge.none { background: #e2e3e5; color: #383d41; }
    .tls-badge { padding: 2px 6px; border-radius: 3px; font-size: 0.8em; margin-right: 10px; }
    .tls-badge.tls13 { background: #d4edda; color: #155724; }
    .tls-badge.tls12 { background: #fff3cd; color: #856404; }
    .row-error { background: rgba(220, 53, 69, 0.1); }
    .row-warning { background: rgba(255, 193, 7, 0.1); }
    .row-ok { background: rgba(40, 167, 69, 0.1); }
    .row-none { background: rgba(108, 117, 125, 0.1); }
    .cert-details { margin-top: 10px; padding: 10px; background: rgba(0,0,0,0.05); border-radius: 4px; font-size: 0.9em; }
    .expand-btn { background: none; border: 1px solid var(--border); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 0.8em; margin: 5px 5px 0 0; color: var(--text); }
    .chain { margin-top: 5px; font-size: 0.85em; }
    .chain-item { padding: 2px 0; color: #666; }
    .copyable { cursor: pointer; border-bottom: 1px dashed #888; }
    .copyable:hover { background: rgba(74, 144, 217, 0.2); }
    .timeline-container { background: var(--card-bg); padding: 20px; border-radius: 4px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); display: none; }
    .timeline-container.active { display: block; }
    .timeline { position: relative; height: 60px; background: linear-gradient(90deg, #dc3545 0%, #ffc107 20%, #28a745 40%, #28a745 100%); border-radius: 4px; margin-top: 10px; }
    .timeline-marker { position: absolute; top: -5px; width: 2px; height: 70px; background: var(--text); }
    .timeline-label { position: absolute; top: 65px; transform: translateX(-50%); font-size: 10px; white-space: nowrap; }
    .timeline-dot { position: absolute; width: 12px; height: 12px; border-radius: 50%; top: 24px; transform: translateX(-50%); cursor: pointer; border: 2px solid var(--card-bg); }
    .timeline-dot:hover::after { content: attr(data-domain); position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); background: #333; color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; white-space: nowrap; z-index: 10; }
    .summary-view { display: none; }
    .summary-view.active { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
    .summary-card { background: var(--card-bg); padding: 12px; border-radius: 4px; border-left: 4px solid; display: flex; align-items: center; gap: 10px; }
    .summary-card.ok { border-color: #28a745; }
    .summary-card.warning { border-color: #ffc107; }
    .summary-card.error { border-color: #dc3545; }
    .summary-card.none { border-color: #6c757d; }
    .summary-card img { width: 16px; height: 16px; }
    .summary-card .domain { flex: 1; font-weight: 500; word-break: break-all; }
    .summary-card .days { font-size: 1.2em; font-weight: bold; }
    .detailed-view { display: block; }
    .detailed-view.hidden { display: none; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: #333; color: white; padding: 12px 20px; border-radius: 4px; opacity: 0; transition: opacity 0.3s; z-index: 100; }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <h1>🔒 Certificate Inspector</h1>
  <div class="url"><strong>Inspected URL:</strong> ${url}</div>
  
  <div class="progress-bar">
    ${summary.ok > 0 ? `<div class="progress-segment progress-ok" style="width: ${(summary.ok/summary.total)*100}%">${summary.ok}</div>` : ''}
    ${summary.warning > 0 ? `<div class="progress-segment progress-warning" style="width: ${(summary.warning/summary.total)*100}%">${summary.warning}</div>` : ''}
    ${summary.error > 0 ? `<div class="progress-segment progress-error" style="width: ${(summary.error/summary.total)*100}%">${summary.error}</div>` : ''}
    ${summary.none > 0 ? `<div class="progress-segment progress-none" style="width: ${(summary.none/summary.total)*100}%">${summary.none}</div>` : ''}
  </div>
  
  <div class="controls">
    <div class="view-toggle">
      <button class="active" onclick="setView('detailed', this)">📋 Detailed</button>
      <button onclick="setView('summary', this)">📊 Summary</button>
      <button onclick="setView('timeline', this)">📅 Timeline</button>
    </div>
    <div class="filter-group">
      <label><input type="checkbox" checked onchange="filterStatus('error', this.checked)"> 🔴</label>
      <label><input type="checkbox" checked onchange="filterStatus('warning', this.checked)"> 🟡</label>
      <label><input type="checkbox" checked onchange="filterStatus('ok', this.checked)"> 🟢</label>
      <label><input type="checkbox" checked onchange="filterStatus('none', this.checked)"> ⚪</label>
    </div>
    <input type="text" class="search-box" placeholder="🔍 Search domains..." oninput="searchDomains(this.value)">
    <select onchange="filterIssuer(this.value)"><option value="">All Issuers</option>${issuerOptions}</select>
    <button class="export-btn" onclick="exportData('json')">📥 JSON</button>
    <button class="export-btn" onclick="exportData('csv')">📥 CSV</button>
    <label class="dark-toggle"><input type="checkbox" onchange="toggleDark(this.checked)"> 🌙</label>
  </div>
  
  <div class="summary">
    <div class="summary-item"><strong>Total:</strong> ${summary.total}</div>
    <div class="summary-item">🟢 ${summary.ok}</div>
    <div class="summary-item">🟡 ${summary.warning}</div>
    <div class="summary-item">🔴 ${summary.error}</div>
    <div class="summary-item">⚪ ${summary.none}</div>
  </div>
  
  <div class="timeline-container" id="timeline-view"><h3>📅 Certificate Expiry Timeline</h3><div class="timeline" id="timeline"></div></div>
  <div class="summary-view" id="summary-view">${summaryCards}</div>
  <div class="detailed-view" id="detailed-view">
    <table><thead><tr><th>✓</th><th>Domain</th><th>Days</th><th>DNS</th><th>Certificate</th></tr></thead><tbody>${rows}</tbody></table>
  </div>
  
  <div class="toast" id="toast">Copied!</div>
  <script>
    const timelineData = ${timelineData};
    const exportDataStr = '${exportData}';
    const statusFilters = { error: true, critical: true, warning: true, ok: true, none: true };
    let searchQuery = '', issuerFilter = '';
    
    function toggleDetails(idx) {
      const el = document.getElementById('details-' + idx);
      const btn = el.parentElement.querySelector('.expand-btn');
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
      btn.textContent = el.style.display === 'none' ? 'Details ▼' : 'Details ▲';
    }
    function copyText(text) {
      navigator.clipboard.writeText(text);
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
    function toggleDark(enabled) { document.body.classList.toggle('dark', enabled); }
    function setView(view, btn) {
      document.querySelectorAll('.view-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('detailed-view').classList.toggle('hidden', view !== 'detailed');
      document.getElementById('summary-view').classList.toggle('active', view === 'summary');
      document.getElementById('timeline-view').classList.toggle('active', view === 'timeline');
      if (view === 'timeline') renderTimeline();
    }
    function filterStatus(status, checked) {
      statusFilters[status] = checked;
      if (status === 'error') statusFilters.critical = checked;
      applyFilters();
    }
    function searchDomains(query) { searchQuery = query.toLowerCase(); applyFilters(); }
    function filterIssuer(issuer) { issuerFilter = issuer; applyFilters(); }
    function applyFilters() {
      document.querySelectorAll('tr[data-status], .summary-card[data-status]').forEach(el => {
        const status = el.dataset.status;
        const domain = el.dataset.domain?.toLowerCase() || '';
        const issuer = el.dataset.issuer || '';
        el.style.display = (statusFilters[status] && (!searchQuery || domain.includes(searchQuery)) && (!issuerFilter || issuer === issuerFilter)) ? '' : 'none';
      });
    }
    function exportData(format) { window.location.href = '/export?format=' + format + '&data=' + exportDataStr; }
    function renderTimeline() {
      const container = document.getElementById('timeline');
      container.innerHTML = '';
      if (timelineData.length === 0) return;
      const now = Date.now();
      const maxDate = Math.max(...timelineData.map(d => d.expiry), now + 365*24*60*60*1000);
      const range = maxDate - now;
      const nowMarker = document.createElement('div'); nowMarker.className = 'timeline-marker'; nowMarker.style.left = '0%'; container.appendChild(nowMarker);
      const nowLabel = document.createElement('div'); nowLabel.className = 'timeline-label'; nowLabel.style.left = '0%'; nowLabel.textContent = 'Today'; container.appendChild(nowLabel);
      timelineData.forEach(d => {
        const pos = ((d.expiry - now) / range) * 100;
        if (pos >= 0 && pos <= 100) {
          const dot = document.createElement('div');
          dot.className = 'timeline-dot';
          dot.style.left = pos + '%';
          dot.style.background = d.health === 'error' ? '#dc3545' : d.health === 'warning' ? '#ffc107' : '#28a745';
          dot.dataset.domain = d.domain + ' - ' + new Date(d.expiry).toLocaleDateString();
          container.appendChild(dot);
        }
      });
      const endLabel = document.createElement('div'); endLabel.className = 'timeline-label'; endLabel.style.left = '100%'; endLabel.textContent = new Date(maxDate).toLocaleDateString(); container.appendChild(endLabel);
    }
  </script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Certificate Inspector</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 50px auto; padding: 20px; }
    h1 { color: #333; }
    input[type=text] { width: 100%; padding: 12px; font-size: 16px; border: 2px solid #ddd; border-radius: 4px; box-sizing: border-box; }
    button { padding: 12px 24px; font-size: 16px; background: #4a90d9; color: white; border: none; border-radius: 4px; cursor: pointer; margin-top: 10px; }
    button:hover:not(:disabled) { background: #357abd; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    #progress { margin-top: 20px; display: none; }
    #progress.active { display: block; }
    .progress-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .spinner { width: 20px; height: 20px; border: 3px solid #ddd; border-top-color: #4a90d9; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status { font-weight: 500; color: #333; }
    .log { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 4px; font-family: 'Consolas', 'Monaco', monospace; font-size: 13px; max-height: 300px; overflow-y: auto; }
    .log-entry { margin: 2px 0; }
    .log-entry.phase { color: #569cd6; font-weight: bold; margin-top: 8px; }
    .log-entry.success { color: #4ec9b0; }
    .log-entry.info { color: #9cdcfe; }
    .log-entry.domain { color: #ce9178; }
    .log-entry.warn { color: #dcdcaa; }
    .log-entry.error { color: #f14c4c; }
    .stats { display: flex; gap: 20px; margin-top: 10px; font-size: 14px; color: #666; }
    .stat { background: #f5f5f5; padding: 8px 12px; border-radius: 4px; }
    .stat strong { color: #333; }
  </style>
</head>
<body>
  <h1>🔒 Certificate Inspector</h1>
  <p>Enter a URL to inspect all domains, DNS lookups, and SSL certificates in the request tree.</p>
  <form id="inspectForm">
    <input type="text" id="urlInput" name="url" placeholder="example.com or https://example.com" required>
    <button type="submit" id="submitBtn">Inspect</button>
  </form>
  <div id="progress">
    <div class="progress-header">
      <div class="spinner"></div>
      <span class="status" id="statusText">Starting inspection...</span>
    </div>
    <div class="stats">
      <div class="stat">Domains: <strong id="domainCount">0</strong></div>
      <div class="stat">Checked: <strong id="checkedCount">0</strong></div>
      <div class="stat">Elapsed: <strong id="elapsed">0s</strong></div>
    </div>
    <div class="log" id="log"></div>
  </div>
  <script>
    const form = document.getElementById('inspectForm');
    const btn = document.getElementById('submitBtn');
    const urlInput = document.getElementById('urlInput');
    const progress = document.getElementById('progress');
    const log = document.getElementById('log');
    const statusText = document.getElementById('statusText');
    const domainCount = document.getElementById('domainCount');
    const checkedCount = document.getElementById('checkedCount');
    const elapsedEl = document.getElementById('elapsed');
    
    let startTime;
    let elapsedInterval;
    
    function normalizeUrl(input) {
      let url = input.trim();
      if (!url) return null;
      if (!/^https?:\\/\\//i.test(url)) url = 'https://' + url;
      try { new URL(url); return url; } catch { return null; }
    }
    
    function addLog(msg, type = 'info') {
      const entry = document.createElement('div');
      entry.className = 'log-entry ' + type;
      entry.textContent = msg;
      log.appendChild(entry);
      log.scrollTop = log.scrollHeight;
    }
    
    function updateElapsed() {
      const secs = Math.floor((Date.now() - startTime) / 1000);
      elapsedEl.textContent = secs + 's';
    }
    
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = normalizeUrl(urlInput.value);
      
      if (!url) {
        alert('Please enter a valid URL');
        return;
      }
      
      btn.disabled = true;
      btn.textContent = 'Inspecting...';
      progress.classList.add('active');
      log.innerHTML = '';
      domainCount.textContent = '0';
      checkedCount.textContent = '0';
      startTime = Date.now();
      elapsedInterval = setInterval(updateElapsed, 1000);
      
      addLog('Starting inspection of ' + url, 'phase');
      
      const evtSource = new EventSource('/inspect-stream?url=' + encodeURIComponent(url));
      
      evtSource.onmessage = (e) => {
        const data = JSON.parse(e.data);
        
        if (data.phase) {
          statusText.textContent = data.phase;
          addLog(data.phase, 'phase');
        }
        if (data.log) {
          addLog(data.log, data.type || 'info');
        }
        if (data.domainCount !== undefined) {
          domainCount.textContent = data.domainCount;
        }
        if (data.checked !== undefined) {
          checkedCount.textContent = data.checked;
        }
        if (data.done) {
          evtSource.close();
          clearInterval(elapsedInterval);
          window.location.href = '/inspect?url=' + encodeURIComponent(url);
        }
        if (data.error) {
          evtSource.close();
          clearInterval(elapsedInterval);
          addLog('Error: ' + data.error, 'error');
          statusText.textContent = 'Failed';
          btn.disabled = false;
          btn.textContent = 'Inspect';
        }
      };
      
      evtSource.onerror = () => {
        evtSource.close();
        clearInterval(elapsedInterval);
        addLog('Connection lost', 'error');
        btn.disabled = false;
        btn.textContent = 'Inspect';
      };
    });
  </script>
</body>
</html>`);
});

// Start server with browser check
async function start() {
  const browserReady = await ensureBrowserInstalled();
  if (!browserReady) {
    process.exit(1);
  }
  
  app.listen(PORT, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n🔒 Certificate Inspector running at ${url}`);
    console.log(`   Usage: ${url}/inspect?url=https://example.com\n`);
    
    if (AUTO_OPEN) {
      try {
        const open = (await import('open')).default;
        await open(url);
        console.log('   📂 Opened in your default browser\n');
      } catch (e) {
        // Silent fail - browser open is nice-to-have
      }
    }
  });
}

start();
