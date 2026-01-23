# 🔒 Certificate Inspector

A web-based tool that inspects **all SSL certificates and DNS records** for every domain loaded by a webpage. Uses headless Playwright to capture the full request tree—including JavaScript-loaded resources, ads, trackers, and APIs.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## 🚀 Quick Start

**Want to try it right now?** Download the standalone executable from [Releases](https://github.com/shanselman/cert-inspector/releases) - no installation required, just download and run.

> **For non-developers:** This is the easiest way to use Certificate Inspector. Download the executable for your platform, run it, and the app opens automatically at http://localhost:3000

---

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

## Installation Options

| Option | Best For | Install Required? |
|--------|----------|-------------------|
| 📦 **Executable** | Offline/local use | ❌ Auto-installs browser |
| 🐳 **Docker** | Teams, servers | Docker Desktop |
| ☁️ **Codespaces** | Browser-based usage | ❌ None |
| 💻 **Local Dev** | Contributors | Node.js |

---

### 📦 Option 1: Standalone Executable

Run locally without Node.js installed. The app automatically downloads the browser on first run.

**Download from [Releases](https://github.com/shanselman/cert-inspector/releases):**

| Platform | File |
|----------|------|
| Windows | `cert-inspector-win.exe` |
| macOS | `cert-inspector-macos` |
| Linux | `cert-inspector-linux` |

Then just run it:

**Windows:**
```
cert-inspector-win.exe
```

**macOS/Linux:**
```bash
chmod +x cert-inspector-macos  # or cert-inspector-linux
./cert-inspector-macos
```

> ⚠️ **macOS Users:** See [Troubleshooting](#troubleshooting) if you get a security warning about an unverified developer.

On first run you'll see:
```
⚠️  Playwright browser not found
📦 Installing Chromium browser (this only happens once)...
✅ Browser installed successfully

🔒 Certificate Inspector running at http://localhost:3000
```

#### Building the Executable Yourself

```bash
npm install
npm run build:win    # Windows .exe
npm run build:mac    # macOS binary
npm run build:linux  # Linux binary
npm run build:all    # All platforms → dist/
```

---

### 🐳 Option 2: Docker

Great for running locally or on a server. Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
# Build and run
docker build -t cert-inspector .
docker run -p 3000:3000 cert-inspector
```

Then open http://localhost:3000

---

### 📦 Option 3: GitHub Codespaces

Runs entirely in your browser with nothing to install.

1. Click the green **"Code"** button on GitHub
2. Select **"Codespaces"** tab → **"Create codespace on main"**
3. Wait ~2 minutes for the environment to build
4. The app starts automatically and opens in your browser

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/shanselman/cert-inspector?quickstart=1)

> 💡 **Tip:** GitHub gives you 60 hours/month of free Codespaces usage

---

### 💻 Option 4: Local Development

For contributors or if you want to modify the code.

```bash
git clone https://github.com/shanselman/cert-inspector.git
cd cert-inspector
npm install
npm start
```

The Playwright browser installs automatically on first run.

## Usage

1. Open http://localhost:3000 in your browser
2. Enter a URL to inspect (e.g., `https://github.com`)
3. Wait for the page to load and all certificates to be fetched
4. Explore the results

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

## Troubleshooting

### macOS: "Apple could not verify cert-inspector-macos is free of malware"

When launching the macOS executable, you may see this security warning:

> **"cert-inspector-macos" cannot be opened because Apple cannot verify that it is free of malware.**

**Why does this happen?**

macOS Gatekeeper blocks applications that aren't signed with an Apple Developer certificate. The cert-inspector executables are not code-signed because:
- Code signing requires an annual Apple Developer Program membership ($99/year)
- This is an open-source project built via GitHub Actions
- The unsigned binary is safe - you can verify the source code and build process

**How to fix it:**

**Method 1: Remove quarantine attribute (Recommended)**

Open Terminal and run:
```bash
xattr -d com.apple.quarantine cert-inspector-macos
chmod +x cert-inspector-macos
./cert-inspector-macos
```

This removes the quarantine flag that macOS applies to downloaded files.

**Method 2: Allow in System Settings**

1. Try to open the app (double-click or run `./cert-inspector-macos`)
2. When the warning appears, click **"Done"** or **"Cancel"**
3. Open **System Settings** → **Privacy & Security**
4. Scroll down to the **Security** section
5. Click **"Open Anyway"** next to the cert-inspector message
6. Confirm by clicking **"Open"** in the new dialog

**Method 3: Disable Gatekeeper temporarily (Not recommended)**

```bash
sudo spctl --master-disable
# Run the app
sudo spctl --master-enable  # Re-enable after
```

⚠️ This disables Gatekeeper system-wide and reduces security. Only use if Methods 1 and 2 don't work.

**Build it yourself:**

If you prefer, build the executable yourself from source:
```bash
git clone https://github.com/shanselman/cert-inspector.git
cd cert-inspector
npm install
npm run build:mac
chmod +x dist/cert-inspector-macos
./dist/cert-inspector-macos
```

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
