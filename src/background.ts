import browser from "webextension-polyfill";

interface Coupon {
  id: number;
  code: string;
  discount: string;
  terms: string;
  verified: boolean;
  source?: string;
}

interface ApplyResult {
  code: string;
  success: boolean;
  savings: number | null;
  error?: string;
}

interface CouponSource {
  name: string;
  baseUrl: string;
  siteUrl: (domain: string) => string;
  extractBasicCouponData: (tabId: number) => Promise<{
    basicCoupons: Coupon[];
    modalUrls: (string | null)[];
  }>;
  getCouponCodeFromModal: (tabId: number, modalUrl: string) => Promise<string>;
  permissionOrigins: string[];
}

// API configuration
const API_BASE_URL = "https://nectar-db.vercel.app/api"; // Replace with your Vercel URL

// Define CouponFollow as a source
const couponFollowSource: CouponSource = {
  name: "CouponFollow",
  baseUrl: "https://couponfollow.com",
  siteUrl: (domain: string) => `https://couponfollow.com/site/${domain}`,
  permissionOrigins: ["https://couponfollow.com/*"],

  extractBasicCouponData: async (tabId: number) => {
    const extractionScript = () => {
      const basicCoupons: any[] = [];
      const modalUrls: (string | null)[] = [];
      let idCounter = 1;

      const couponElements = document.querySelectorAll(
        ".offer-card.regular-offer"
      );

      couponElements.forEach((element: Element) => {
        // Check if it's a coupon with a code
        const dataType = element.getAttribute("data-type");

        // Only process elements with data-type === "coupon"
        if (dataType === "coupon") {
          const discountEl = element.querySelector(".offer-title");
          const termsEl = element.querySelector(".offer-description");

          const discount = discountEl?.textContent?.trim() || "Discount";
          const terms = termsEl?.textContent?.trim() || "Terms apply";
          const verified = element.getAttribute("data-is-verified") === "True";

          // Default code
          let code = "AUTOMATIC";
          let modalUrl = null;

          // Look for a code element directly in the DOM
          const codeEl = element.querySelector(".coupon-code");
          if (codeEl) {
            code = codeEl.textContent?.trim() || code;
          } else {
            // Get the modal URL for later processing
            modalUrl = element.getAttribute("data-modal");
          }

          basicCoupons.push({
            id: idCounter++,
            code,
            discount,
            terms,
            verified,
            source: "CouponFollow",
          });

          modalUrls.push(modalUrl);
        }
      });

      return { basicCoupons, modalUrls };
    };

    // Execute the script in the tab
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: extractionScript,
    });

    if (!results || results.length === 0) {
      return {
        basicCoupons: [],
        modalUrls: [],
      };
    }

    return results[0].result as {
      basicCoupons: Coupon[];
      modalUrls: (string | null)[];
    };
  },

  getCouponCodeFromModal: async (tabId: number, modalUrl: string) => {
    // Extract the coupon ID from the URL
    const couponId = modalUrl.split("#")[1];

    if (!couponId) {
      return "AUTOMATIC";
    }

    // Navigate to the URL
    await navigateTabAsync(tabId, modalUrl);
    await refreshTabAsync(tabId);

    // Try to find the code
    const code = await extractCouponCodeFromPage(tabId);

    if (code) {
      return code;
    }

    // If not found, try an alternative approach
    await navigateTabAsync(tabId, `https://couponfollow.com/site/amazon.co.uk`);
    const dataCode = await extractCouponDataFromPage(tabId, couponId);

    return dataCode || "AUTOMATIC";
  },
};

// Collection of all sources
const couponSources: CouponSource[] = [couponFollowSource];

// Define a default source
let defaultSource = couponFollowSource;

// Extension initialization and content script registration
browser.runtime.onInstalled.addListener(() => {
  console.log("Nectar extension installed!");
  browser.scripting
    .registerContentScripts([
      {
        id: "coupon-detector",
        matches: ["<all_urls>"],
        js: ["content-script.js"],
        runAt: "document_end",
      },
    ])
    .catch((err) => console.error("Error registering content script:", err));
});

// Message handler
browser.runtime.onMessage.addListener((message: any, sender: any) => {
  switch (message.action) {
    case "scrapeCoupons":
      return handleScrapeCoupons(message.domain, message.source);
    case "couponInputDetected":
      return handleCouponInputDetected(sender);
    case "couponTestingComplete":
      return handleCouponTestingComplete(message, sender);
    case "setDefaultSource":
      return handleSetDefaultSource(message.sourceName);
    default:
      return undefined;
  }
});

// Handle setting the default coupon source
function handleSetDefaultSource(sourceName: string) {
  const source = couponSources.find((s) => s.name === sourceName);
  if (source) {
    defaultSource = source;
    return { success: true, message: `Default source set to ${sourceName}` };
  }
  return { success: false, message: `Source '${sourceName}' not found` };
}

// Modified to use Supabase via Vercel API and support multiple sources
async function handleScrapeCoupons(domain: string, sourceName?: string) {
  try {
    // Determine which source to use
    const source = sourceName
      ? couponSources.find((s) => s.name === sourceName) || defaultSource
      : defaultSource;

    // Fetch coupons from API first
    const response = await fetch(
      `${API_BASE_URL}/coupons?domain=${encodeURIComponent(domain)}`
    );
    if (!response.ok) throw new Error("Failed to fetch coupons");
    const { coupons } = await response.json();

    if (coupons.length > 0) {
      return { success: true, coupons };
    } else {
      // Scrape and store
      const newCoupons = await fetchCouponsWithBrowserAPI(domain, source);
      const storeResponse = await fetch(`${API_BASE_URL}/coupons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, coupons: newCoupons }),
      });
      if (!storeResponse.ok) throw new Error("Failed to store coupons");
      return { success: true, coupons: newCoupons };
    }
  } catch (error) {
    console.error("Error handling scrape coupons:", error);
    return { success: false, error: (error as Error).message };
  }
}

// Modified to use API
async function handleCouponInputDetected(sender: any) {
  try {
    if (!sender.tab?.url) throw new Error("No URL provided");
    const domain = new URL(sender.tab.url).hostname;

    // Fetch coupons from API
    const response = await fetch(
      `${API_BASE_URL}/coupons?domain=${encodeURIComponent(domain)}`
    );
    if (!response.ok) throw new Error("Failed to fetch coupons");
    const { coupons } = await response.json();

    if (coupons.length === 0) {
      return { success: false, message: "No coupons found for this site" };
    }

    if (sender.tab?.id !== undefined) {
      await browser.tabs.sendMessage(sender.tab.id, {
        action: "startCouponTesting",
        coupons,
      });
    }
    return { success: true, message: "Starting coupon testing" };
  } catch (error) {
    console.error("Error processing auto-apply:", error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Handle coupon testing results from content script
 */
async function handleCouponTestingComplete(message: any, sender: any) {
  try {
    const results = message.results as ApplyResult[];
    const bestResult = findBestCouponResult(results);

    if (bestResult.success && sender.tab?.id !== undefined) {
      // Apply the best coupon
      await browser.tabs.sendMessage(sender.tab.id, {
        action: "applyBestCoupon",
        code: bestResult.code,
      });

      // Show success notification
      await showNotification({
        title: "Nectar",
        message: `Applied the best coupon: ${bestResult.code} (saved ${bestResult.savings})`,
      });
    } else {
      // Show failure notification
      await showNotification({
        title: "Nectar",
        message: "No working coupons found for this site.",
      });
    }

    return { success: true };
  } catch (error) {
    console.error("Error handling coupon testing complete:", error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Find the best coupon result from all tested coupons
 */
function findBestCouponResult(results: ApplyResult[]): ApplyResult {
  return results.reduce(
    (best, current) => {
      if (current.success && current.savings !== null) {
        if (
          !best.success ||
          best.savings === null ||
          current.savings > best.savings
        ) {
          return current;
        }
      }
      return best;
    },
    { success: false, savings: null, code: "" } as ApplyResult
  );
}

/**
 * Show a notification to the user
 */
async function showNotification({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return browser.notifications.create({
    type: "basic",
    iconUrl: "icon128.png",
    title,
    message,
  });
}

/**
 * Fetch coupons for a domain using the browser API
 */
async function fetchCouponsWithBrowserAPI(
  domain: string,
  source: CouponSource
): Promise<Coupon[]> {
  try {
    const couponUrl = source.siteUrl(domain);

    // Request permission if needed
    const hasPermission = await ensureCouponSitePermission(
      source.permissionOrigins
    );
    if (!hasPermission) {
      throw new Error(
        `Permission denied for fetching coupons from ${source.name}`
      );
    }

    // Create a new tab to load the page
    const tab = await createTabAsync(couponUrl);

    // Wait for page load
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Extract coupon data
    const { basicCoupons, modalUrls } = await source.extractBasicCouponData(
      tab.id as number
    );

    // Process each coupon to get the code
    const completeCoupons = await processCoupons(
      tab.id as number,
      basicCoupons,
      modalUrls,
      source
    );

    // Close the tab when done
    await closeTabAsync(tab.id as number);

    return completeCoupons;
  } catch (error) {
    console.error(
      `Error in fetchCouponsWithBrowserAPI for ${source.name}:`,
      error
    );
    throw error;
  }
}

/**
 * Ensure we have permission to access the coupon site
 */
async function ensureCouponSitePermission(origins: string[]): Promise<boolean> {
  const hasPermission = await browser.permissions.contains({
    origins,
  });

  if (!hasPermission) {
    return browser.permissions.request({
      origins,
    });
  }

  return true;
}

/**
 * Process coupons to get their codes
 */
async function processCoupons(
  tabId: number,
  basicCoupons: Coupon[],
  modalUrls: (string | null)[],
  source: CouponSource
): Promise<Coupon[]> {
  const completeCoupons = [...basicCoupons];
  const batchSize = 5; // Process this many coupons in parallel

  // Create additional tabs for parallel processing
  const tabs: number[] = [tabId];
  for (let i = 1; i < batchSize; i++) {
    const newTab = await createTabAsync("about:blank");
    tabs.push(newTab.id as number);
  }

  try {
    // Process in batches
    for (let i = 0; i < basicCoupons.length; i += batchSize) {
      const batch = [];

      // Create promises for this batch
      for (let j = 0; j < batchSize && i + j < basicCoupons.length; j++) {
        const couponIndex = i + j;
        if (modalUrls[couponIndex]) {
          batch.push(
            source
              .getCouponCodeFromModal(tabs[j], modalUrls[couponIndex] as string)
              .then((code) => {
                completeCoupons[couponIndex] = {
                  ...completeCoupons[couponIndex],
                  code,
                };
              })
              .catch((error) => {
                console.error(
                  `Error fetching code for coupon ${completeCoupons[couponIndex].id}:`,
                  error
                );
              })
          );
        }
      }

      // Wait for this batch to complete before starting next batch
      await Promise.all(batch);
    }

    return completeCoupons;
  } finally {
    // Clean up the extra tabs we created
    for (let i = 1; i < tabs.length; i++) {
      try {
        await closeTabAsync(tabs[i]);
      } catch (e) {
        console.error("Error closing tab:", e);
      }
    }
  }
}

/**
 * Extract coupon code from the current page
 */
async function extractCouponCodeFromPage(
  tabId: number
): Promise<string | null> {
  const extractCodeScript = () => {
    // Try various selectors
    const specificSelectors = [
      "input#code.input.code",
      "input.input.code",
      "#coupon-modal input",
      "[data-select-code]",
      "input[value^='BOOT']",
      "input[value]",
    ];

    // Try the specific selectors first
    for (const selector of specificSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        const value = (element as HTMLInputElement).value.trim();
        return value;
      }
    }

    // If that doesn't work, analyze the whole page for any inputs
    const allInputs = document.querySelectorAll("input");

    for (const input of allInputs) {
      if (input.value) {
        // If it looks like a coupon code (uppercase letters/numbers)
        if (/^[A-Z0-9]+$/.test(input.value.trim())) {
          return input.value.trim();
        }
      }
    }
    return null;
  };

  return executeScriptInTab(tabId, extractCodeScript);
}

/**
 * Extract coupon data from the page based on coupon ID
 */
async function extractCouponDataFromPage(
  tabId: number,
  couponId: string
): Promise<string | null> {
  const extractDataScript = () => {
    // Look for any data attributes that might contain our coupon ID
    const couponElements = document.querySelectorAll(
      `[data-id="${couponId}"], [data-coupon-id="${couponId}"]`
    );

    for (const element of couponElements) {
      // Check for data attributes that might contain the code
      const possibleCodeAttrs = ["data-code", "data-coupon-code", "data-value"];
      for (const attr of possibleCodeAttrs) {
        const code = element.getAttribute(attr);
        if (code) {
          return code;
        }
      }

      // Check for a code inside the element
      const codeElement = element.querySelector(".coupon-code, .code");
      if (codeElement) {
        const code = codeElement.textContent?.trim();
        if (code) {
          return code;
        }
      }
    }

    return null;
  };

  return executeScriptInTab(tabId, extractDataScript);
}

// Utility functions

/**
 * Create a new tab
 */
function createTabAsync(url: string): Promise<browser.Tabs.Tab> {
  return browser.tabs.create({ url, active: false });
}

/**
 * Close a tab
 */
function closeTabAsync(tabId: number): Promise<void> {
  return browser.tabs.remove(tabId);
}

/**
 * Refresh a tab and wait for it to complete
 */
async function refreshTabAsync(tabId: number): Promise<void> {
  await browser.tabs.reload(tabId);

  return new Promise<void>((resolve) => {
    const onUpdated = (
      updatedTabId: number,
      changeInfo: browser.Tabs.OnUpdatedChangeInfoType
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        browser.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };

    browser.tabs.onUpdated.addListener(onUpdated);

    // Set a timeout in case the onUpdated event never fires with "complete"
    setTimeout(() => {
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 500);
  });
}

/**
 * Execute a script in a tab
 */
async function executeScriptInTab<T>(tabId: number, func: () => T): Promise<T> {
  const results = await browser.scripting.executeScript({
    target: { tabId },
    func,
  });

  if (!results || results.length === 0) {
    return null as unknown as T;
  }

  return results[0].result as T;
}

/**
 * Navigate a tab to a URL and wait for it to complete
 */
async function navigateTabAsync(tabId: number, url: string): Promise<void> {
  await browser.tabs.update(tabId, { url });

  return new Promise<void>((resolve) => {
    const onUpdated = (
      updatedTabId: number,
      changeInfo: browser.Tabs.OnUpdatedChangeInfoType
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        browser.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };

    browser.tabs.onUpdated.addListener(onUpdated);

    // Set a timeout in case the onUpdated event never fires with "complete"
    setTimeout(() => {
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 500);
  });
}

// Example of how to add a new coupon source
/*
function addCouponSource(newSource: CouponSource): boolean {
  // Check if source already exists
  if (couponSources.some(source => source.name === newSource.name)) {
    return false;
  }
  
  couponSources.push(newSource);
  return true;
}
*/
