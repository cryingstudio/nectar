import browser from "webextension-polyfill";

interface Coupon {
  id: number;
  code: string;
  discount: string;
  terms: string;
  verified: boolean;
  source?: string;
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

const allowSavingToDatabase = false;

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

        if (dataType !== "coupon") {
          return;
        }

        // Only process elements with data-type === "coupon"
        const discountEl = element.querySelector(".offer-title");
        const termsEl = element.querySelector(".offer-description");

        const discount = discountEl?.textContent?.trim() || "Discount";
        const terms = termsEl?.textContent?.trim() || "Terms apply";
        const verified = element.getAttribute("data-is-verified") === "True";

        // Default code
        let code = "AUTOMATIC";
        let modalUrl = element.getAttribute("data-modal");

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
    // Navigate to the URL
    await navigateTabAsync(tabId, modalUrl);
    await refreshTabAsync(tabId);

    // Try to find the code
    const code = await extractCouponCodeFromPage(tabId);

    if (!code) {
      return "AUTOMATIC";
    }

    return code;
  },
};

// Collection of all sources
const couponSources: CouponSource[] = [couponFollowSource];

// Define a default source
let defaultSource = couponSources[0];

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
browser.runtime.onMessage.addListener((message: any) => {
  switch (message.action) {
    case "scrapeCoupons":
      return handleScrapeCoupons(message.domain);
    default:
      return undefined;
  }
});

// Modified to use Supabase via Vercel API and support multiple sources
async function handleScrapeCoupons(domain: string) {
  try {
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
      const newCoupons = await fetchCouponsWithBrowserAPI(
        domain,
        defaultSource
      );

      if (allowSavingToDatabase) {
        const storeResponse = await fetch(`${API_BASE_URL}/coupons`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain, coupons: newCoupons }),
        });

        if (!storeResponse.ok) throw new Error("Failed to store coupons");
      }

      return { success: true, coupons: newCoupons };
    }
  } catch (error) {
    console.error("Error handling scrape coupons:", error);
    return { success: false, error: (error as Error).message };
  }
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
 * ?? NEEDS REFACTORING
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
): Promise<string | undefined> {
  const extractCodeScript = () => {
    // Try various selectors
    const specificSelectors = ["input#code.input.code", "input.input.code"];

    // Try the specific selectors first
    for (const selector of specificSelectors) {
      const element = document.querySelector(selector);
      if (!element) {
        continue;
      }

      const value = (element as HTMLInputElement).value.trim();
      return value;
    }
  };

  return executeScriptInTab(tabId, extractCodeScript);
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
      if (!isTabLoaded(updatedTabId, changeInfo, tabId)) {
        return;
      }

      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve();
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
      if (!isTabLoaded(updatedTabId, changeInfo, tabId)) {
        return;
      }

      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    browser.tabs.onUpdated.addListener(onUpdated);

    // Set a timeout in case the onUpdated event never fires with "complete"
    setTimeout(() => {
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 500);
  });
}

function isTabLoaded(
  updatedTabId: number,
  changeInfo: browser.Tabs.OnUpdatedChangeInfoType,
  tabId: number
): boolean {
  return updatedTabId === tabId && changeInfo.status === "complete";
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
