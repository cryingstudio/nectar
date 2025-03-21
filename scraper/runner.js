// scraper/runner.js
const {
  scrapeDomains,
  scrapeCoupons,
  saveToDatabase,
  CONFIG,
} = require("./scraper");

/**
 * Run partial scraper for a specific set of letters
 * This allows splitting the workload across multiple GitHub Actions
 */
async function runPartialScraper() {
  // Get letters from environment variable or command line args
  const lettersToProcess = process.env.LETTERS
    ? process.env.LETTERS.split(",")
    : process.argv.length > 2
    ? process.argv[2].split(",")
    : [];

  if (lettersToProcess.length === 0) {
    process.exit(1);
  }

  let totalSuccessCount = 0;
  let totalErrorCount = 0;
  let startTime = Date.now();

  // Process only the specified letters
  for (const letter of lettersToProcess) {
    const letterStartTime = Date.now();

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
              return { success: true, domain, couponCount: coupons.length };
            } else {
              return { success: false, domain, couponCount: 0 };
            }
          } catch (error) {
            return { success: false, domain, couponCount: 0 };
          }
        })
      );

      // Count successes and failures
      results.forEach(async (result) => {
        if (result.success) {
          letterSuccessCount++;
          totalSuccessCount++;
        } else {
          letterErrorCount++;
          totalErrorCount++;
        }
      });
    }

    // Add a delay between batches to avoid overloading resources
    if (i + CONFIG.concurrentDomains < domains.length) {
      await new Promise((resolve) =>
        setTimeout(resolve, CONFIG.delayBetweenDomains)
      );
    }
  }

  const letterTimeElapsed = (
    (Date.now() - letterStartTime) /
    1000 /
    60
  ).toFixed(1);

  // Add a longer delay between letters to avoid being detected as a bot
  if (lettersToProcess.indexOf(letter) < lettersToProcess.length - 1) {
    const delayBetweenLetters = CONFIG.delayBetweenDomains; // Twice the domain delay
    await new Promise((resolve) => setTimeout(resolve, delayBetweenLetters));
  }
}

const totalTimeElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

// Exit with error code if all domains failed
if (totalSuccessCount === 0 && totalErrorCount > 0) {
  process.exit(1);
}

// Export function for testing or programmatic use
module.exports = { runPartialScraper };

// Only run if called directly
if (require.main === module) {
  runPartialScraper().catch((error) => {
    process.exit(1);
  });
}
