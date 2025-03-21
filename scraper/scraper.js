// scraper/scraper.js
const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
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

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: CONFIG.navigationTimeout,
    });

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

    scrapeCoupons();
    return domains;
  } catch (error) {
    return [];
  } finally {
    await browser.close();
  }
}

async function scrapeCoupons(domain, retryCount = 0) {
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

    await page.goto(`https://couponfollow.com/site/${domain}`, {
      waitUntil: "domcontentloaded", // Faster than networkidle2
      timeout: CONFIG.navigationTimeout,
    });

    await new Promise((r) => setTimeout(r, 500));

    // Immediately extract coupon data before all resources finish loading
    const { basicCoupons, modalUrls, directCodes } = await page.evaluate(() => {
      const basicCoupons = [];
      const modalUrls = [];
      const directCodes = new Map(); // Store any directly available codes
      let idCounter = 1;

      // Use faster selectors
      const couponElements = document.querySelectorAll(
        '.offer-card.regular-offer[data-type="coupon"]'
      );

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

        // Try to find code in any hidden input or span
        if (!hasDirectCode) {
          const codeElements = element.querySelectorAll(
            'input[type="hidden"], .code-text, [data-clipboard-text]'
          );
          for (const el of codeElements) {
            const possibleCode =
              el.value ||
              el.getAttribute("data-clipboard-text") ||
              el.textContent;
            if (possibleCode && possibleCode.trim() !== "") {
              code = possibleCode.trim();
              hasDirectCode = true;
              break;
            }
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

    // Convert directCodes array back to Map
    const directCodesMap = new Map(directCodes);

    // Create a copy of coupons to update
    const completeCoupons = [...basicCoupons];

    // Only process coupons that don't have direct codes
    const couponsToProcess = basicCoupons.filter(
      (_, index) => !directCodesMap.get(index + 1)
    );
    const modalUrlsToProcess = modalUrls.filter((url) => url);

    if (modalUrlsToProcess.length > 0) {
      try {
        // Increase batch size for better throughput
        const batchSize = Math.min(CONFIG.batchSize * 2, 10); // Double but cap at 10
        const totalModals = modalUrlsToProcess.length;
        const totalBatches = Math.ceil(totalModals / batchSize);

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

                  // Use a faster navigation strategy
                  await modalPage.goto(modalUrl, {
                    waitUntil: "domcontentloaded", // Much faster than networkidle2
                    timeout: shorterTimeout,
                  });

                  // Don't wait for selectors, immediately try to extract
                  // This reduces waiting time significantly
                  const code = await modalPage.evaluate(() => {
                    // Try all selectors at once
                    const selectors = [
                      "input#code.input.code",
                      "input.input.code",
                      ".coupon-code",
                      ".code-text",
                      "[data-clipboard-text]",
                      "[data-code]",
                    ];

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
                    completeCoupons[couponIndex].code = code;
                  }
                } catch (error) {
                  // Silently fail and continue with other modals
                  console.error(
                    `Error with modal ${modalIndex}:`,
                    error.message
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
      } catch (error) {}
    }

    return completeCoupons;
  } catch (error) {
    if (retryCount < CONFIG.domainRetries) {
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
    return;
  }

  // Save to Supabase
  try {
    const { data, error } = await supabase
      .from("coupons")
      .upsert(uniqueCoupons, {
        onConflict: ["domain", "code"],
        ignoreDuplicates: true,
      });
  } catch (error) {}
}

async function main() {
  const letters = process.env.LETTERS
    ? process.env.LETTERS.split(",")
    : process.argv.length > 2
    ? process.argv[2].split(",")
    : [];
  let totalSuccessCount = 0;
  let totalErrorCount = 0;

  // Process each letter
  for (const letter of letters) {
    // Get all domains for this letter
    const domains = await scrapeDomains(letter);

    if (domains.length === 0) {
      continue;
    }

    let letterSuccessCount = 0;
    let letterErrorCount = 0;

    // Process domains in batches for concurrency
    for (let i = 0; i < domains.length; i += CONFIG.concurrentDomains) {
      const batch = domains.slice(i, i + CONFIG.concurrentDomains);

      const results = await Promise.all(
        batch.map(async (domain) => {
          try {
            const coupons = await scrapeCoupons(domain);

            if (coupons.length > 0) {
              await saveToDatabase(domain, coupons);
              return { success: true, domain };
            } else {
              return { success: false, domain };
            }
          } catch (error) {
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
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.delayBetweenDomains)
        );
      }
    }

    // Add a longer delay between letters to avoid being detected as a bot
    if (letters.indexOf(letter) < letters.length - 1) {
      const delayBetweenLetters = CONFIG.delayBetweenDomains;
      await new Promise((resolve) => setTimeout(resolve, delayBetweenLetters));
    }
  }

  // Exit with error code if all domains failed
  if (totalSuccessCount === 0) {
    process.exit(1);
  }
}

main();
