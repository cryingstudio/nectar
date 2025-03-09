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

const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 1 day in milliseconds

chrome.runtime.onInstalled.addListener(() => {
  console.log("Nectar extension installed!");
});

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "scrapeCoupons") {
    const domain = message.domain;

    // Check local storage for cached data
    getCachedCoupons(domain)
      .then((cachedData) => {
        if (cachedData) {
          sendResponse({ success: true, coupons: cachedData.coupons });
        } else {
          // Fetch coupon data using a headless Chrome tab
          fetchCouponsWithChromeAPI(domain)
            .then((coupons) => {
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
            // Try to cache again
            cacheCoupons(domain, coupons);
            sendResponse({ success: true, coupons });
          })
          .catch((error) => {
            console.error("Error fetching coupons:", error);
            sendResponse({ success: false, error: error.message });
          });
      });

    // Return true to indicate we'll send an async response
    return true;
  }
});

// Function to get cached coupons if they exist and are not expired
async function getCachedCoupons(
  domain: string
): Promise<CachedCouponData | null> {
  return new Promise((resolve) => {
    const cacheKey = `nectar_coupons_${domain}`;
    chrome.storage.local.get([cacheKey], (result) => {
      const cachedData = result[cacheKey] as CachedCouponData;

      if (!cachedData) {
        resolve(null);
        return;
      }

      const now = Date.now();
      const cacheAge = now - cachedData.timestamp;

      // Check if cache is expired
      if (cacheAge > CACHE_DURATION_MS) {
        // Remove expired cache
        chrome.storage.local.remove(cacheKey);
        resolve(null);
      } else {
        resolve(cachedData);
      }
    });
  });
}

// Function to cache coupon data
function cacheCoupons(domain: string, coupons: Coupon[]): void {
  const cacheKey = `nectar_coupons_${domain}`;
  const cachedData: CachedCouponData = {
    coupons,
    timestamp: Date.now(),
  };

  chrome.storage.local.set({ [cacheKey]: cachedData });
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
      chrome.storage.local.remove(keysToRemove);
    }
  });
}

// Run cleanup on startup and periodically
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

function refreshTabAsync(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, {}, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      // Set a timeout in case the onUpdated event never fires with "complete"
      const timeout = setTimeout(() => {
        resolve();
      }, 1000);

      // Listen for the tab to complete loading
      chrome.tabs.onUpdated.addListener(function listener(
        updatedTabId,
        changeInfo
      ) {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
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
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!results || results.length === 0) {
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
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, (_tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      // Set a timeout in case the onUpdated event never fires with "complete"
      const timeout = setTimeout(() => {
        resolve();
      }, 500);

      // Listen for the tab to complete loading
      chrome.tabs.onUpdated.addListener(function listener(
        updatedTabId,
        changeInfo
      ) {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  });
}
