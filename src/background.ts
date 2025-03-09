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

const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 1 day in milliseconds

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

// Listen for messages from the popup and content script
browser.runtime.onMessage.addListener((message: any, sender: any) => {
  if (message.action === "scrapeCoupons") {
    const domain = message.domain;

    // Check local storage for cached data
    return getCachedCoupons(domain)
      .then((cachedData) => {
        if (cachedData) {
          return { success: true, coupons: cachedData.coupons };
        } else {
          // Fetch coupon data using a headless browser tab
          return fetchCouponsWithBrowserAPI(domain)
            .then((coupons) => {
              // Cache the results
              cacheCoupons(domain, coupons);
              return { success: true, coupons };
            })
            .catch((error) => {
              console.error("Error fetching coupons:", error);
              return { success: false, error: error.message };
            });
        }
      })
      .catch((error) => {
        console.error("Error checking cache:", error);
        // On cache error, just try to fetch new data
        return fetchCouponsWithBrowserAPI(domain)
          .then((coupons) => {
            // Try to cache again
            cacheCoupons(domain, coupons);
            return { success: true, coupons };
          })
          .catch((error) => {
            console.error("Error fetching coupons:", error);
            return { success: false, error: error.message };
          });
      });
  }

  // New message handler for coupon input detection
  if (message.action === "couponInputDetected") {
    const url = sender.tab?.url || "";
    const domain = new URL(url).hostname;

    // Get coupons for this domain
    return getCachedCoupons(domain)
      .then(async (cachedData) => {
        let coupons: Coupon[] = [];

        if (cachedData) {
          coupons = cachedData.coupons;
        } else {
          try {
            coupons = await fetchCouponsWithBrowserAPI(domain);
            cacheCoupons(domain, coupons);
          } catch (error) {
            console.error("Error fetching coupons:", error);
            return { success: false, error: (error as Error).message };
          }
        }

        if (coupons.length === 0) {
          return {
            success: false,
            message: "No coupons found for this site",
          };
        }

        // Start the auto-apply process in the content script
        if (sender.tab?.id !== undefined) {
          browser.tabs.sendMessage(sender.tab.id, {
            action: "startCouponTesting",
            coupons: coupons,
          });
        }

        return { success: true, message: "Starting coupon testing" };
      })
      .catch((error) => {
        console.error("Error processing coupon auto-apply:", error);
        return { success: false, error: error.message };
      });
  }

  // Handle test results from content script
  if (message.action === "couponTestingComplete") {
    const results = message.results as ApplyResult[];
    const bestResult = results.reduce(
      (best, current) => {
        // If current has a higher savings, it's better
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

    if (bestResult.success && sender.tab?.id !== undefined) {
      // Send message to content script to apply the best coupon
      browser.tabs.sendMessage(sender.tab.id, {
        action: "applyBestCoupon",
        code: bestResult.code,
      });

      // Show a notification to the user
      browser.notifications.create({
        type: "basic",
        iconUrl: "icon128.png",
        title: "Nectar Coupon Finder",
        message: `Applied the best coupon: ${bestResult.code} (saved ${bestResult.savings})`,
      });
    } else {
      browser.notifications.create({
        type: "basic",
        iconUrl: "icon128.png",
        title: "Nectar Coupon Finder",
        message: "No working coupons found for this site.",
      });
    }

    return Promise.resolve({ success: true });
  }

  // For unhandled messages, return undefined or a rejected promise
  return undefined;
});

// Function to get cached coupons if they exist and are not expired
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

// Function to cache coupon data
function cacheCoupons(domain: string, coupons: Coupon[]): Promise<void> {
  const cacheKey = `nectar_coupons_${domain}`;
  const cachedData: CachedCouponData = {
    coupons,
    timestamp: Date.now(),
  };

  return browser.storage.local.set({ [cacheKey]: cachedData });
}

// Setup a periodic cleanup of expired caches
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

// Run cleanup on startup and periodically
browser.runtime.onStartup.addListener(() => {
  cleanupExpiredCaches();
});

// Also set up a periodic cleanup using alarms
browser.alarms.create("cleanupCache", { periodInMinutes: 24 * 60 }); // Once per day
browser.alarms.onAlarm.addListener((alarm: any) => {
  if (alarm.name === "cleanupCache") {
    cleanupExpiredCaches();
  }
});

async function fetchCouponsWithBrowserAPI(domain: string): Promise<Coupon[]> {
  try {
    const couponFollowUrl = `https://couponfollow.com/site/${domain}`;

    // First check if we have permissions
    const hasPermission = await browser.permissions.contains({
      origins: ["https://couponfollow.com/*"],
    });

    if (!hasPermission) {
      // Request permission if needed
      const granted = await browser.permissions.request({
        origins: ["https://couponfollow.com/*"],
      });

      if (!granted) {
        throw new Error("Permission denied for fetching coupons");
      }
    }

    // Create a new tab to load the page
    const tab = await createTabAsync(couponFollowUrl);

    // Wait a moment to ensure the tab is fully loaded
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Execute script in the tab to extract basic coupon data and modal URLs
    const { basicCoupons, modalUrls } = await extractBasicCouponDataFromTab(
      tab.id as number
    );

    // Process each coupon that has a modal to get the code
    const completeCoupons: Coupon[] = [];

    for (let i = 0; i < basicCoupons.length; i++) {
      const coupon = basicCoupons[i];

      // Check if this coupon has a modal URL to fetch the code
      if (modalUrls[i]) {
        try {
          // Navigate to the modal and get the code
          const code = await getCouponCodeFromModal(
            tab.id as number,
            modalUrls[i] as string
          );

          coupon.code = code;
        } catch (modalError) {
          console.error(
            `Error fetching code for coupon ${coupon.id}:`,
            modalError
          );
        }
      }

      completeCoupons.push(coupon);
    }

    // Close the tab when done
    await closeTabAsync(tab.id as number);

    return completeCoupons;
  } catch (error: any) {
    console.error("Error in fetchCouponsWithBrowserAPI:", error);
    throw error;
  }
}

// Helper function to create a new tab
function createTabAsync(url: string): Promise<browser.Tabs.Tab> {
  return browser.tabs.create({ url, active: false });
}

// Helper function to close a tab
function closeTabAsync(tabId: number): Promise<void> {
  return browser.tabs.remove(tabId);
}

// Function to extract basic coupon data and modal URLs from the tab
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
    } as { basicCoupons: Coupon[]; modalUrls: (string | null)[] };
  }

  return results[0].result as {
    basicCoupons: Coupon[];
    modalUrls: (string | null)[];
  };
}

async function getCouponCodeFromModal(
  tabId: number,
  modalUrl: string
): Promise<string> {
  // Extract the coupon ID from the URL
  const couponId = modalUrl.split("#")[1];

  if (!couponId) {
    return "AUTOMATIC";
  }

  // Try a direct modal URL approach
  const possibleDirectUrls = [modalUrl];

  // Try each URL until we find one that works
  for (const url of possibleDirectUrls) {
    // Navigate to the URL
    await navigateTabAsync(tabId, url);
    await refreshTabAsync(tabId);

    // Check if we can find a code on this page
    const extractCodeScript = () => {
      // Based on your screenshot, try very specific selectors first
      const specificSelectors = [
        "input#code.input.code",
        "input.input.code",
        "#coupon-modal input",
        "[data-select-code]",
        "input[value^='BOOT']", // Looking specifically for BOOTS20 like in screenshot
        "input[value]", // Any input with a value
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

    // Execute the extraction script
    const code = await executeScriptInTab(tabId, extractCodeScript);

    if (code) {
      return code;
    }
  }

  // If we still can't find the code, try one more approach:
  await navigateTabAsync(tabId, `https://couponfollow.com/site/amazon.co.uk`);

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

  const dataCode = await executeScriptInTab(tabId, extractDataScript);
  if (dataCode) {
    return dataCode;
  }

  // If nothing works, return AUTOMATIC
  return "AUTOMATIC";
}

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
    }, 1000);
  });
}

// Helper function to execute scripts in the tab and return results
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

// Enhanced navigation function
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
