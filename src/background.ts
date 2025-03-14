import browser from "webextension-polyfill";

interface Coupon {
  id: number;
  code: string;
  discount: string;
  terms: string;
  verified: boolean;
}

interface CachedCouponData {
  coupons: Coupon[];
  timestamp: number;
}

interface ApplyResult {
  code: string;
  success: boolean;
  savings: number | null;
  error?: string;
}

// Constants
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 1 day in milliseconds
const COUPON_SOURCE_URL = "https://couponfollow.com/site/";

/**
 * Extension initialization
 */
browser.runtime.onInstalled.addListener(() => {
  console.log("Nectar extension installed!");

  // Register content script to detect coupon inputs
  browser.scripting
    .registerContentScripts([
      {
        id: "coupon-detector",
        matches: ["<all_urls>"],
        js: ["content-script.js"],
        runAt: "document_end",
      },
    ])
    .catch((err: any) =>
      console.error("Error registering content script:", err)
    );
});

/**
 * Message handler for all extension communication
 */
browser.runtime.onMessage.addListener((message: any, sender: any) => {
  switch (message.action) {
    case "scrapeCoupons":
      return handleScrapeCoupons(message.domain);

    case "couponInputDetected":
      return handleCouponInputDetected(sender);

    case "couponTestingComplete":
      return handleCouponTestingComplete(message, sender);

    default:
      return undefined;
  }
});

/**
 * Handle scraping coupons for a domain
 */
async function handleScrapeCoupons(domain: string) {
  try {
    // Check local storage for cached data
    const cachedData = await getCachedCoupons(domain);

    if (cachedData) {
      return { success: true, coupons: cachedData.coupons };
    } else {
      // Fetch coupon data
      const coupons = await fetchCouponsWithBrowserAPI(domain);
      // Cache the results
      await cacheCoupons(domain, coupons);
      return { success: true, coupons };
    }
  } catch (error) {
    console.error("Error handling scrape coupons:", error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Handle coupon input detection from content script
 */
async function handleCouponInputDetected(sender: any) {
  try {
    if (!sender.tab?.url) {
      throw new Error("No URL provided");
    }

    const url = new URL(sender.tab.url);
    const domain = url.hostname;

    // Get coupons for this domain
    let coupons: Coupon[] = [];
    const cachedData = await getCachedCoupons(domain);

    if (cachedData) {
      coupons = cachedData.coupons;
    } else {
      coupons = await fetchCouponsWithBrowserAPI(domain);
      await cacheCoupons(domain, coupons);
    }

    if (coupons.length === 0) {
      return { success: false, message: "No coupons found for this site" };
    }

    // Start the auto-apply process in the content script
    if (sender.tab?.id !== undefined) {
      await browser.tabs.sendMessage(sender.tab.id, {
        action: "startCouponTesting",
        coupons: coupons,
      });
    }

    return { success: true, message: "Starting coupon testing" };
  } catch (error) {
    console.error("Error processing coupon auto-apply:", error);
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
        title: "Nectar Coupon Finder",
        message: `Applied the best coupon: ${bestResult.code} (saved ${bestResult.savings})`,
      });
    } else {
      // Show failure notification
      await showNotification({
        title: "Nectar Coupon Finder",
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
 * Get cached coupons if they exist and are not expired
 */
async function getCachedCoupons(
  domain: string
): Promise<CachedCouponData | null> {
  const cacheKey = `nectar_coupons_${domain}`;
  const result = await browser.storage.local.get([cacheKey]);
  const cachedData = result[cacheKey] as CachedCouponData;

  if (!cachedData) {
    return null;
  }

  const now = Date.now();
  const cacheAge = now - cachedData.timestamp;

  // Check if cache is expired
  if (cacheAge > CACHE_DURATION_MS) {
    // Remove expired cache
    await browser.storage.local.remove(cacheKey);
    return null;
  } else {
    return cachedData;
  }
}

/**
 * Cache coupon data
 */
async function cacheCoupons(domain: string, coupons: Coupon[]): Promise<void> {
  const cacheKey = `nectar_coupons_${domain}`;
  const cachedData: CachedCouponData = {
    coupons,
    timestamp: Date.now(),
  };

  return browser.storage.local.set({ [cacheKey]: cachedData });
}

/**
 * Cleanup expired caches
 */
async function cleanupExpiredCaches(): Promise<void> {
  const items = await browser.storage.local.get();
  const now = Date.now();
  const keysToRemove: string[] = [];

  // Check all keys that start with our prefix
  for (const key in items) {
    if (key.startsWith("nectar_coupons_")) {
      const cachedData = items[key] as CachedCouponData;
      const cacheAge = now - cachedData.timestamp;

      if (cacheAge > CACHE_DURATION_MS) {
        keysToRemove.push(key);
      }
    }
  }

  // Remove expired keys
  if (keysToRemove.length > 0) {
    await browser.storage.local.remove(keysToRemove);
  }
}

// Run cleanup on startup
browser.runtime.onStartup.addListener(() => {
  cleanupExpiredCaches();
});

// Set up a periodic cleanup using alarms
browser.alarms.create("cleanupCache", { periodInMinutes: 24 * 60 }); // Once per day
browser.alarms.onAlarm.addListener((alarm: any) => {
  if (alarm.name === "cleanupCache") {
    cleanupExpiredCaches();
  }
});

/**
 * Fetch coupons for a domain using the browser API
 */
async function fetchCouponsWithBrowserAPI(domain: string): Promise<Coupon[]> {
  try {
    const couponUrl = `${COUPON_SOURCE_URL}${domain}`;

    // Request permission if needed
    const hasPermission = await ensureCouponSitePermission();
    if (!hasPermission) {
      throw new Error("Permission denied for fetching coupons");
    }

    // Create a new tab to load the page
    const tab = await createTabAsync(couponUrl);

    // Wait for page load
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Extract coupon data
    const { basicCoupons, modalUrls } = await extractBasicCouponDataFromTab(
      tab.id as number
    );

    // Process each coupon to get the code
    const completeCoupons = await processCoupons(
      tab.id as number,
      basicCoupons,
      modalUrls
    );

    // Close the tab when done
    await closeTabAsync(tab.id as number);

    return completeCoupons;
  } catch (error) {
    console.error("Error in fetchCouponsWithBrowserAPI:", error);
    throw error;
  }
}

/**
 * Ensure we have permission to access the coupon site
 */
async function ensureCouponSitePermission(): Promise<boolean> {
  const hasPermission = await browser.permissions.contains({
    origins: ["https://couponfollow.com/*"],
  });

  if (!hasPermission) {
    return browser.permissions.request({
      origins: ["https://couponfollow.com/*"],
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
  modalUrls: (string | null)[]
): Promise<Coupon[]> {
  const couponPromises = basicCoupons.map(async (coupon, i) => {
    if (modalUrls[i]) {
      try {
        const code = await getCouponCodeFromModal(tabId, modalUrls[i]);
        return { ...coupon, code };
      } catch (error) {
        console.error(`Error fetching code for coupon ${coupon.id}:`, error);
      }
    }
    return coupon;
  });

  return Promise.all(couponPromises);
}

/**
 * Extract basic coupon data from the coupon page
 */
async function extractBasicCouponDataFromTab(tabId: number): Promise<{
  basicCoupons: Coupon[];
  modalUrls: (string | null)[];
}> {
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
}

/**
 * Get coupon code from a modal
 */
async function getCouponCodeFromModal(
  tabId: number,
  modalUrl: string
): Promise<string> {
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
