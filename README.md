# 🔒 Certificate Inspector

A web-based tool that inspects **all SSL certificates and DNS records** for every domain loaded by a webpage. Uses headless Playwright to capture the full request tree—including JavaScript-loaded resources, ads, trackers, and APIs.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

### 🔍 Deep Inspection
- **Full request tree capture** - Uses headless Chromium to load pages and capture ALL network requests
- **DNS lookups** - IPv4/IPv6 addresses and CNAME records for each domain
- **SSL certificate details** - Subject, issuer, validity dates, serial number, fingerprint
- **Certificate chain** - View the full chain of trust
- **TLS version** - See if domains use TLS 1.2 or 1.3
- **HSTS status** - Check if Strict-Transport-Security is enabled
- **Response times** - Measure connection latency to each domain

### 📊 Health Dashboard
- **Color-coded status** - 🟢 Healthy | 🟡 Expiring soon (≤30 days) | 🔴 Expired/Invalid | ⚪ No HTTPS
- **Progress bar** - Visual breakdown of certificate health
- **Sorted by urgency** - Problems appear first
- **Days until expiry** - Large, scannable numbers

### 🎨 Multiple Views
- **📋 Detailed** - Full table with expandable certificate details
- **📊 Summary** - Compact card grid for quick scanning
- **📅 Timeline** - Visual timeline of certificate expirations

### 🛠️ Tools & Filters
- **Search** - Filter domains by name
- **Filter by status** - Show/hide by health status
- **Filter by issuer** - Group certificates by CA (Let's Encrypt, DigiCert, etc.)
- **Dark mode** - Easy on the eyes 🌙
- **Click to copy** - Domain, fingerprint, serial number
- **Export** - Download results as JSON or CSV

## Installation

```bash
# Clone the repo
git clone https://github.com/shanselman/cert-inspector.git
cd cert-inspector

# Install dependencies
npm install

# Install Playwright browser
npx playwright install chromium

# Start the server
npm start
```

## Usage

1. Open http://localhost:3000 in your browser
2. Enter a URL to inspect (e.g., `https://github.com`)
3. Wait for the page to load and all certificates to be fetched
4. Explore the results!

### API Usage

```bash
# Get results as JSON
curl -H "Accept: application/json" "http://localhost:3000/inspect?url=https://example.com"

# Get results as HTML (default)
curl "http://localhost:3000/inspect?url=https://example.com"
```

## Use Cases

- **Security audits** - Check certificate health across your web properties
- **Third-party risk** - See what external domains your site depends on
- **Compliance** - Verify TLS versions and HSTS deployment
- **Debugging** - Understand the full network footprint of a page
- **Certificate monitoring** - Catch expiring certificates before they cause outages

## Screenshots

### Detailed View
Full certificate information with expandable details showing cert chain, TLS version, and HSTS status.

### Summary View
Compact cards for quick health assessment across many domains.

### Timeline View
Visual representation of when certificates expire, helping prioritize renewals.

## Tech Stack

- **Node.js** + **Express** - Web server
- **Playwright** - Headless browser for capturing all network requests
- **Native TLS** - Direct certificate inspection via Node's `tls` module

## License

MIT

## Contributing

PRs welcome! Please open an issue first to discuss what you'd like to change.
