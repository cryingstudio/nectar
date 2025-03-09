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

const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 1 days in milliseconds

chrome.runtime.onInstalled.addListener(() => {
  console.log("Nectar extension installed!");
});

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "scrapeCoupons") {
    const domain = message.domain;
    console.log("Background script scraping coupons for:", domain);

    // Check local storage for cached data
    getCachedCoupons(domain)
      .then((cachedData) => {
        if (cachedData) {
          console.log("Using cached coupon data for:", domain);
          sendResponse({ success: true, coupons: cachedData.coupons });
        } else {
          // Fetch coupon data using a headless Chrome tab
          fetchCouponsWithChromeAPI(domain)
            .then((coupons) => {
              console.log("Coupons found:", coupons);
              // Cache the results
              cacheCoupons(domain, coupons);
              sendResponse({ success: true, coupons });
            })
            .catch((error) => {
              console.error("Error fetching coupons:", error);
              sendResponse({ success: false, error: error.message });
            });
        }
      })
      .catch((error) => {
        console.error("Error checking cache:", error);
        // On cache error, just try to fetch new data
        fetchCouponsWithChromeAPI(domain)
          .then((coupons) => {
            console.log("Coupons found after cache error:", coupons);
            // Try to cache again
            cacheCoupons(domain, coupons);
            sendResponse({ success: true, coupons });
          })
          .catch((error) => {
            console.error("Error fetching coupons:", error);
            sendResponse({ success: false, error: error.message });
          });
      });

    debugStorage();

    // Return true to indicate we'll send an async response
    return true;
  }
});

// Function to get cached coupons if they exist and are not expired
async function getCachedCoupons(
  domain: string
): Promise<CachedCouponData | null> {
  console.log(`Checking cache for domain: ${domain}`);
  return new Promise((resolve) => {
    const cacheKey = `nectar_coupons_${domain}`;
    console.log(`Using cache key: ${cacheKey}`);

    chrome.storage.local.get([cacheKey], (result) => {
      console.log(`Cache result:`, result);
      const cachedData = result[cacheKey] as CachedCouponData;

      if (!cachedData) {
        console.log("No cached data found for domain:", domain);
        resolve(null);
        return;
      }

      const now = Date.now();
      const cacheAge = now - cachedData.timestamp;
      console.log(`Cache age: ${cacheAge}ms, limit: ${CACHE_DURATION_MS}ms`);

      // Check if cache is expired (older than CACHE_DURATION_MS)
      if (cacheAge > CACHE_DURATION_MS) {
        console.log("Cached data is expired for domain:", domain);
        // Remove expired cache
        chrome.storage.local.remove(cacheKey, () => {
          console.log("Removed expired cache for domain:", domain);
        });
        resolve(null);
      } else {
        console.log(
          "Using cached data from",
          new Date(cachedData.timestamp).toLocaleString(),
          "with",
          cachedData.coupons.length,
          "coupons"
        );
        resolve(cachedData);
      }
    });
  });
}

function debugStorage() {
  chrome.storage.local.get(null, (items) => {
    console.log("Current storage items:", items);
  });
}

// Function to cache coupon data
function cacheCoupons(domain: string, coupons: Coupon[]): void {
  const cacheKey = `nectar_coupons_${domain}`;
  const cachedData: CachedCouponData = {
    coupons,
    timestamp: Date.now(),
  };

  chrome.storage.local.set({ [cacheKey]: cachedData }, () => {
    console.log("Cached coupon data for domain:", domain);
  });
}

// Setup a periodic cleanup of expired caches
function cleanupExpiredCaches(): void {
  chrome.storage.local.get(null, (items) => {
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
      chrome.storage.local.remove(keysToRemove, () => {
        console.log("Cleaned up", keysToRemove.length, "expired caches");
      });
    }
  });
}

// Run cleanup on startup and periodically (daily)
chrome.runtime.onStartup.addListener(() => {
  cleanupExpiredCaches();
});

// Also set up a periodic cleanup using alarms
chrome.alarms.create("cleanupCache", { periodInMinutes: 24 * 60 }); // Once per day
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cleanupCache") {
    cleanupExpiredCaches();
  }
});

async function fetchCouponsWithChromeAPI(domain: string): Promise<Coupon[]> {
  try {
    const couponFollowUrl = `https://couponfollow.com/site/${domain}`;
    console.log("Fetching from:", couponFollowUrl);

    // Create a new tab to load the page
    const tab = await createTabAsync(couponFollowUrl);

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
          // Get the full modal URL
          const modalUrl = modalUrls[i];
          if (modalUrl) {
            const fullModalUrl = new URL(modalUrl, "https://couponfollow.com")
              .href;
            console.log(
              `Fetching code for coupon ${coupon.id} from modal: ${fullModalUrl}`
            );
          }

          // Navigate to the modal and get the code
          const code = await getCouponCodeFromModal(
            tab.id as number,
            modalUrl as string
          );

          coupon.code = code;
          console.log(coupon.code);
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
    console.error("Error in fetchCouponsWithChromeAPI:", error);
    throw error;
  }
}

// Helper function to create a new tab
function createTabAsync(url: string): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(tab);
      }
    });
  });
}

// Helper function to close a tab
function closeTabAsync(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
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
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: extractionScript,
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!results || results.length === 0) {
          resolve({
            basicCoupons: [],
            modalUrls: [],
          } as { basicCoupons: Coupon[]; modalUrls: (string | null)[] });
        } else {
          resolve(
            results[0].result as {
              basicCoupons: Coupon[];
              modalUrls: (string | null)[];
            }
          );
        }
      }
    );
  });
}

async function getCouponCodeFromModal(
  tabId: number,
  modalUrl: string
): Promise<string> {
  console.log(`Getting coupon code from modal: ${modalUrl}`);

  // Extract the coupon ID from the URL
  const couponId = modalUrl.split("#")[1];
  console.log(`Extracted coupon ID: ${couponId}`);

  if (!couponId) {
    console.error("No coupon ID found in modal URL");
    return "AUTOMATIC";
  }

  // Try a direct modal URL approach instead
  // Many sites use a direct URL for modals, let's try various formats
  const possibleDirectUrls = [modalUrl];

  // Try each URL until we find one that works
  for (const url of possibleDirectUrls) {
    console.log(`Trying direct URL: ${url}`);

    // Navigate to the URL
    await navigateTabAsync(tabId, url);

    await refreshTabAsync(tabId);

    // Check if we can find a code on this page
    const extractCodeScript = () => {
      console.log("Looking for coupon code on page");

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
          console.log(`Found code with selector ${selector}: ${value}`);
          return value;
        }
      }

      // If that doesn't work, let's analyze the whole page for any inputs
      const allInputs = document.querySelectorAll("input");
      console.log(`Found ${allInputs.length} input elements on page`);

      for (const input of allInputs) {
        if (input.value) {
          console.log(`Input with value: ${input.value}`);
          // If it looks like a coupon code (uppercase letters/numbers)
          if (/^[A-Z0-9]+$/.test(input.value.trim())) {
            return input.value.trim();
          }
        }
      }

      // As a last resort, dump the entire page content to debug
      console.log("Page HTML:", document.documentElement.outerHTML);

      return null;
    };

    // Execute the extraction script
    const code = await executeScriptInTab(tabId, extractCodeScript);
    console.log(`Extracted code from ${url}: ${code}`);

    if (code) {
      return code;
    }
  }

  // If we still can't find the code, let's try one more approach:
  // Load the coupon page and look for API calls or data attributes
  console.log("Trying to find code in page data or API calls");

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
          console.log(`Found code in attribute ${attr}: ${code}`);
          return code;
        }
      }

      // Check for a code inside the element
      const codeElement = element.querySelector(".coupon-code, .code");
      if (codeElement) {
        const code = codeElement.textContent?.trim();
        if (code) {
          console.log(`Found code in element: ${code}`);
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

function refreshTabAsync(tabId: number): Promise<void> {
  console.log(`Refreshing tab ${tabId}`);

  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, {}, () => {
      if (chrome.runtime.lastError) {
        console.error("Refresh error:", chrome.runtime.lastError);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      console.log("Tab refresh initiated, waiting for complete load");

      // Set a timeout in case the onUpdated event never fires with "complete"
      const timeout = setTimeout(() => {
        console.log("Refresh timeout reached, proceeding anyway");
        resolve();
      }, 1000);

      // Listen for the tab to complete loading
      chrome.tabs.onUpdated.addListener(function listener(
        updatedTabId,
        changeInfo
      ) {
        if (updatedTabId === tabId) {
          console.log(`Tab refresh status: ${changeInfo.status}`);

          if (changeInfo.status === "complete") {
            console.log("Tab refresh complete");
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });
  });
}

// Helper function to execute scripts in the tab and return results
async function executeScriptInTab<T>(tabId: number, func: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func,
      },
      (results) => {
        if (chrome.runtime.lastError) {
          console.error("Script execution error:", chrome.runtime.lastError);
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!results || results.length === 0) {
          console.log("No results from execute script");
          resolve(null as unknown as T);
        } else {
          resolve(results[0].result as T);
        }
      }
    );
  });
}

// Enhanced navigation function
function navigateTabAsync(tabId: number, url: string): Promise<void> {
  console.log(`Navigating tab ${tabId} to ${url}`);

  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, (_tab) => {
      if (chrome.runtime.lastError) {
        console.error("Navigation error:", chrome.runtime.lastError);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      console.log("Tab update initiated, waiting for complete load");

      // Set a timeout in case the onUpdated event never fires with "complete"
      const timeout = setTimeout(() => {
        console.log("Navigation timeout reached, proceeding anyway");
        resolve();
      }, 500);

      // Listen for the tab to complete loading
      chrome.tabs.onUpdated.addListener(function listener(
        updatedTabId,
        changeInfo
      ) {
        if (updatedTabId === tabId) {
          console.log(`Tab update status: ${changeInfo.status}`);

          if (changeInfo.status === "complete") {
            console.log("Tab loading complete");
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });
  });
}
