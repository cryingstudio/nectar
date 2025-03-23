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
  delayBetweenDomains: process.env.DELAY_BETWEEN_DOMAINS
    ? parseInt(process.env.DELAY_BETWEEN_DOMAINS)
    : 1000,
};

/**
 * Scrapes domain names from CouponFollow's category page
 * @param {string} letter - The letter category (a-z or #) to scrape
 * @returns {Promise<string[]>} - Array of domain names
 */
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
    ],
  });

  try {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
    );

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

    await log(`Navigating to couponfollow.com for ${domain}...`);
    await page.goto(`https://couponfollow.com/site/${domain}`, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Collect all coupon data including show-code buttons
    const coupons = await page.evaluate(() => {
      const results = [];

      const couponCards = document.querySelectorAll(
        '.offer-card.regular-offer[data-type="coupon"]'
      );

      couponCards.forEach((card, index) => {
        // Extract basic information
        const discount =
          card.querySelector(".offer-title")?.textContent?.trim() || "";
        const terms =
          card.querySelector(".offer-description")?.textContent?.trim() || "";
        const verified = card.getAttribute("data-is-verified") === "True";

        // Try to get direct code if available
        let code = null;
        let modalUrl = null;

        // Check for direct code in data attributes or button
        const showCodeBtn = card.querySelector(".show-code");
        if (showCodeBtn) {
          // Check various attributes where code might be stored
          code =
            showCodeBtn.getAttribute("data-code") ||
            showCodeBtn.getAttribute("data-clipboard-text") ||
            null;

          // If there's no direct code, get the modal URL
          if (!code) {
            modalUrl = card.getAttribute("data-modal") || null;
          }
        }

        results.push({
          id: index + 1,
          discount,
          terms,
          verified,
          code, // This will be null if not directly available
          modalUrl,
        });
      });

      return results;
    });

    await log(
      `Found ${coupons.length} coupons for ${domain}, processing codes...`
    );

    // Process modals to get codes where needed
    for (let i = 0; i < coupons.length; i++) {
      const coupon = coupons[i];

      // Skip if we already have a code
      if (coupon.code) {
        await log(`Coupon ${coupon.id} already has code: ${coupon.code}`);
        continue;
      }

      // Skip if no modal URL
      if (!coupon.modalUrl) {
        await log(`Coupon ${coupon.id} has no code and no modal URL, skipping`);
        continue;
      }

      // Process the modal
      try {
        await log(`Opening modal for coupon ${coupon.id}: ${coupon.modalUrl}`);

        const modalPage = await context.newPage();
        await modalPage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
        );

        // Block images and other non-essential resources
        await modalPage.setRequestInterception(true);
        modalPage.on("request", (req) => {
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

        // Navigate to the modal URL
        await modalPage.goto(coupon.modalUrl, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });

        // Wait a moment for any JavaScript to run
        await modalPage.waitForTimeout(1000);

        // Extract the code using multiple strategies
        const code = await modalPage.evaluate(() => {
          // Strategy 1: Look for input field with code
          const codeInput = document.querySelector("input#code.input.code");
          if (codeInput && codeInput.value && codeInput.value !== "AUTOMATIC") {
            return codeInput.value.trim();
          }

          // Strategy 2: Look for a coupon code display element
          const codeDisplay = document.querySelector(".display-code");
          if (codeDisplay) {
            const displayText = codeDisplay.textContent.trim();
            if (displayText && displayText !== "AUTOMATIC") {
              return displayText;
            }
          }

          // Strategy 3: Look for elements with data-code attribute
          const dataCodeElements = document.querySelectorAll("[data-code]");
          for (const el of dataCodeElements) {
            const dataCode = el.getAttribute("data-code");
            if (dataCode && dataCode !== "AUTOMATIC") {
              return dataCode;
            }
          }

          // Strategy 4: Look for clipboard text
          const clipboardElements = document.querySelectorAll(
            "[data-clipboard-text]"
          );
          for (const el of clipboardElements) {
            const clipText = el.getAttribute("data-clipboard-text");
            if (clipText && clipText !== "AUTOMATIC") {
              return clipText;
            }
          }

          // Strategy 5: Look for specific text patterns that might be codes
          const bodyText = document.body.innerText;
          const codeMatches = bodyText.match(/Code:?\s*([A-Z0-9]{4,15})/i);
          if (codeMatches && codeMatches[1]) {
            return codeMatches[1].trim();
          }

          // No code found
          return null;
        });

        if (code) {
          coupon.code = code;
          await log(
            `Successfully extracted code "${code}" for coupon ${coupon.id}`
          );
        } else {
          await log(`Could not extract code for coupon ${coupon.id}`, "WARN");
          coupon.code = "AUTOMATIC"; // Default fallback
        }

        await modalPage.close();

        // Add a small delay between modal processing
        await new Promise((r) => setTimeout(r, 500));
      } catch (modalError) {
        await log(
          `Error processing modal for coupon ${coupon.id}: ${modalError.message}`,
          "ERROR"
        );
        coupon.code = "AUTOMATIC"; // Default fallback
      }
    }

    // Return only coupons with valid codes
    const validCoupons = coupons.filter(
      (coupon) => coupon.code && coupon.code !== "AUTOMATIC"
    );

    await log(
      `Found ${validCoupons.length} valid coupons with codes for ${domain}`
    );
    return validCoupons;
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

// Modified saveToDatabase function to save all coupons individually
async function saveToDatabase(domain, coupons) {
  if (coupons.length === 0) {
    await log(`No valid coupons to save for ${domain}`, "WARN");
    return;
  }

  // Prepare data for database
  const couponsToSave = coupons.map((coupon) => ({
    domain,
    code: coupon.code,
    discount: coupon.discount,
    terms: coupon.terms,
    verified: coupon.verified,
  }));

  // Log all collected coupon codes
  await log(
    `Saving ${couponsToSave.length} coupon codes for ${domain}:\n${couponsToSave
      .map(
        (c, i) =>
          `  ${i + 1}. ${c.code} (${c.verified ? "verified" : "unverified"}): ${
            c.discount
          }`
      )
      .join("\n")}`
  );

  // Save all collected coupons to database
  try {
    const { error } = await supabase.from("coupons").insert(couponsToSave);

    if (error) {
      logError(`Error saving coupons for ${domain} to database`, error);
    } else {
      await log(
        `Successfully saved ${couponsToSave.length} coupons for ${domain} to database`
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

// Only run main if this script is called directly
if (require.main === module) {
  main().catch((error) => {
    logError("Fatal error in main", error);
    process.exit(1);
  });
}
