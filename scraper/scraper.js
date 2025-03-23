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

// Configuration for scraping performance
const CONFIG = {
  concurrentDomains: process.env.CONCURRENT_DOMAINS
    ? parseInt(process.env.CONCURRENT_DOMAINS)
    : 5,
  batchSize: process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE) : 5,
  domainRetries: process.env.DOMAIN_RETRIES
    ? parseInt(process.env.DOMAIN_RETRIES)
    : 2,
  modalTimeout: process.env.MODAL_TIMEOUT
    ? parseInt(process.env.MODAL_TIMEOUT)
    : 15000,
  navigationTimeout: process.env.NAVIGATION_TIMEOUT
    ? parseInt(process.env.NAVIGATION_TIMEOUT)
    : 30000,
  delayBetweenDomains: process.env.DELAY_BETWEEN_DOMAINS
    ? parseInt(process.env.DELAY_BETWEEN_DOMAINS)
    : 1000,
};

/**
 * Scrapes domain names from CouponFollow's category page
 * @param {string} letter - The letter category (a-z or #) to scrape
 * @returns {Promise<string[]>} - Array of domain names
 */
async function scrapeDomains(letter) {
  await log(`Scraping domain list for letter: ${letter}...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--window-size=1920,1080",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: null,
  });

  try {
    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
    );

    // Set page options similar to coupon scraper
    await page.setJavaScriptEnabled(true);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    });

    // Override webdriver properties to avoid detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
      window.navigator.chrome = { runtime: {} };
      window.navigator.permissions = {
        query: () => Promise.resolve({ state: "granted" }),
      };
    });

    page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

    // Navigate to the letter's category page
    const url = `https://couponfollow.com/site/browse/${letter}/all`;
    await log(`Navigating to ${url}...`);

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: CONFIG.navigationTimeout,
    });

    await log(`Page loaded for letter ${letter}, extracting domains...`);

    // Extract domain names from the page
    const domains = await page.evaluate(() => {
      const domainList = [];

      // Each store is in a list item with a link
      const storeLinks = document.querySelectorAll('ul li a[href^="/site/"]');

      storeLinks.forEach((link) => {
        const href = link.getAttribute("href");
        if (href) {
          // Extract domain from the URL format "/site/domain.com"
          const domain = href.replace("/site/", "");
          if (domain) {
            domainList.push(domain);
          }
        }
      });

      return domainList;
    });

    await log(`Found ${domains.length} domains for letter ${letter}`);
    return domains;
  } catch (error) {
    logError(`Error scraping domains for letter ${letter}`, error);
    return [];
  } finally {
    await browser.close();
  }
}

async function scrapeCoupons(domain, retryCount = 0) {
  await log(`Scraping coupons for ${domain}...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--window-size=1920,1080",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: 1280, height: 800 }, // Smaller viewport for speed
  });

  try {
    // Create a single browser context for better resource management
    const context = await browser.createBrowserContext();

    const page = await context.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
    );
    await page.setJavaScriptEnabled(true);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    });

    // Anti-detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      window.navigator.chrome = { runtime: {} };
      window.navigator.permissions = {
        query: () => Promise.resolve({ state: "granted" }),
      };
    });

    // Improve performance by blocking unnecessary resources
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      if (
        resourceType === "image" ||
        resourceType === "font" ||
        resourceType === "media"
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Set shorter timeout
    page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

    // Optimize page loading strategy
    await log(`Navigating to couponfollow.com for ${domain}...`);
    await page.goto(`https://couponfollow.com/site/${domain}`, {
      waitUntil: "networkidle2",
      timeout: CONFIG.navigationTimeout,
    });

    await new Promise((r) => setTimeout(r, 500));

    // Immediately extract coupon data before all resources finish loading
    const { basicCoupons, modalUrls, directCodes, couponToModalMap } =
      await page.evaluate(() => {
        const basicCoupons = [];
        const modalUrls = [];
        const directCodes = new Map(); // Store any directly available codes
        const couponToModalMap = new Map(); // Map coupon IDs to modal URLs
        let idCounter = 1;

        // Use faster selectors
        const couponElements = document.querySelectorAll(
          '.offer-card.regular-offer[data-type="coupon"]'
        );
        console.log(`Found ${couponElements.length} offer cards`);

        couponElements.forEach((element) => {
          const discount =
            element.querySelector(".offer-title")?.textContent?.trim() ||
            "Discount";
          const terms =
            element.querySelector(".offer-description")?.textContent?.trim() ||
            "Terms apply";
          const verified = element.getAttribute("data-is-verified") === "True";

          // Try to get code without opening modal
          let code = "AUTOMATIC";
          let hasDirectCode = false;

          // Check if code is directly available via data attributes
          const showCodeBtn = element.querySelector(".show-code");
          if (showCodeBtn) {
            const dataCode =
              showCodeBtn.getAttribute("data-code") ||
              showCodeBtn.getAttribute("data-clipboard-text");
            if (dataCode) {
              code = dataCode;
              hasDirectCode = true;
            }
          }

          // Get modal URL only if we don't have direct code
          const modalUrl = element.getAttribute("data-modal");
          const elementId = element.getAttribute("id") || `coupon-${idCounter}`;

          const couponId = idCounter++;
          basicCoupons.push({
            id: couponId,
            code,
            discount,
            terms,
            verified,
            source: "CouponFollow",
            elementId,
            modalUrl: modalUrl || null, // Store the modal URL with the coupon
          });

          // Only store modal URLs for coupons without direct codes
          if (!hasDirectCode && modalUrl) {
            modalUrls.push(modalUrl);
            directCodes.set(couponId, false);
            couponToModalMap.set(modalUrl, couponId); // Map modal URL to coupon ID
          } else {
            directCodes.set(couponId, true);
          }
        });

        return {
          basicCoupons,
          modalUrls,
          directCodes: Array.from(directCodes.entries()),
          couponToModalMap: Array.from(couponToModalMap.entries()),
        };
      });

    await log(
      `Found ${basicCoupons.length} basic coupons for ${domain}, need to process ${modalUrls.length} modals`
    );

    // Convert maps back from arrays
    const directCodesMap = new Map(directCodes);
    const modalToCouponMap = new Map(couponToModalMap);

    // Create a copy of coupons to update
    const completeCoupons = [...basicCoupons];

    // Only process coupons that don't have direct codes
    const modalUrlsToProcess = modalUrls.filter((url) => url);

    if (modalUrlsToProcess.length > 0) {
      try {
        // Increase batch size for better throughput
        const batchSize = Math.min(modalUrlsToProcess.length);
        const totalModals = modalUrlsToProcess.length;
        const totalBatches = Math.ceil(totalModals / batchSize);

        await log(
          `Processing ${totalModals} modals in ${totalBatches} batches of up to ${batchSize}`
        );

        // Pre-create a pool of pages for reuse
        const pagePool = [];
        for (let i = 0; i < batchSize; i++) {
          const modalPage = await context.newPage();

          // Apply the same performance optimizations
          await modalPage.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
          );
          await modalPage.setJavaScriptEnabled(true);
          await modalPage.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, "webdriver", { get: () => false });
          });

          // Block unnecessary resources
          await modalPage.setRequestInterception(true);
          modalPage.on("request", (req) => {
            const resourceType = req.resourceType();
            if (
              resourceType === "image" ||
              resourceType === "font" ||
              resourceType === "media" ||
              resourceType === "stylesheet"
            ) {
              req.abort();
            } else {
              req.continue();
            }
          });

          pagePool.push(modalPage);
        }

        // Process in parallel batches
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const startIndex = batchIndex * batchSize;
          const endIndex = Math.min(startIndex + batchSize, totalModals);
          const currentBatchSize = endIndex - startIndex;

          await log(
            `Processing batch ${batchIndex + 1}/${totalBatches} (modals ${
              startIndex + 1
            }-${endIndex})`
          );

          // Process this batch in parallel
          const batchPromises = [];

          for (let i = 0; i < currentBatchSize; i++) {
            const modalIndex = startIndex + i;
            const modalUrl = modalUrlsToProcess[modalIndex];

            // Find the original coupon index
            const couponId = modalToCouponMap.get(modalUrl);

            if (!couponId) {
              console.error(`No coupon ID found for modal URL: ${modalUrl}`);
              continue;
            }

            const couponIndex = basicCoupons.findIndex(
              (coupon) => coupon.id === couponId
            );
            if (couponIndex === -1) {
              console.error(`No coupon found for ID: ${couponId}`);
              continue;
            }

            // Use a page from the pool
            const modalPage = pagePool[i % pagePool.length];

            batchPromises.push(
              (async () => {
                try {
                  // Faster timeout for modals
                  const shorterTimeout = Math.min(CONFIG.modalTimeout, 8000);

                  // Use a faster navigation strategy
                  await modalPage.goto(modalUrl, {
                    waitUntil: "networkidle2",
                    timeout: shorterTimeout,
                  });

                  // Define selectors to look for
                  const possibleSelectors = ["input#code.input.code"];

                  // Wait for at least one of the selectors to be present
                  try {
                    await modalPage.waitForFunction(
                      (selectors) => {
                        return selectors.some((selector) =>
                          document.querySelector(selector)
                        );
                      },
                      { timeout: 8000 },
                      possibleSelectors
                    );

                    // Additional delay to ensure content is fully loaded
                    await new Promise((r) => setTimeout(r, 500));

                    // Try to extract the code after waiting
                    const code = await modalPage.evaluate((selectors) => {
                      // Try all selectors at once
                      for (const selector of selectors) {
                        const element = document.querySelector(selector);
                        if (!element) continue;

                        // Extract code based on element type
                        if (element.tagName === "INPUT") {
                          const value = element.value.trim();
                          if (value && value !== "AUTOMATIC") return value;
                        } else {
                          const clipboardText = element.getAttribute(
                            "data-clipboard-text"
                          );
                          const dataCode = element.getAttribute("data-code");
                          const textContent = element.textContent.trim();

                          if (clipboardText && clipboardText !== "AUTOMATIC")
                            return clipboardText;
                          if (dataCode && dataCode !== "AUTOMATIC")
                            return dataCode;
                          if (textContent && textContent !== "AUTOMATIC")
                            return textContent;
                        }
                      }

                      return "AUTOMATIC"; // Default if not found
                    }, possibleSelectors);

                    // Update the coupon with the extracted code
                    if (code && code !== "AUTOMATIC") {
                      completeCoupons[couponIndex].code = code;
                      await log(
                        `Successfully extracted code "${code}" from modal ${
                          modalIndex + 1
                        } for coupon ${couponId}`
                      );
                    } else {
                      await log(
                        `Failed to extract code from modal ${
                          modalIndex + 1
                        } for coupon ${couponId}, defaulting to "AUTOMATIC"`
                      );
                    }
                  } catch (waitError) {
                    await log(
                      `Selector timeout for ${modalUrl}: ${waitError.message}`,
                      "WARN"
                    );
                  }
                } catch (error) {
                  await log(
                    `Error with modal ${modalIndex} (${modalUrl}): ${error.message}`,
                    "ERROR"
                  );
                }
              })()
            );
          }

          // Wait for all modals in this batch to complete
          await Promise.allSettled(batchPromises);

          // Add a small delay between batches to avoid overwhelming the server
          if (batchIndex < totalBatches - 1) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }

        // Close all pages in the pool
        for (const modalPage of pagePool) {
          await modalPage.close().catch(() => {});
        }
      } catch (error) {
        logError(`Error in batch processing of modals`, error);
      }
    }

    await log(
      `Completed processing ${completeCoupons.length} coupons for ${domain}`
    );
    return completeCoupons;
  } catch (error) {
    logError(`Error scraping ${domain}`, error);
    if (retryCount < CONFIG.domainRetries) {
      await log(
        `Retrying ${domain} (attempt ${retryCount + 1}/${
          CONFIG.domainRetries
        })...`,
        "WARN"
      );
      await new Promise((r) => setTimeout(r, 2000));
      return scrapeCoupons(domain, retryCount + 1);
    }
    return [];
  } finally {
    await browser.close();
  }
}

async function saveToDatabase(domain, coupons) {
  // Prepare data for database
  const uniqueMap = new Map();

  // First, sort coupons by verified status (true first)
  const sortedCoupons = [...coupons].sort((a, b) => {
    if (a.verified !== b.verified) {
      return b.verified ? 1 : -1; // Verified coupons first
    }
    return 0;
  });

  // Process coupons, keeping only the first occurrence of each unique code
  sortedCoupons.forEach((coupon) => {
    // Only save coupons that have actual codes
    if (coupon.code === "AUTOMATIC") return;

    // Use just domain and code as the unique key
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
    await log(`No valid coupons to save for ${domain}`, "WARN");
    return;
  }

  // Log the coupons being saved
  await log(
    `Preparing to save the following coupons for ${domain}:\n${uniqueCoupons
      .map(
        (c) =>
          `  - ${c.code} (${c.verified ? "verified" : "unverified"}): ${
            c.discount
          }`
      )
      .join("\n")}`
  );

  // Save to Supabase in a single batch
  try {
    await log(
      `Saving ${uniqueCoupons.length} coupons for ${domain} to database...`
    );

    const { error } = await supabase.from("coupons").upsert(uniqueCoupons, {
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

  const letters = process.env.LETTERS
    ? process.env.LETTERS.split(",")
    : process.argv.length > 2
    ? process.argv[2].split(",")
    : [];

  let totalSuccessCount = 0;
  let totalErrorCount = 0;

  // First, scrape all domains for all letters
  await log("Starting to scrape all domains for all letters...");
  const domainsByLetter = new Map();

  // Scrape domains for each letter
  for (const letter of letters) {
    await log(`Scraping domains for letter: ${letter}`);
    const domains = await scrapeDomains(letter);

    if (domains.length === 0) {
      await log(`No domains found for letter ${letter}, skipping...`, "WARN");
      continue;
    }

    domainsByLetter.set(letter, domains);
    await log(`Found ${domains.length} domains for letter ${letter}`);

    // Add delay between letters for domain scraping
    if (letters.indexOf(letter) < letters.length - 1) {
      const delayBetweenLetters = CONFIG.delayBetweenDomains;
      await log(`Waiting ${delayBetweenLetters}ms before next letter...`);
      await new Promise((resolve) => setTimeout(resolve, delayBetweenLetters));
    }
  }

  // Now process each letter's domains for coupons
  for (const letter of letters) {
    await log(`-------------------------------------------`);
    await log(`Starting to process coupons for letter: ${letter}`);

    const domains = domainsByLetter.get(letter) || [];
    if (domains.length === 0) continue;

    await log(`Processing ${domains.length} domains for letter ${letter}...`);

    let letterSuccessCount = 0;
    let letterErrorCount = 0;

    // Process domains in batches for concurrency
    for (let i = 0; i < domains.length; i += CONFIG.concurrentDomains) {
      const batch = domains.slice(i, i + CONFIG.concurrentDomains);
      await log(
        `Processing batch of ${batch.length} domains (${i + 1}-${Math.min(
          i + CONFIG.concurrentDomains,
          domains.length
        )} of ${domains.length})...`
      );

      const results = await Promise.all(
        batch.map(async (domain) => {
          try {
            await log(`Starting processing for domain: ${domain}`);

            const coupons = await scrapeCoupons(domain);

            if (coupons.length > 0) {
              await saveToDatabase(domain, coupons);
              await log(`Completed processing for domain: ${domain}`);
              return { success: true, domain };
            } else {
              await log(`No coupons found for ${domain}`, "WARN");
              await log(`Completed processing for domain: ${domain}`);
              return { success: false, domain };
            }
          } catch (error) {
            logError(`Failed to process domain: ${domain}`, error);
            return { success: false, domain };
          }
        })
      );

      // Count successes and failures
      results.forEach((result) => {
        if (result.success) {
          letterSuccessCount++;
          totalSuccessCount++;
        } else {
          letterErrorCount++;
          totalErrorCount++;
        }
      });

      // Add a delay between batches to avoid overloading resources
      if (i + CONFIG.concurrentDomains < domains.length) {
        await log(
          `Waiting ${CONFIG.delayBetweenDomains}ms before next batch...`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.delayBetweenDomains)
        );
      }
    }

    await log(
      `Letter ${letter} completed: ${letterSuccessCount} successes, ${letterErrorCount} failures`
    );

    // Add a longer delay between letters to avoid being detected as a bot
    if (letters.indexOf(letter) < letters.length - 1) {
      const delayBetweenLetters = CONFIG.delayBetweenDomains * 2; // Twice the domain delay
      await log(`Waiting ${delayBetweenLetters}ms before next letter...`);
      await new Promise((resolve) => setTimeout(resolve, delayBetweenLetters));
    }
  }

  await log(`----------------------------------------`);
  await log(`Full alphabet coupon scraping completed!`);
  await log(`Successfully processed: ${totalSuccessCount} domains`);
  await log(`Failed to process: ${totalErrorCount} domains`);

  // Exit with error code if all domains failed
  if (totalSuccessCount === 0) {
    await log("All domains failed to process", "ERROR");
    process.exit(1);
  }
}

// Export functions for testing
module.exports = {
  scrapeDomains,
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
