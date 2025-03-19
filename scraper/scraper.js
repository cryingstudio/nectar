// scraper/scraper.js
const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs").promises;
const path = require("path");

// Ensure logs directory exists
const LOGS_DIR = path.join(process.cwd(), "logs");
fs.mkdir(LOGS_DIR, { recursive: true }).catch(console.error);

// Create log file with timestamp
const LOG_FILE = path.join(
  LOGS_DIR,
  `scrape-${new Date().toISOString().replace(/:/g, "-")}.log`
);

// Setup logging to both console and file
const log = async (message, level = "INFO") => {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] [${level}] ${message}`;

  console.log(formattedMessage);

  // Also write to log file
  await fs.appendFile(LOG_FILE, formattedMessage + "\n").catch(console.error);
};

// Error logger
const logError = (message, error) => {
  log(`${message}: ${error.message}`, "ERROR");
  if (error.stack) {
    log(error.stack, "ERROR");
  }
};

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  log(
    "Missing Supabase credentials. Please set SUPABASE_URL and SUPABASE_ANON_KEY environment variables.",
    "ERROR"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// List of domains to scrape
const domains = [
  "amazon.com",
  "walmart.com",
  "target.com",
  "bestbuy.com",
  // Add more domains as needed
].slice(
  0,
  process.env.DOMAIN_LIMIT ? parseInt(process.env.DOMAIN_LIMIT) : undefined
);

async function scrapeCoupons(domain) {
  await log(`Scraping coupons for ${domain}...`);

  const browser = await puppeteer.launch({
    headless: "new", // Using "new" headless mode which is less detectable
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--window-size=1920,1080", // Set a realistic window size
      "--disable-blink-features=AutomationControlled", // Helps avoid detection
    ],
    defaultViewport: null, // Full page view
  });

  try {
    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
    );

    // Enable JavaScript
    await page.setJavaScriptEnabled(true);

    // Set extra headers to appear more like a real browser
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    });

    // Override the navigator.webdriver property to avoid detection
    await page.evaluateOnNewDocument(() => {
      // Pass basic bot detection
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
      // Override Chrome/Puppeteer specific properties
      window.navigator.chrome = { runtime: {} };
      window.navigator.permissions = {
        query: () => Promise.resolve({ state: "granted" }),
      };
    });

    // Set default navigation timeout
    page.setDefaultNavigationTimeout(120000); // 2 minutes

    // Add browser console logs to our logs
    page.on("console", (msg) =>
      log(`Browser console [${domain}]: ${msg.text()}`, "BROWSER")
    );

    await log(`Navigating to couponfollow.com for ${domain}...`);
    await page.goto(`https://couponfollow.com/site/${domain}`, {
      waitUntil: "networkidle2",
      timeout: 120000, // 2 minutes
    });

    await log(`Page loaded for ${domain}, extracting coupon data...`);

    // Extract basic coupon data with modal URLs
    const { basicCoupons, modalUrls } = await page.evaluate(() => {
      const basicCoupons = [];
      const modalUrls = [];
      let idCounter = 1;

      const couponElements = document.querySelectorAll(
        ".offer-card.regular-offer"
      );

      console.log(`Found ${couponElements.length} offer cards`);

      couponElements.forEach((element) => {
        // Skip if not a coupon
        const dataType = element.getAttribute("data-type");
        if (dataType !== "coupon") {
          console.log(
            `Skipping non-coupon element with data-type: ${dataType}`
          );
          return;
        }

        const discountEl = element.querySelector(".offer-title");
        const termsEl = element.querySelector(".offer-description");

        const discount = discountEl?.textContent?.trim() || "Discount";
        const terms = termsEl?.textContent?.trim() || "Terms apply";
        const verified = element.getAttribute("data-is-verified") === "True";

        // Extract direct code if available in the element
        let code = "AUTOMATIC";

        // Try to get code from clipboard data or other attributes
        const showCodeBtn = element.querySelector(".show-code");
        if (showCodeBtn) {
          const dataCode =
            showCodeBtn.getAttribute("data-code") ||
            showCodeBtn.getAttribute("data-clipboard-text");
          if (dataCode) {
            code = dataCode;
          }
        }

        // Get the direct modal URL (not the hash URL)
        const modalUrl = element.getAttribute("data-modal");

        // Store element ID for debugging
        const elementId = element.getAttribute("id") || `coupon-${idCounter}`;

        basicCoupons.push({
          id: idCounter++,
          code,
          discount,
          terms,
          verified,
          source: "CouponFollow",
          elementId, // Store element ID for reference
        });

        modalUrls.push(modalUrl);
      });

      return { basicCoupons, modalUrls };
    });

    await log(
      `Found ${basicCoupons.length} basic coupons for ${domain}, processing modal URLs...`
    );

    // Process coupons with modal URLs to get the actual codes
    const completeCoupons = [...basicCoupons];

    try {
      // Process all coupons but in batches of 5
      const batchSize = 1;
      const totalCoupons = modalUrls.length;
      const totalBatches = Math.ceil(totalCoupons / batchSize);

      await log(
        `Processing ${totalCoupons} coupons in ${totalBatches} batches of ${batchSize}`
      );

      // Pre-create a pool of pages to reuse for each batch
      const pagePool = [];
      for (let i = 0; i < batchSize; i++) {
        const modalPage = await browser.newPage();
        await modalPage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
        );
        await modalPage.setJavaScriptEnabled(true);

        // Additional anti-detection measures for modal page
        await modalPage.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, "webdriver", {
            get: () => false,
          });
          window.navigator.chrome = { runtime: {} };
          window.navigator.permissions = {
            query: () => Promise.resolve({ state: "granted" }),
          };
        });

        pagePool.push(modalPage);
      }

      // Process in batches
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIndex = batchIndex * batchSize;
        const endIndex = Math.min(startIndex + batchSize, totalCoupons);
        const currentBatchSize = endIndex - startIndex;

        await log(
          `Processing batch ${batchIndex + 1}/${totalBatches} (coupons ${
            startIndex + 1
          }-${endIndex})`
        );

        // Process this batch in parallel
        const batchPromises = [];

        for (let i = 0; i < currentBatchSize; i++) {
          const couponIndex = startIndex + i;
          const modalUrl = modalUrls[couponIndex];
          const coupon = basicCoupons[couponIndex];

          // Skip if coupon already has a code or no modal URL
          if (coupon.code !== "AUTOMATIC" || !modalUrl) {
            await log(
              `Skipping coupon ${
                couponIndex + 1
              } - already has code or no modal URL`
            );
            continue;
          }

          // Use the appropriate page from the pool
          const modalPage = pagePool[i];

          batchPromises.push(
            (async () => {
              try {
                await log(
                  `Processing modal ${
                    couponIndex + 1
                  }/${totalCoupons}: ${modalUrl} (Element ID: ${
                    coupon.elementId || "unknown"
                  })`
                );

                // Navigate directly to the modal URL (not the hash URL)
                await modalPage.goto(modalUrl, {
                  waitUntil: ["load", "networkidle2", "domcontentloaded"],
                  timeout: 30000,
                });

                // Wait for potential code input fields to load
                try {
                  await modalPage.waitForSelector(
                    "input#code.input.code, input.input.code",
                    {
                      timeout: 5000,
                    }
                  );
                } catch (err) {
                  await log(
                    `No code input found for modal ${couponIndex + 1}`,
                    "WARN"
                  );
                }

                // Extract the code from the modal using multiple approaches
                const code = await modalPage.evaluate(() => {
                  // Try various selectors to find the code
                  const selectors = [
                    "input#code.input.code",
                    "input.input.code",
                    ".coupon-code",
                    ".code-text",
                    "[data-clipboard-text]",
                    "[data-code]",
                  ];

                  // Try the selectors in order
                  for (const selector of selectors) {
                    const element = document.querySelector(selector);
                    if (!element) continue;

                    // Handle different element types
                    if (element.tagName === "INPUT") {
                      const value = element.value.trim();
                      if (value) return value;
                    } else {
                      // For non-input elements, try data attributes first
                      const clipboardText = element.getAttribute(
                        "data-clipboard-text"
                      );
                      if (clipboardText) return clipboardText.trim();

                      const dataCode = element.getAttribute("data-code");
                      if (dataCode) return dataCode.trim();

                      // Last resort: use text content
                      const textContent = element.textContent.trim();
                      if (textContent) return textContent;
                    }
                  }

                  // Log the HTML content for debugging
                  console.log("Modal HTML:", document.body.innerHTML);

                  return "AUTOMATIC"; // Default if no code found
                });

                // Update the coupon with the extracted code
                if (code && code !== "AUTOMATIC") {
                  completeCoupons[couponIndex].code = code;
                  await log(
                    `Found code ${code} for coupon ${couponIndex + 1} (ID: ${
                      coupon.elementId || "unknown"
                    })`
                  );
                } else {
                  await log(
                    `No code found for coupon ${couponIndex + 1} (ID: ${
                      coupon.elementId || "unknown"
                    })`,
                    "WARN"
                  );
                }
              } catch (error) {
                logError(
                  `Error processing modal for coupon ${couponIndex + 1}`,
                  error
                );
              }
            })()
          );
        }

        // Wait for all modals in this batch to complete
        await Promise.all(batchPromises);
      }

      // Close all pages in the pool
      for (const modalPage of pagePool) {
        await modalPage
          .close()
          .catch((err) => logError("Error closing modal page", err));
      }
    } catch (error) {
      logError(`Error in batch processing of modals`, error);
    }

    await log(
      `Completed processing ${completeCoupons.length} coupons for ${domain}`
    );

    return completeCoupons;
  } catch (error) {
    logError(`Error scraping ${domain}`, error);
    return [];
  } finally {
    await browser.close();
  }
}

async function saveToDatabase(domain, coupons) {
  // Prepare data for database
  const uniqueMap = new Map();

  coupons.forEach((coupon) => {
    const key = `${domain}:${coupon.code}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, {
        domain,
        code: coupon.code,
        discount: coupon.discount,
        terms: coupon.terms,
        verified: coupon.verified,
      });
    }
  });

  const uniqueCoupons = Array.from(uniqueMap.values());

  if (uniqueCoupons.length === 0) {
    await log(`No coupons to save for ${domain}`, "WARN");
    return;
  }

  // Save to Supabase
  try {
    await log(
      `Saving ${uniqueCoupons.length} coupons for ${domain} to database...`
    );

    const { data, error } = await supabase
      .from("coupons")
      .upsert(uniqueCoupons, {
        onConflict: ["domain", "code"],
        ignoreDuplicates: true,
      });

    if (error) {
      logError(`Error saving coupons for ${domain} to database`, error);
    } else {
      await log(
        `Successfully saved ${uniqueCoupons.length} coupons for ${domain} to database`
      );
    }
  } catch (error) {
    logError(`Exception saving coupons for ${domain} to database`, error);
  }
}

async function main() {
  await log("Starting coupon scraper...");

  let successCount = 0;
  let errorCount = 0;

  for (const domain of domains) {
    try {
      await log(`----------------------------------------`);
      await log(`Starting processing for domain: ${domain}`);

      const coupons = await scrapeCoupons(domain);

      if (coupons.length > 0) {
        await saveToDatabase(domain, coupons);
        successCount++;
      } else {
        await log(`No coupons found for ${domain}`, "WARN");
        errorCount++;
      }
    } catch (error) {
      logError(`Failed to process domain: ${domain}`, error);
      errorCount++;
    }

    // Add a delay between domains to avoid rate limiting
    await log(`Completed processing for domain: ${domain}`);
  }

  await log(`----------------------------------------`);
  await log(`Coupon scraping completed!`);
  await log(`Successfully processed: ${successCount} domains`);
  await log(`Failed to process: ${errorCount} domains`);

  // Exit with error code if all domains failed
  if (errorCount === domains.length) {
    await log("All domains failed to process", "ERROR");
    process.exit(1);
  }
}

// Export functions for testing
module.exports = {
  scrapeCoupons,
  saveToDatabase,
  main,
};

// Only run main if this script is called directly
if (require.main === module) {
  main().catch((error) => {
    logError("Fatal error in main", error);
    process.exit(1);
  });
}
