const express = require('express');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Enable stealth to trick Spotify into thinking we are a real Chrome browser
puppeteer.use(StealthPlugin());

const app = express();
// IMPORTANT for Render/Docker: Use process.env.PORT
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- SERVE STATIC FRONTEND ---
// The Dockerfile copies the React build to 'public' inside the container
app.use(express.static(path.join(__dirname, 'public')));

// --- UTILS ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getRandomUserAgent = () => {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];
  return agents[Math.floor(Math.random() * agents.length)];
};

// --- API ROUTES ---

app.get('/api/status', (req, res) => {
  res.json({ status: 'online', mode: 'puppeteer-docker', version: '5.3.0' });
});

app.post('/api/create', async (req, res) => {
  const { email, password, birthYear, birthMonth, birthDay, gender, proxy } = req.body;
  const log = [];

  const addLog = (msg, type = 'info') => {
    console.log(`[${type.toUpperCase()}] ${msg}`);
    log.push({ message: msg, type, timestamp: new Date().toLocaleTimeString() });
  };

  let browser = null;

  try {
    addLog(`Initiating Browser for: ${email}`, 'info');

    const launchArgs = [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Critical for Docker memory
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process', 
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled'
    ];

    if (proxy) {
        const parts = proxy.split(':');
        if (parts.length >= 2) {
            launchArgs.push(`--proxy-server=${parts[0]}:${parts[1]}`);
        }
    }

    browser = await puppeteer.launch({
      headless: "new",
      ignoreHTTPSErrors: true,
      // On Render with our Dockerfile, we use the installed Chrome Stable
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: launchArgs
    });

    const page = await browser.newPage();
    
    // Set randomized User Agent and Viewport
    await page.setUserAgent(getRandomUserAgent());
    await page.setViewport({ width: 1920, height: 1080 });

    // Proxy Auth
    if (proxy) {
        const parts = proxy.split(':');
        if (parts.length === 4) {
            await page.authenticate({ username: parts[2], password: parts[3] });
            addLog("Proxy authentication set", "network");
        }
    }

    addLog("Navigating to Spotify Signup...", "network");
    // Using domcontentloaded is faster and less prone to timeout than networkidle2
    // Using /us/signup to force a standard flow if possible
    await page.goto('https://www.spotify.com/us/signup', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Initial wait to let JS execute
    await sleep(3000);

    // 1. Handle Cookie Consent (Aggressive check)
    try {
        const cookieBtnSelector = '#onetrust-accept-btn-handler, button[data-testid="cookie-accept"]';
        const cookieBtn = await page.$(cookieBtnSelector);
        if (cookieBtn) {
            addLog("Accepting Cookies...", "info");
            await cookieBtn.click();
            await sleep(1500);
        }
    } catch (e) {
        // Ignore cookie errors
    }

    addLog("Waiting for form...", "info");
    
    // 2. Email - Enhanced Selector Strategy
    // Spotify changes selectors often: input#email, input[name="email"], input[data-testid="email-input"]
    const emailSelector = 'input#email, input[name="email"], input[data-testid="email-input"]';
    
    try {
        await page.waitForSelector(emailSelector, { timeout: 30000, visible: true });
    } catch (e) {
        // Check if page loaded an error
        const bodyText = await page.evaluate(() => document.body.innerText);
        if (bodyText.includes("Something went wrong") || bodyText.includes("VPN")) {
            throw new Error("Spotify blocked the request (VPN/Proxy detected).");
        }
        throw new Error("Email input not found (Timeout). Page layout changed or IP blocked.");
    }

    await page.type(emailSelector, email, { delay: 120 });
    addLog("Entered Email", "info");
    await sleep(800);

    // 3. Handle 'Next' button if it exists (Multi-step flow)
    const nextBtnSelectors = 'button[data-testid="submit"], button[data-testid="signup-button"]';
    // Check if password field is NOT visible yet
    const passwordSelector = 'input#password, input[name="password"], input[data-testid="password-input"]';
    const passField = await page.$(passwordSelector);
    
    if (!passField || !(await passField.boundingBox())) {
        // If password not visible, assume we need to click next
        const nextBtn = await page.$(nextBtnSelectors);
        if (nextBtn) {
            addLog("Clicking Next (Multi-step)...", "network");
            await nextBtn.click();
            await sleep(2000);
        }
    }

    // 4. Password
    try {
        await page.waitForSelector(passwordSelector, { timeout: 10000, visible: true });
        await page.type(passwordSelector, password, { delay: 120 });
        addLog("Entered Password", "info");
        await sleep(800);
    } catch (e) {
        addLog("Could not find password field - attempting to continue...", "warning");
    }

    // 5. Display Name (Optional/Dynamic)
    const displayNameSelector = 'input#displayName, input[name="displayName"], input[data-testid="display-name-input"]';
    const hasDisplayName = await page.$(displayNameSelector);
    if (hasDisplayName) {
        const name = email.split('@')[0];
        await page.type(displayNameSelector, name, { delay: 100 });
        addLog(`Entered Display Name: ${name}`, "info");
        await sleep(500);
    }

    // 6. Date of Birth
    addLog("Filling Date of Birth...", "info");
    try {
        // Year
        await page.type('input#year, input[name="year"], input[data-testid="birth-date-year-input"]', birthYear, { delay: 100 });
        
        // Month - Handling Select vs Input
        const monthSelect = await page.$('select#month, select[name="month"], select[data-testid="birth-date-month-input"]');
        if (monthSelect) {
            await page.select('select#month, select[name="month"], select[data-testid="birth-date-month-input"]', birthMonth);
        } else {
            // Newer text-based month input
             await page.type('input#month, input[name="month"]', birthMonth, { delay: 100 });
        }
        
        // Day
        await page.type('input#day, input[name="day"], input[data-testid="birth-date-day-input"]', birthDay, { delay: 100 });
    } catch (e) {
        addLog("Error filling DOB, skipping step...", "warning");
    }
    await sleep(500);

    // 7. Gender
    addLog("Selecting Gender...", "info");
    try {
        // Logic: Try to find the radio button based on value or labels
        // Values: male, female, neutral/non-binary
        let gVal = 'male';
        if (gender.toLowerCase().includes('female')) gVal = 'female';
        if (gender.toLowerCase().includes('non')) gVal = 'neutral';
        
        // Try standard radio inputs
        const radio = await page.$(`input[name="gender"][value="${gVal}"], input[type="radio"][value="${gVal}"]`);
        if (radio) {
            await radio.click();
        } else {
            // Try labels (semantic UI)
            // Searching for label containing text
            const labels = await page.$$('label');
            for (const label of labels) {
                const text = await page.evaluate(el => el.textContent.toLowerCase(), label);
                if (text.includes(gender.toLowerCase())) {
                    await label.click();
                    break;
                }
            }
        }
    } catch (e) {
        addLog("Gender selection skipped", "warning");
    }
    await sleep(800);

    // 8. Terms & Checkboxes (Marketing, Share data, etc)
    // Click all checkboxes to be safe (usually required for Terms)
    try {
        const checkboxes = await page.$$('input[type="checkbox"]');
        for (const cb of checkboxes) {
            // Only click if not checked
            const isChecked = await page.evaluate(el => el.checked, cb);
            if (!isChecked) {
                 await cb.click();
                 await sleep(200);
            }
        }
        addLog("Accepted Terms", "info");
    } catch (e) {}

    // 9. Submit
    addLog("Submitting form...", "network");
    const submitBtn = await page.$(nextBtnSelectors);
    if (submitBtn) {
        await submitBtn.click();
    } else {
        addLog("Submit button not found!", "error");
    }

    addLog("Verifying result...", "info");
    // Wait for redirect or error
    try {
        // We wait up to 10s for either a URL change indicating success or an error banner
        await page.waitForNavigation({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => {});
        
        const currentUrl = page.url();
        const bodyText = await page.evaluate(() => document.body.innerText);

        if (currentUrl.includes('download') || currentUrl.includes('overview') || currentUrl.includes('status=success') || currentUrl.includes('/account/')) {
            addLog("Account Successfully Created!", "success");
            res.json({ success: true, logs: log });
        } else if (bodyText.includes("CAPTCHA") || page.frames().some(f => f.url().includes('arkoselabs'))) {
            addLog("FAILED: Captcha Challenge Triggered (Proxy/IP flagged).", "error");
            res.json({ success: false, logs: log, error: "Captcha Challenge" });
        } else {
            // Check for specific error banner text
            const errorText = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="banner-error"], [aria-label="Error"]');
                return el ? el.innerText : null;
            });
            
            if (errorText) {
                addLog(`Validation Error: ${errorText}`, "error");
                res.json({ success: false, logs: log, error: errorText });
            } else {
                addLog("Unknown Result (Check screenshot if possible)", "warning");
                // Assume failed if URL didn't change significantly
                res.json({ success: false, logs: log, error: "Unknown error, possibly silent block." });
            }
        }
    } catch (e) {
        addLog(`Error during verification: ${e.message}`, "error");
        res.json({ success: false, logs: log, error: e.message });
    }

  } catch (error) {
    addLog(`Critical Error: ${error.message}`, "error");
    res.status(500).json({ success: false, logs: log, error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});
