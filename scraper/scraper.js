// scraper/scraper.js
const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Missing Supabase credentials. Please set SUPABASE_URL and SUPABASE_ANON_KEY environment variables."
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Configuration for scraping performance
const CONFIG = {
  concurrentDomains: process.env.CONCURRENT_DOMAINS
    ? parseInt(process.env.CONCURRENT_DOMAINS)
    : 5,
  delayBetweenDomains: process.env.DELAY_BETWEEN_DOMAINS
    ? parseInt(process.env.DELAY_BETWEEN_DOMAINS)
    : 200,
  domainRetries: process.env.DOMAIN_RETRIES
    ? parseInt(process.env.DOMAIN_RETRIES)
    : 2,
};

/**
 * Scrapes domains from a category page
 * @param {string} letter - The letter category to scrape
 * @returns {Promise<string[]>} - Array of domain names
 */
async function scrapeDomains(letter) {
  console.log(`Scraping domains for letter: ${letter}`);

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
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
    );

    // Block unnecessary resources
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

    // Navigate to the letter page
    const letterParam = letter === "#" ? "num" : letter.toLowerCase();
    await page.goto(`https://couponfollow.com/site/browse/${letterParam}/all`, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Extract domain names
    const domains = await page.evaluate(() => {
      const domainElements = document.querySelectorAll("a.store-link");
      return Array.from(domainElements)
        .map((el) => {
          const url = el.getAttribute("href");
          // Extract domain from /site/domain-name format
          if (url && url.startsWith("/site/")) {
            return url.split("/site/")[1];
          }
          return null;
        })
        .filter(Boolean);
    });

    console.log(`Found ${domains.length} domains for letter ${letter}`);
    return domains;
  } catch (error) {
    console.error(
      `Error scraping domains for letter ${letter}:`,
      error.message
    );
    return [];
  } finally {
    await browser.close();
  }
}

/**
 * Scrapes coupons for a specific domain
 * @param {string} domain - The domain to scrape coupons for
 * @param {number} retryCount - Current retry attempt
 * @returns {Promise<Array>} - Array of coupon objects
 */
async function scrapeCoupons(domain, retryCount = 0) {
  console.log(`Scraping coupons for ${domain}...`);

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

    // Block unnecessary resources
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

    console.log(`Navigating to couponfollow.com for ${domain}...`);
    await page.goto(`https://couponfollow.com/site/${domain}`, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Extract basic coupon information and modal URLs
    const { basicCoupons, modalUrls } = await page.evaluate(() => {
      const basicCoupons = [];
      const modalUrls = [];
      let idCounter = 1;

      const couponCards = document.querySelectorAll(
        '.offer-card.regular-offer[data-type="coupon"]'
      );

      couponCards.forEach((card) => {
        // Extract basic information
        const discount =
          card.querySelector(".offer-title")?.textContent?.trim() || "";
        const terms =
          card.querySelector(".offer-description")?.textContent?.trim() || "";
        const verified = card.getAttribute("data-is-verified") === "True";

        // Get modal URL for code extraction
        const modalUrl = card.getAttribute("data-modal") || null;

        basicCoupons.push({
          id: idCounter++,
          discount,
          terms,
          verified,
          code: null, // Will be filled in later
        });

        modalUrls.push(modalUrl);
      });

      return { basicCoupons, modalUrls };
    });

    console.log(
      `Found ${basicCoupons.length} coupons for ${domain}, processing codes...`
    );

    // Process modals to get codes
    const modalPromises = basicCoupons.map(async (coupon, i) => {
      const modalUrl = modalUrls[i];

      // Skip if no modal URL
      if (!modalUrl) {
        console.log(`Coupon ${coupon.id} has no modal URL, skipping`);
        coupon.code = "AUTOMATIC"; // Default fallback
        return;
      }

      // Process the modal
      try {
        console.log(`Opening modal for coupon ${coupon.id}: ${modalUrl}`);

        const modalPage = await context.newPage();
        await modalPage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
        );

        // Optimize page settings for speed
        await modalPage.setJavaScriptEnabled(true);
        await modalPage.setCacheEnabled(true);

        // More aggressive resource blocking
        await modalPage.setRequestInterception(true);
        modalPage.on("request", (req) => {
          const resourceType = req.resourceType();
          if (
            ["image", "stylesheet", "font", "media", "other"].includes(
              resourceType
            )
          ) {
            req.abort();
          } else {
            req.continue();
          }
        });

        // Navigate with optimized settings
        await modalPage.goto(modalUrl, {
          waitUntil: "domcontentloaded", // Changed from networkidle2 for speed
          timeout: 15000, // Reduced timeout
        });

        // Optimized code extraction
        const code = await modalPage.evaluate(() => {
          const codeInput =
            document.querySelector("input#code.input.code") ||
            document.querySelector("input.input.code");
          return codeInput && codeInput.value && codeInput.value !== "AUTOMATIC"
            ? codeInput.value.trim()
            : null;
        });

        if (code) {
          coupon.code = code;
          console.log(
            `Successfully extracted code "${code}" for coupon ${coupon.id}`
          );
        } else {
          console.log(`Could not extract code for coupon ${coupon.id}`);
          coupon.code = "AUTOMATIC";
        }

        await modalPage.close();
      } catch (modalError) {
        console.error(
          `Error processing modal for coupon ${coupon.id}:`,
          modalError.message
        );
        coupon.code = "AUTOMATIC";
      }
    });

    // Process all modals concurrently
    await Promise.all(modalPromises);

    // Return only coupons with valid codes
    const validCoupons = basicCoupons.filter(
      (coupon) => coupon.code && coupon.code !== "AUTOMATIC"
    );

    console.log(
      `Found ${validCoupons.length} valid coupons with codes for ${domain}`
    );
    return validCoupons;
  } catch (error) {
    console.error(`Error scraping ${domain}:`, error.message);
    if (retryCount < CONFIG.domainRetries) {
      console.log(
        `Retrying ${domain} (attempt ${retryCount + 1}/${
          CONFIG.domainRetries
        })...`
      );
      await new Promise((r) => setTimeout(r, 2000));
      return scrapeCoupons(domain, retryCount + 1);
    }
    return [];
  } finally {
    await browser.close();
  }
}

// Save coupons to Supabase database
async function saveToDatabase(domain, coupons) {
  if (coupons.length === 0) {
    console.log(`No valid coupons to save for ${domain}`);
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
  console.log(`Saving ${couponsToSave.length} coupon codes for ${domain}:`);
  couponsToSave.forEach((c, i) => {
    console.log(
      `  ${i + 1}. ${c.code} (${c.verified ? "verified" : "unverified"}): ${
        c.discount
      }`
    );
  });

  // Save all collected coupons to database
  try {
    const { error } = await supabase.from("coupons").insert(couponsToSave);

    if (error) {
      console.error(
        `Error saving coupons for ${domain} to database:`,
        error.message
      );
    } else {
      console.log(
        `Successfully saved ${couponsToSave.length} coupons for ${domain} to database`
      );
    }
  } catch (error) {
    console.error(
      `Exception saving coupons for ${domain} to database:`,
      error.message
    );
  }
}

async function main() {
  console.log("Starting coupon scraper...");

  const letters = process.env.LETTERS
    ? process.env.LETTERS.split(",")
    : process.argv.length > 2
    ? process.argv[2].split(",")
    : [
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
        "h",
        "i",
        "j",
        "k",
        "l",
        "m",
        "n",
        "o",
        "p",
        "q",
        "r",
        "s",
        "t",
        "u",
        "v",
        "w",
        "x",
        "y",
        "z",
        "#",
      ];

  let totalSuccessCount = 0;
  let totalErrorCount = 0;

  // Process each letter in sequence
  for (const letter of letters) {
    console.log(`-------------------------------------------`);
    console.log(`Starting to process letter: ${letter}`);

    // Get domains for this letter
    const domains = await scrapeDomains(letter);
    if (domains.length === 0) {
      console.log(`No domains found for letter ${letter}, skipping...`);
      continue;
    }

    console.log(`Processing ${domains.length} domains for letter ${letter}...`);

    let letterSuccessCount = 0;
    let letterErrorCount = 0;

    // Process domains in batches for concurrency
    for (let i = 0; i < domains.length; i += CONFIG.concurrentDomains) {
      const batch = domains.slice(i, i + CONFIG.concurrentDomains);
      console.log(
        `Processing batch of ${batch.length} domains (${i + 1}-${Math.min(
          i + CONFIG.concurrentDomains,
          domains.length
        )} of ${domains.length})...`
      );

      const results = await Promise.all(
        batch.map(async (domain) => {
          try {
            console.log(`Starting processing for domain: ${domain}`);

            const coupons = await scrapeCoupons(domain);

            if (coupons.length > 0) {
              await saveToDatabase(domain, coupons);
              console.log(`Completed processing for domain: ${domain}`);
              return { success: true, domain };
            } else {
              console.log(`No coupons found for ${domain}`);
              console.log(`Completed processing for domain: ${domain}`);
              return { success: false, domain };
            }
          } catch (error) {
            console.error(`Failed to process domain: ${domain}`, error.message);
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
        console.log(
          `Waiting ${CONFIG.delayBetweenDomains}ms before next batch...`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.delayBetweenDomains)
        );
      }
    }

    console.log(
      `Letter ${letter} completed: ${letterSuccessCount} successes, ${letterErrorCount} failures`
    );

    // Add a longer delay between letters to avoid being detected as a bot
    if (letters.indexOf(letter) < letters.length - 1) {
      const delayBetweenLetters = CONFIG.delayBetweenDomains; // Twice the domain delay
      console.log(`Waiting ${delayBetweenLetters}ms before next letter...`);
      await new Promise((resolve) => setTimeout(resolve, delayBetweenLetters));
    }
  }

  console.log(`----------------------------------------`);
  console.log(`Coupon scraping completed!`);
  console.log(`Successfully processed: ${totalSuccessCount} domains`);
  console.log(`Failed to process: ${totalErrorCount} domains`);

  // Exit with error code if all domains failed
  if (totalSuccessCount === 0) {
    console.error("All domains failed to process");
    process.exit(1);
  }
}

// Only run main if this script is called directly
if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error in main:", error.message);
    process.exit(1);
  });
}

module.exports = { scrapeDomains, scrapeCoupons, saveToDatabase };
