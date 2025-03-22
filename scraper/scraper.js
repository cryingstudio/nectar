// scraper/scraper.js
const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");

console.log("Starting coupon scraper script");

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "ERROR: Missing Supabase credentials. SUPABASE_URL and SUPABASE_ANON_KEY must be set."
  );
  process.exit(1);
}

console.log("Supabase credentials found, initializing client");
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

console.log("Configuration loaded:", CONFIG);

/**
 * Scrapes domain names from CouponFollow's category page
 * @param {string} letter - The letter category (a-z or #) to scrape
 * @returns {Promise<string[]>} - Array of domain names
 */
async function scrapeDomains(letter) {
  console.log(`Starting to scrape domains for letter category: ${letter}`);

  const startTime = Date.now();
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
  console.log("Browser launched for domain scraping");

  try {
    const page = await browser.newPage();
    console.log("New page created for domain scraping");

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
    console.log("Anti-detection measures applied");

    page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

    // Navigate to the letter's category page
    const url = `https://couponfollow.com/site/browse/${letter}/all`;
    console.log(`Navigating to: ${url}`);

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: CONFIG.navigationTimeout,
    });
    console.log(`Successfully loaded category page for letter: ${letter}`);

    // Extract domain names from the page
    const domains = await page.evaluate(() => {
      const domainList = [];

      // Each store is in a list item with a link
      const storeLinks = document.querySelectorAll("a.store-link");
      console.log(`Found ${storeLinks.length} store links on page`);

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

    const duration = Date.now() - startTime;
    console.log(
      `Extracted ${domains.length} domains for letter ${letter} in ${duration}ms`
    );

    scrapeCoupons();
    return domains;
  } catch (error) {
    console.error(
      `ERROR scraping domains for letter ${letter}:`,
      error.message
    );
    return [];
  } finally {
    await browser.close();
    console.log(`Browser closed for letter ${letter} domain scraping`);
  }
}

async function scrapeCoupons(domain, retryCount = 0) {
  if (!domain) {
    console.error(
      "ERROR: Domain parameter is missing in scrapeCoupons function"
    );
    return [];
  }

  console.log(
    `Starting to scrape coupons for domain: ${domain} (Attempt: ${
      retryCount + 1
    })`
  );
  const startTime = Date.now();

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
  console.log(`Browser launched for ${domain}`);

  try {
    // Create a single browser context for better resource management
    const context = await browser.createBrowserContext();
    console.log(`Browser context created for ${domain}`);

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
    console.log(`Anti-detection measures applied for ${domain}`);

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
    console.log(`Request interception set up for ${domain}`);

    // Set shorter timeout
    page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

    console.log(`Navigating to https://couponfollow.com/site/${domain}`);
    await page.goto(`https://couponfollow.com/site/${domain}`, {
      waitUntil: "domcontentloaded", // Faster than networkidle2
      timeout: CONFIG.navigationTimeout,
    });
    console.log(`Successfully loaded page for ${domain}`);

    await new Promise((r) => setTimeout(r, 500));

    // Immediately extract coupon data before all resources finish loading
    console.log(`Extracting initial coupon data for ${domain}`);
    const { basicCoupons, modalUrls, directCodes } = await page.evaluate(() => {
      const basicCoupons = [];
      const modalUrls = [];
      const directCodes = new Map(); // Store any directly available codes
      let idCounter = 1;

      // Use faster selectors
      const couponElements = document.querySelectorAll(
        '.offer-card.regular-offer[data-type="coupon"]'
      );
      console.log(`Found ${couponElements.length} coupon elements on page`);

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

        basicCoupons.push({
          id: idCounter++,
          code,
          discount,
          terms,
          verified,
          source: "CouponFollow",
          elementId,
        });

        // Only store modal URLs for coupons without direct codes
        if (!hasDirectCode && modalUrl) {
          modalUrls.push(modalUrl);
          directCodes.set(idCounter - 1, false);
        } else {
          directCodes.set(idCounter - 1, true);
        }
      });

      return {
        basicCoupons,
        modalUrls,
        directCodes: Array.from(directCodes.entries()),
      };
    });

    console.log(`Extracted ${basicCoupons.length} basic coupons for ${domain}`);
    console.log(
      `Found ${modalUrls.length} modal URLs that need processing for ${domain}`
    );

    // Convert directCodes array back to Map
    const directCodesMap = new Map(directCodes);

    // Create a copy of coupons to update
    const completeCoupons = [...basicCoupons];

    // Only process coupons that don't have direct codes
    const couponsToProcess = basicCoupons.filter(
      (_, index) => !directCodesMap.get(index + 1)
    );
    const modalUrlsToProcess = modalUrls.filter((url) => url);

    console.log(
      `${couponsToProcess.length} coupons need modal processing for ${domain}`
    );

    if (modalUrlsToProcess.length > 0) {
      try {
        // Increase batch size for better throughput
        const batchSize = CONFIG.batchSize;
        const totalModals = modalUrlsToProcess.length;
        const totalBatches = Math.ceil(totalModals / batchSize);

        console.log(
          `Processing ${totalModals} modals in ${totalBatches} batches (batch size: ${batchSize})`
        );

        // Pre-create a pool of pages for reuse
        console.log(`Creating page pool of ${batchSize} pages`);
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
        console.log(`Page pool created for ${domain}`);

        // Process in parallel batches
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const startIndex = batchIndex * batchSize;
          const endIndex = Math.min(startIndex + batchSize, totalModals);
          const currentBatchSize = endIndex - startIndex;

          console.log(
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
            const couponIndex = basicCoupons.findIndex(
              (coupon) =>
                !directCodesMap.get(coupon.id) && coupon.code === "AUTOMATIC"
            );

            if (couponIndex === -1) continue;

            // Use a page from the pool
            const modalPage = pagePool[i % pagePool.length];

            batchPromises.push(
              (async () => {
                try {
                  // Faster timeout for modals
                  const shorterTimeout = Math.min(CONFIG.modalTimeout, 8000);

                  console.log(
                    `Processing modal ${modalIndex + 1} at URL: ${modalUrl}`
                  );
                  // Use a faster navigation strategy
                  await modalPage.goto(modalUrl, {
                    waitUntil: "domcontentloaded", // Much faster than networkidle2
                    timeout: shorterTimeout,
                  });

                  // Don't wait for selectors, immediately try to extract
                  // This reduces waiting time significantly
                  const code = await modalPage.evaluate(() => {
                    // Try all selectors at once
                    const selectors = ["input#code.input.code"];

                    // Try to find the code using any selector
                    for (const selector of selectors) {
                      const element = document.querySelector(selector);
                      if (!element) continue;

                      // Extract code based on element type
                      if (element.tagName === "INPUT") {
                        return element.value.trim();
                      } else {
                        return (
                          element.getAttribute("data-clipboard-text") ||
                          element.getAttribute("data-code") ||
                          element.textContent.trim()
                        );
                      }
                    }

                    return "AUTOMATIC"; // Default if not found
                  });

                  // Update the coupon with the extracted code
                  if (code && code !== "AUTOMATIC") {
                    console.log(
                      `Found code for modal ${modalIndex + 1}: ${code}`
                    );
                    completeCoupons[couponIndex].code = code;
                  } else {
                    console.log(
                      `No code found for modal ${
                        modalIndex + 1
                      }, keeping as AUTOMATIC`
                    );
                  }
                } catch (error) {
                  // Silently fail and continue with other modals
                  console.error(
                    `Error with modal ${modalIndex + 1}:`,
                    error.message
                  );
                }
              })()
            );
          }

          // Wait for all modals in this batch to complete
          await Promise.allSettled(batchPromises);
          console.log(
            `Batch ${batchIndex + 1}/${totalBatches} processing complete`
          );

          // Add a small delay between batches to avoid overwhelming the server
          if (batchIndex < totalBatches - 1) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }

        // Close all pages in the pool
        console.log(`Closing page pool`);
        for (const modalPage of pagePool) {
          await modalPage.close().catch(() => {});
        }
      } catch (error) {
        console.error(
          `ERROR in modal processing for ${domain}:`,
          error.message
        );
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `Completed scraping ${completeCoupons.length} coupons for ${domain} in ${duration}ms`
    );
    return completeCoupons;
  } catch (error) {
    console.error(`ERROR scraping coupons for ${domain}:`, error.message);
    if (retryCount < CONFIG.domainRetries) {
      console.log(
        `Retrying ${domain} (Attempt ${retryCount + 2}/${
          CONFIG.domainRetries + 1
        })`
      );
      await new Promise((r) => setTimeout(r, 2000));
      return scrapeCoupons(domain, retryCount + 1);
    }
    console.error(`All retry attempts failed for ${domain}`);
    return [];
  } finally {
    await browser.close();
    console.log(`Browser closed for ${domain}`);
  }
}

async function saveToDatabase(domain, coupons) {
  console.log(
    `Preparing to save ${coupons.length} coupons for ${domain} to database`
  );

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
  console.log(
    `De-duplicated to ${uniqueCoupons.length} unique coupons for ${domain}`
  );

  if (uniqueCoupons.length === 0) {
    console.log(`No unique coupons to save for ${domain}`);
    return;
  }

  // Save to Supabase
  try {
    console.log(
      `Saving ${uniqueCoupons.length} coupons to Supabase for ${domain}`
    );
    const { data, error } = await supabase
      .from("coupons")
      .upsert(uniqueCoupons, {
        onConflict: ["domain", "code"],
        ignoreDuplicates: true,
      });

    if (error) {
      console.error(`ERROR saving to database for ${domain}:`, error);
    } else {
      console.log(`Successfully saved coupons for ${domain} to database`);
    }
  } catch (error) {
    console.error(`EXCEPTION saving to database for ${domain}:`, error.message);
  }
}

async function main() {
  console.log("Starting main scraping process");

  const letters = process.env.LETTERS
    ? process.env.LETTERS.split(",")
    : process.argv.length > 2
    ? process.argv[2].split(",")
    : [];

  console.log(`Processing letter categories: ${letters.join(", ")}`);

  let totalSuccessCount = 0;
  let totalErrorCount = 0;

  const startTime = Date.now();

  // Process each letter
  for (const letter of letters) {
    console.log(`\n===== Processing letter category: ${letter} =====`);

    // Get all domains for this letter
    const domains = await scrapeDomains(letter);

    if (domains.length === 0) {
      console.log(
        `No domains found for letter ${letter}, skipping to next letter`
      );
      continue;
    }

    console.log(`Found ${domains.length} domains for letter ${letter}`);
    let letterSuccessCount = 0;
    let letterErrorCount = 0;

    // Process domains in batches for concurrency
    for (let i = 0; i < domains.length; i += CONFIG.concurrentDomains) {
      const batch = domains.slice(i, i + CONFIG.concurrentDomains);
      const batchNumber = Math.floor(i / CONFIG.concurrentDomains) + 1;
      const totalBatches = Math.ceil(domains.length / CONFIG.concurrentDomains);

      console.log(
        `\nProcessing batch ${batchNumber}/${totalBatches} (${batch.length} domains)`
      );
      console.log(`Domains in batch: ${batch.join(", ")}`);

      const results = await Promise.all(
        batch.map(async (domain) => {
          try {
            console.log(`Starting to process domain: ${domain}`);
            const coupons = await scrapeCoupons(domain);

            if (coupons.length > 0) {
              console.log(
                `Found ${coupons.length} coupons for ${domain}, saving to database`
              );
              await saveToDatabase(domain, coupons);
              return { success: true, domain, couponCount: coupons.length };
            } else {
              console.log(`No coupons found for ${domain}`);
              return { success: false, domain, couponCount: 0 };
            }
          } catch (error) {
            console.error(`ERROR processing domain ${domain}:`, error.message);
            return { success: false, domain, error: error.message };
          }
        })
      );

      // Count successes and failures
      results.forEach((result) => {
        if (result.success) {
          letterSuccessCount++;
          totalSuccessCount++;
          console.log(
            `✅ Success: ${result.domain} (${result.couponCount} coupons)`
          );
        } else {
          letterErrorCount++;
          totalErrorCount++;
          console.log(
            `❌ Failed: ${result.domain}${
              result.error ? ` - ${result.error}` : ""
            }`
          );
        }
      });

      console.log(
        `Batch ${batchNumber}/${totalBatches} complete. Success: ${
          results.filter((r) => r.success).length
        }, Failed: ${results.filter((r) => !r.success).length}`
      );

      // Add a delay between batches to avoid overloading resources
      if (i + CONFIG.concurrentDomains < domains.length) {
        console.log(
          `Waiting ${CONFIG.delayBetweenDomains}ms before next batch`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.delayBetweenDomains)
        );
      }
    }

    console.log(
      `\nCompleted letter ${letter}. Success: ${letterSuccessCount}, Failed: ${letterErrorCount}`
    );

    // Add a longer delay between letters to avoid being detected as a bot
    if (letters.indexOf(letter) < letters.length - 1) {
      const delayBetweenLetters = CONFIG.delayBetweenDomains;
      console.log(
        `Waiting ${delayBetweenLetters}ms before next letter category`
      );
      await new Promise((resolve) => setTimeout(resolve, delayBetweenLetters));
    }
  }

  const totalDuration = (Date.now() - startTime) / 1000;
  console.log("\n===== Scraping process complete =====");
  console.log(`Total successful domains: ${totalSuccessCount}`);
  console.log(`Total failed domains: ${totalErrorCount}`);
  console.log(`Total execution time: ${totalDuration.toFixed(2)} seconds`);

  // Exit with error code if all domains failed
  if (totalSuccessCount === 0) {
    console.error("ERROR: All domains failed. Exiting with error code 1");
    process.exit(1);
  }

  console.log("Scraping process completed successfully");
}

main();
