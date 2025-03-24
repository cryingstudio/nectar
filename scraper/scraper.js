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

// Website-specific configurations
const WEBSITE_CONFIGS = {
  couponfollow: {
    name: "CouponFollow",
    baseUrl: "https://couponfollow.com",
    selectors: {
      domainLinks: "a.store-link",
      couponCards: '.offer-card.regular-offer[data-type="coupon"]',
      couponTitle: ".offer-title",
      couponDescription: ".offer-description",
      couponCode: "input#code.input.code, input.input.code",
    },
    getDomainUrl: (letter) => {
      const letterParam = letter === "#" ? "num" : letter.toLowerCase();
      return `https://couponfollow.com/site/browse/${letterParam}/all`;
    },
    extractDomainFromUrl: (url) => {
      if (url && url.startsWith("/site/")) {
        return url.split("/site/")[1];
      }
      return null;
    },
    getCouponUrl: (domain) => `https://couponfollow.com/site/${domain}`,
  },
};

/**
 * Scrapes domains from a category page
 * @param {string} letter - The letter category to scrape
 * @param {string} websiteKey - The key of the website configuration to use
 * @returns {Promise<string[]>} - Array of domain names
 */
async function scrapeDomains(letter, websiteKey) {
  const config = WEBSITE_CONFIGS[websiteKey];
  if (!config) {
    console.error(`No configuration found for website: ${websiteKey}`);
    return [];
  }

  console.log(`Scraping domains for letter: ${letter} from ${config.name}`);

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

    // Navigate to the letter page using the website-specific URL generator
    const url = config.getDomainUrl(letter);
    await page.goto(url, {
      waitUntil: "networkidle0",
      timeout: 30000,
    });

    // Wait for store links to be present using website-specific selector
    await page.waitForSelector(config.selectors.domainLinks, {
      timeout: 30000,
      visible: true,
    });

    // Extract domain names using website-specific selectors and extraction logic
    const domains = await page.evaluate((selector) => {
      const domainElements = document.querySelectorAll(selector);
      return Array.from(domainElements)
        .map((el) => {
          const url = el.getAttribute("href");
          // Return the URL for processing outside evaluate
          return url || null;
        })
        .filter(Boolean);
    }, config.selectors.domainLinks);

    // Process the URLs outside of evaluate
    const processedDomains = domains
      .map((url) => config.extractDomainFromUrl(url))
      .filter(Boolean);

    console.log(
      `Found ${processedDomains.length} domains for letter ${letter} on ${config.name}`
    );
    return processedDomains.map((domain) => ({ domain, websiteKey }));
  } catch (error) {
    console.error(
      `Error scraping domains for letter ${letter} on ${config.name}:`,
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
 * @param {string} websiteKey - The key of the website configuration to use
 * @param {number} retryCount - Current retry attempt
 * @returns {Promise<Array>} - Array of coupon objects
 */
async function scrapeCoupons(domain, websiteKey, retryCount = 0) {
  const config = WEBSITE_CONFIGS[websiteKey];
  if (!config) {
    console.error(`No configuration found for website: ${websiteKey}`);
    return [];
  }

  console.log(`Scraping coupons for ${domain} from ${config.name}...`);

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

    console.log(`Navigating to ${config.name} for ${domain}...`);
    const url = config.getCouponUrl(domain);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Extract basic coupon information and modal URLs using website-specific selectors
    const { basicCoupons, modalUrls } = await page.evaluate((config) => {
      const basicCoupons = [];
      const modalUrls = [];
      let idCounter = 1;

      const couponCards = document.querySelectorAll(
        config.selectors.couponCards
      );

      couponCards.forEach((card) => {
        // Extract basic information using website-specific selectors
        const discount =
          card
            .querySelector(config.selectors.couponTitle)
            ?.textContent?.trim() || "";
        const terms =
          card
            .querySelector(config.selectors.couponDescription)
            ?.textContent?.trim() || "";
        const verified = card.getAttribute("data-is-verified") === "True";

        // Get modal URL for code extraction
        const modalUrl = card.getAttribute("data-modal") || null;

        basicCoupons.push({
          id: idCounter++,
          discount,
          terms,
          verified,
          code: null,
        });

        modalUrls.push(modalUrl);
      });

      return { basicCoupons, modalUrls };
    }, config);

    console.log(
      `Found ${basicCoupons.length} coupons for ${domain}, processing codes...`
    );

    // Process modals to get codes
    const modalPromises = basicCoupons.map(async (coupon, i) => {
      const modalUrl = modalUrls[i];

      if (!modalUrl) {
        console.log(`Coupon ${coupon.id} has no modal URL, skipping`);
        coupon.code = "AUTOMATIC";
        return;
      }

      try {
        console.log(`Opening modal for coupon ${coupon.id}: ${modalUrl}`);

        const modalPage = await context.newPage();
        await modalPage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
        );

        await modalPage.setJavaScriptEnabled(true);
        await modalPage.setCacheEnabled(true);

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

        await modalPage.goto(modalUrl, {
          waitUntil: "networkidle0",
          timeout: 20000,
        });

        // Wait for and extract the code using website-specific selector
        await modalPage
          .waitForFunction(
            (selector) => {
              const input = document.querySelector(selector);
              return input && input.value && input.value.length > 0;
            },
            { timeout: 5000 },
            config.selectors.couponCode
          )
          .catch(() => {
            console.log(
              `Timeout waiting for code value for coupon ${coupon.id}`
            );
          });

        const code = await modalPage.evaluate((selector) => {
          const codeInput = document.querySelector(selector);
          const value = codeInput?.value?.trim();
          return value && value !== "AUTOMATIC" ? value : null;
        }, config.selectors.couponCode);

        if (code) {
          coupon.code = code;
          console.log(
            `Successfully extracted code "${code}" for coupon ${coupon.id}`
          );
        } else {
          await modalPage.waitForTimeout(200);
          const retryCode = await modalPage.evaluate((selector) => {
            const codeInput = document.querySelector(selector);
            const value = codeInput?.value?.trim();
            return value && value !== "AUTOMATIC" ? value : null;
          }, config.selectors.couponCode);

          if (retryCode) {
            coupon.code = retryCode;
            console.log(
              `Successfully extracted code "${retryCode}" for coupon ${coupon.id} on retry`
            );
          } else {
            console.log(
              `Could not extract code for coupon ${coupon.id} after retry`
            );
            coupon.code = "AUTOMATIC";
          }
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

    await Promise.all(modalPromises);

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
      return scrapeCoupons(domain, websiteKey, retryCount + 1);
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

  // Get websites to scrape from environment variable or use default (couponfollow)
  const websiteKeys = process.env.WEBSITES
    ? process.env.WEBSITES.split(",")
    : ["couponfollow"];

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

  // Process each website
  for (const websiteKey of websiteKeys) {
    const config = WEBSITE_CONFIGS[websiteKey];
    if (!config) {
      console.error(
        `No configuration found for website: ${websiteKey}, skipping...`
      );
      continue;
    }

    console.log(`\n=== Starting to scrape ${config.name} ===\n`);

    // Process each letter for the current website
    for (const letter of letters) {
      console.log(`-------------------------------------------`);
      console.log(`Starting to process letter: ${letter} on ${config.name}`);

      // Get domains for this letter
      const domains = await scrapeDomains(letter, websiteKey);
      if (domains.length === 0) {
        console.log(
          `No domains found for letter ${letter} on ${config.name}, skipping...`
        );
        continue;
      }

      console.log(
        `Processing ${domains.length} domains for letter ${letter} on ${config.name}...`
      );

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
              console.log(`Starting processing for domain: ${domain.domain}`);

              const coupons = await scrapeCoupons(
                domain.domain,
                domain.websiteKey
              );

              if (coupons.length > 0) {
                await saveToDatabase(domain.domain, coupons);
                console.log(
                  `Completed processing for domain: ${domain.domain}`
                );
                return { success: true, domain: domain.domain };
              } else {
                console.log(`No coupons found for ${domain.domain}`);
                console.log(
                  `Completed processing for domain: ${domain.domain}`
                );
                return { success: false, domain: domain.domain };
              }
            } catch (error) {
              console.error(
                `Failed to process domain: ${domain.domain}`,
                error.message
              );
              return { success: false, domain: domain.domain };
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
        `Letter ${letter} completed on ${config.name}: ${letterSuccessCount} successes, ${letterErrorCount} failures`
      );

      // Add a longer delay between letters to avoid being detected as a bot
      if (letters.indexOf(letter) < letters.length - 1) {
        const delayBetweenLetters = CONFIG.delayBetweenDomains;
        console.log(`Waiting ${delayBetweenLetters}ms before next letter...`);
        await new Promise((resolve) =>
          setTimeout(resolve, delayBetweenLetters)
        );
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`Coupon scraping completed for all websites!`);
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
