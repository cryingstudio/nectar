// scraper/runner.js
const {
  scrapeDomains,
  scrapeCoupons,
  saveToDatabase,
  log,
  logError,
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
    await log(
      "No letters specified. Please set LETTERS environment variable or pass as command argument.",
      "ERROR"
    );
    process.exit(1);
  }

  await log(
    `Starting partial scraper for letters: ${lettersToProcess.join(", ")}`
  );
  await log(`Using configuration: 
  - Concurrent domains: ${CONFIG.concurrentDomains}
  - Batch size: ${CONFIG.batchSize}
  - Domain retries: ${CONFIG.domainRetries}
  - Delays between domains: ${CONFIG.delayBetweenDomains}ms`);

  let totalSuccessCount = 0;
  let totalErrorCount = 0;
  let startTime = Date.now();

  // Process only the specified letters
  for (const letter of lettersToProcess) {
    const letterStartTime = Date.now();
    await log(`-------------------------------------------`);
    await log(`Starting to process domains for letter: ${letter}`);

    // Get all domains for this letter
    const domains = await scrapeDomains(letter);

    if (domains.length === 0) {
      await log(`No domains found for letter ${letter}, skipping...`, "WARN");
      continue;
    }

    await log(
      `Found ${domains.length} domains for letter ${letter}, starting to scrape coupons...`
    );

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
              return { success: true, domain, couponCount: coupons.length };
            } else {
              await log(`No coupons found for ${domain}`, "WARN");
              await log(`Completed processing for domain: ${domain}`);
              return { success: false, domain, couponCount: 0 };
            }
          } catch (error) {
            logError(`Failed to process domain: ${domain}`, error);
            return { success: false, domain, couponCount: 0 };
          }
        })
      );

      // Count successes and failures
      results.forEach(async (result) => {
        if (result.success) {
          letterSuccessCount++;
          totalSuccessCount++;
          await log(
            `Successfully saved ${result.couponCount} coupons for ${result.domain}`
          );
        } else {
          letterErrorCount++;
          totalErrorCount++;
        }
      });

      // Check if we're approaching GitHub's time limit (50 minutes)
      const timeElapsed = (Date.now() - startTime) / 1000 / 60; // in minutes
      if (timeElapsed > 50) {
        await log(
          `Approaching GitHub Actions time limit (${timeElapsed.toFixed(
            1
          )} minutes elapsed). Stopping early.`,
          "WARN"
        );
        break;
      }

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

    const letterTimeElapsed = (
      (Date.now() - letterStartTime) /
      1000 /
      60
    ).toFixed(1);
    await log(
      `Letter ${letter} completed in ${letterTimeElapsed} minutes: ${letterSuccessCount} successes, ${letterErrorCount} failures`
    );

    // Add a longer delay between letters to avoid being detected as a bot
    if (lettersToProcess.indexOf(letter) < lettersToProcess.length - 1) {
      const delayBetweenLetters = CONFIG.delayBetweenDomains * 2; // Twice the domain delay
      await log(`Waiting ${delayBetweenLetters}ms before next letter...`);
      await new Promise((resolve) => setTimeout(resolve, delayBetweenLetters));

      // Check again for time limits after the delay
      const timeElapsed = (Date.now() - startTime) / 1000 / 60; // in minutes
      if (timeElapsed > 50) {
        await log(
          `Approaching GitHub Actions time limit (${timeElapsed.toFixed(
            1
          )} minutes elapsed). Stopping early.`,
          "WARN"
        );
        break;
      }
    }
  }

  const totalTimeElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  await log(`----------------------------------------`);
  await log(
    `Partial scraping completed for letters: ${lettersToProcess.join(", ")}`
  );
  await log(`Total execution time: ${totalTimeElapsed} minutes`);
  await log(`Successfully processed: ${totalSuccessCount} domains`);
  await log(`Failed to process: ${totalErrorCount} domains`);

  // Exit with error code if all domains failed
  if (totalSuccessCount === 0 && totalErrorCount > 0) {
    await log("All domains failed to process", "ERROR");
    process.exit(1);
  }
}

// Export function for testing or programmatic use
module.exports = { runPartialScraper };

// Only run if called directly
if (require.main === module) {
  runPartialScraper().catch((error) => {
    logError("Fatal error in runner", error);
    process.exit(1);
  });
}
