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
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
    );
    await page.setJavaScriptEnabled(true);

    // Set default navigation timeout (higher for GitHub Actions)
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

        // Default code (will be updated later if modal URL exists)
        let code = "AUTOMATIC";
        const modalUrl = element.getAttribute("data-modal");

        basicCoupons.push({
          id: idCounter++,
          code,
          discount,
          terms,
          verified,
          source: "CouponFollow",
        });

        modalUrls.push(modalUrl);
      });

      return { basicCoupons, modalUrls };
    });

    await log(
      `Found ${basicCoupons.length} basic coupons for ${domain}, processing modal URLs...`
    );

    // Save basic results to a JSON file for debugging
    const basicResultsPath = path.join(
      process.cwd(),
      `${domain.replace(/\./g, "_")}_basic.json`
    );
    await fs.writeFile(
      basicResultsPath,
      JSON.stringify({ basicCoupons, modalUrls }, null, 2)
    );

    // Process coupons with modal URLs to get the actual codes
    const completeCoupons = [...basicCoupons];

    // We'll process modals in batches to avoid opening too many pages at once
    const batchSize = 3; // Smaller batch size for GitHub Actions
    const modalPages = [];

    try {
      // Create a pool of pages for processing modals
      for (let i = 0; i < Math.min(batchSize, modalUrls.length); i++) {
        const modalPage = await browser.newPage();
        await modalPage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
        );
        await modalPage.setJavaScriptEnabled(true);
        modalPage.setDefaultNavigationTimeout(60000); // 1 minute
        modalPages.push(modalPage);
      }

      // Process in batches
      for (let i = 0; i < basicCoupons.length; i += batchSize) {
        const batch = [];

        // Create promises for this batch
        for (let j = 0; j < batchSize && i + j < basicCoupons.length; j++) {
          const couponIndex = i + j;
          const modalUrl = modalUrls[couponIndex];

          if (modalUrl) {
            batch.push(
              (async () => {
                const modalPage = modalPages[j % modalPages.length];
                try {
                  await log(
                    `Processing modal for coupon ${couponIndex + 1}/${
                      basicCoupons.length
                    }: ${modalUrl}`
                  );

                  // Navigate to the modal URL
                  await modalPage.goto(modalUrl, {
                    waitUntil: "networkidle2",
                    timeout: 60000,
                  });

                  // Extract the code from the modal
                  const code = await modalPage.evaluate(() => {
                    // Try various selectors similar to your background.ts
                    const specificSelectors = [
                      "input#code.input.code",
                      "input.input.code",
                      "input#code",
                      "input.code",
                      "input[name='code']",
                    ];

                    // Try the specific selectors first
                    for (const selector of specificSelectors) {
                      const element = document.querySelector(selector);
                      if (!element) continue;

                      const value = element.value.trim();
                      if (value) return value;
                    }

                    console.log(
                      "No code found in modal, selectors didn't match"
                    );
                    return "AUTOMATIC"; // Default if no code found
                  });

                  // Update the coupon with the extracted code
                  if (code && code !== "AUTOMATIC") {
                    completeCoupons[couponIndex].code = code;
                    await log(
                      `Found code ${code} for coupon ${couponIndex + 1}`
                    );
                  } else {
                    await log(
                      `No code found for coupon ${couponIndex + 1}`,
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
        }

        // Wait for this batch to complete before starting the next batch
        await Promise.all(batch);

        // Small delay between batches
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      // Close all modal pages
      for (const modalPage of modalPages) {
        await modalPage
          .close()
          .catch((err) => logError("Error closing modal page", err));
      }
    }

    await log(
      `Completed processing ${completeCoupons.length} coupons for ${domain}`
    );

    // Save complete results to a JSON file for debugging
    const completeResultsPath = path.join(
      process.cwd(),
      `${domain.replace(/\./g, "_")}_complete.json`
    );
    await fs.writeFile(
      completeResultsPath,
      JSON.stringify(completeCoupons, null, 2)
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
    await log(`Waiting before processing next domain...`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
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
