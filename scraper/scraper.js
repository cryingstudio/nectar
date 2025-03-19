const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// List of domains to scrape
const domains = [
  "amazon.com",
  "walmart.com",
  "target.com",
  "bestbuy.com",
  // Add more domains as needed
];

async function scrapeCoupons(domain) {
  console.log(`Scraping coupons for ${domain}...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`https://couponfollow.com/site/${domain}`, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Extract basic coupon data with modal URLs
    const { basicCoupons, modalUrls } = await page.evaluate(() => {
      const basicCoupons = [];
      const modalUrls = [];
      let idCounter = 1;

      const couponElements = document.querySelectorAll(
        ".offer-card.regular-offer"
      );

      couponElements.forEach((element) => {
        // Skip if not a coupon
        if (element.getAttribute("data-type") !== "coupon") return;

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

    console.log(
      `Found ${basicCoupons.length} basic coupons for ${domain}, processing modal URLs...`
    );

    // Process coupons with modal URLs to get the actual codes
    const completeCoupons = [...basicCoupons];

    // We'll process modals in batches to avoid opening too many pages at once
    const batchSize = 5;
    const modalPages = [];

    try {
      // Create a pool of pages for processing modals
      for (let i = 0; i < Math.min(batchSize, modalUrls.length); i++) {
        const modalPage = await browser.newPage();
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
                  // Navigate to the modal URL
                  await modalPage.goto(modalUrl, {
                    waitUntil: "networkidle2",
                    timeout: 30000,
                  });

                  // Extract the code from the modal
                  const code = await modalPage.evaluate(() => {
                    // Try various selectors similar to your background.ts
                    const specificSelectors = [
                      "input#code.input.code",
                      "input.input.code",
                    ];

                    // Try the specific selectors first
                    for (const selector of specificSelectors) {
                      const element = document.querySelector(selector);
                      if (!element) continue;

                      const value = element.value.trim();
                      if (value) return value;
                    }

                    return "AUTOMATIC"; // Default if no code found
                  });

                  // Update the coupon with the extracted code
                  if (code && code !== "AUTOMATIC") {
                    completeCoupons[couponIndex].code = code;
                    console.log(
                      `Found code ${code} for coupon ${couponIndex + 1}`
                    );
                  }
                } catch (error) {
                  console.error(
                    `Error processing modal for coupon ${couponIndex + 1}:`,
                    error.message
                  );
                }
              })()
            );
          }
        }

        // Wait for this batch to complete before starting the next batch
        await Promise.all(batch);
      }
    } finally {
      // Close all modal pages
      for (const modalPage of modalPages) {
        await modalPage.close().catch(console.error);
      }
    }

    console.log(
      `Completed processing ${completeCoupons.length} coupons for ${domain}`
    );
    return completeCoupons;
  } catch (error) {
    console.error(`Error scraping ${domain}:`, error);
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
    console.log(`No coupons to save for ${domain}`);
    return;
  }

  // Save to Supabase
  const { data, error } = await supabase.from("coupons").upsert(uniqueCoupons, {
    onConflict: ["domain", "code"],
    ignoreDuplicates: true,
  });

  if (error) {
    console.error(`Error saving coupons for ${domain}:`, error);
  } else {
    console.log(
      `Successfully saved ${uniqueCoupons.length} coupons for ${domain}`
    );
  }
}

async function main() {
  console.log("Starting coupon scraper...");

  for (const domain of domains) {
    const coupons = await scrapeCoupons(domain);
    await saveToDatabase(domain, coupons);

    // Add a small delay between domains to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log("Coupon scraping completed!");
}

main().catch(console.error);
