// Define interfaces
interface Coupon {
  id: number;
  code: string;
  discount: string;
  terms: string;
  verified: boolean;
}

interface ApplyResult {
  code: string;
  success: boolean;
  savings: number | null;
  error?: string;
}

// Common coupon input field selectors
const COUPON_INPUT_SELECTORS = [
  'input[id*="coupon" i]',
  'input[name*="coupon" i]',
  'input[id*="promo" i]',
  'input[name*="promo" i]',
  'input[id*="discount" i]',
  'input[name*="ppw-claimCode" i]',
  'input[placeholder*="coupon" i]',
  'input[placeholder*="promo" i]',
  'input[placeholder*="discount" i]',
  'input[aria-label*="coupon" i]',
  'input[aria-label*="promo" i]',
  'input[aria-label*="discount" i]',
];

// Common submit button selectors
const SUBMIT_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  "button:not([type])",
  'button[id*="apply" i]',
  'button[name*="ppw-claimCode" i]',
  'button[id*="coupon" i]',
  'button[id*="promo" i]',
  'button[class*="apply" i]',
  'button[class*="coupon" i]',
  'button[class*="promo" i]',
  'a[id*="apply" i]',
  'a[id*="coupon" i]',
  'a[id*="promo" i]',
  'a[class*="apply" i]',
  'a[class*="coupon" i]',
  'a[class*="promo" i]',
];

// Common success indicators
const SUCCESS_INDICATORS = [
  ".success-message",
  ".discount-applied",
  ".coupon-applied",
  '[class*="success" i]',
  '[class*="discount-applied" i]',
  '[class*="coupon-applied" i]',
  '[id*="success" i]',
  '[id*="discount-applied" i]',
  '[id*="coupon-applied" i]',
];

// Common error indicators
const ERROR_INDICATORS = [
  ".error-message",
  ".coupon-error",
  '[class*="error" i]',
  '[class*="invalid-coupon" i]',
  '[id*="error" i]',
  '[id*="invalid-coupon" i]',
];

// Common price selectors
const PRICE_SELECTORS = [
  '[class*="total" i]',
  '[class*="price" i]',
  '[class*="cost" i]',
  '[id*="total" i]',
  '[id*="price" i]',
  '[id*="cost" i]',
];

// Store original price before applying coupons
let originalPrice: number | null = null;

// Main initialization function
function initialize() {
  // Find all possible coupon input fields on the page
  const couponInputs = findCouponInputs();

  if (couponInputs.length === 0) {
    return; // No coupon fields found
  }

  // Add click event listeners to all coupon inputs
  couponInputs.forEach((input) => {
    input.addEventListener("click", handleCouponInputClick);
    input.addEventListener("focus", handleCouponInputClick);
  });

  console.log(
    "Nectar: Initialized coupon auto-apply on",
    window.location.hostname
  );
}

// Find all coupon input fields on the page
function findCouponInputs(): HTMLInputElement[] {
  const inputs: HTMLInputElement[] = [];

  COUPON_INPUT_SELECTORS.forEach((selector) => {
    document.querySelectorAll<HTMLInputElement>(selector).forEach((input) => {
      // Only add text inputs
      if (
        input.type === "text" ||
        input.type === "search" ||
        input.type === ""
      ) {
        inputs.push(input);
      }
    });
  });

  return inputs;
}

// Handle when user clicks on a coupon input field
function handleCouponInputClick(event: Event) {
  const input = event.target as HTMLInputElement;

  // Only trigger once per page load
  if (input.dataset.nectarProcessed === "true") {
    return;
  }

  input.dataset.nectarProcessed = "true";

  // Show a visual indicator that we're about to test coupons
  showNotification("Nectar is finding the best coupon for you...");

  // Store submit button for later
  const submitButton = findSubmitButton(input);

  // Store the input field for later use
  (window as any).nectarCouponInput = input;
  (window as any).nectarSubmitButton = submitButton;

  // Notify background script that we've detected a coupon input
  chrome.runtime.sendMessage({
    action: "couponInputDetected",
  });

  // Record the original price before applying any coupons
  captureOriginalPrice();
}

// Find the submit button for this coupon field
function findSubmitButton(input: HTMLInputElement): HTMLElement | null {
  // First try to find the closest form and get its submit button
  const form = input.closest("form");
  if (form) {
    // Try standard submit button inside the form
    const submitButton = Array.from(SUBMIT_BUTTON_SELECTORS)
      .map((selector) => form.querySelector<HTMLElement>(selector))
      .find((button) => button !== null);

    if (submitButton) {
      return submitButton;
    }
  }

  // If no form or no submit in form, look for buttons near the input
  let currentElement: HTMLElement | null = input;

  // Look for nearby elements, up to 5 levels up
  for (let i = 0; i < 5 && currentElement; i++) {
    // Look for siblings first
    if (currentElement.parentElement) {
      const siblings: Element[] = Array.from(
        currentElement.parentElement.children
      );

      for (const sibling of siblings) {
        if (sibling === currentElement) continue;

        // Check if this sibling is a button or contains a button
        for (const selector of SUBMIT_BUTTON_SELECTORS) {
          if (sibling.matches(selector)) {
            return sibling as HTMLElement;
          }

          const nestedButton = sibling.querySelector<HTMLElement>(selector);
          if (nestedButton) {
            return nestedButton;
          }
        }
      }
    }

    // Move up to parent
    currentElement = currentElement.parentElement;
  }

  // Last resort: find any button that looks like a submit
  for (const selector of SUBMIT_BUTTON_SELECTORS) {
    const buttons = document.querySelectorAll<HTMLElement>(selector);

    // Find the closest button to the input
    if (buttons.length > 0) {
      let closestButton: HTMLElement | null = null;
      let minDistance = Number.MAX_SAFE_INTEGER;

      const inputRect = input.getBoundingClientRect();
      const inputCenter = {
        x: inputRect.left + inputRect.width / 2,
        y: inputRect.top + inputRect.height / 2,
      };

      buttons.forEach((button) => {
        const buttonRect = button.getBoundingClientRect();
        const buttonCenter = {
          x: buttonRect.left + buttonRect.width / 2,
          y: buttonRect.top + buttonRect.height / 2,
        };

        const distance = Math.sqrt(
          Math.pow(inputCenter.x - buttonCenter.x, 2) +
            Math.pow(inputCenter.y - buttonCenter.y, 2)
        );

        if (distance < minDistance) {
          minDistance = distance;
          closestButton = button;
        }
      });

      if (closestButton && minDistance < 500) {
        // Only use if reasonably close
        return closestButton;
      }
    }
  }

  return null;
}

// Find and store the original price
function captureOriginalPrice() {
  for (const selector of PRICE_SELECTORS) {
    const elements = document.querySelectorAll(selector);

    for (const element of elements) {
      const text = element.textContent || "";
      const priceMatch = text.match(/\$?(\d+(?:\.\d{1,2})?)/);

      if (priceMatch && priceMatch[1]) {
        const price = parseFloat(priceMatch[1]);
        if (!isNaN(price) && price > 0) {
          originalPrice = price;
          console.log("Nectar: Captured original price", originalPrice);
          return;
        }
      }
    }
  }
}

// Begin testing coupons
async function testCoupons(coupons: Coupon[]): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  const input = (window as any).nectarCouponInput as HTMLInputElement;
  const submitButton = (window as any).nectarSubmitButton as HTMLElement;

  if (!input || !submitButton) {
    return results;
  }

  // Process only verified coupons first, and limit to a reasonable number
  const prioritizedCoupons = coupons
    .sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0))
    .slice(0, 10); // Limit to 10 coupons to avoid too much processing

  for (const coupon of prioritizedCoupons) {
    if (coupon.code === "AUTOMATIC") {
      continue; // Skip automatic coupons as they don't require a code
    }

    try {
      // Update UI
      showNotification(`Testing coupon: ${coupon.code}`);

      // Fill in the coupon code
      input.value = coupon.code;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      // Small delay to let the site process the input
      await delay(300);

      // Click the submit button
      submitButton.click();

      // Wait for the result
      await delay(2000);

      // Check if coupon was applied successfully
      const isSuccess = checkForSuccessIndicators();
      const isError = checkForErrorIndicators();

      let savings: number | null = null;

      if (isSuccess) {
        // Try to calculate savings
        savings = calculateSavings();
      }

      results.push({
        code: coupon.code,
        success: isSuccess && !isError,
        savings: savings,
        error: isError ? "Coupon error" : undefined,
      });
    } catch (error) {
      console.error(`Nectar: Error testing coupon ${coupon.code}:`, error);
      results.push({
        code: coupon.code,
        success: false,
        savings: null,
        error: (error as Error).message,
      });
    }
  }

  return results;
}

// Check if there are success indicators on the page
function checkForSuccessIndicators(): boolean {
  for (const selector of SUCCESS_INDICATORS) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      return true;
    }
  }

  // Also check for changes in the total price
  return checkForPriceChanges();
}

// Check if there are error indicators on the page
function checkForErrorIndicators(): boolean {
  for (const selector of ERROR_INDICATORS) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      if (element.textContent && element.textContent.trim() !== "") {
        // Only count visible error messages
        const style = window.getComputedStyle(element);
        if (style.display !== "none" && style.visibility !== "hidden") {
          return true;
        }
      }
    }
  }

  return false;
}

// Check if the price has changed after applying the coupon
function checkForPriceChanges(): boolean {
  if (originalPrice === null) {
    return false;
  }

  for (const selector of PRICE_SELECTORS) {
    const elements = document.querySelectorAll(selector);

    for (const element of elements) {
      const text = element.textContent || "";
      const priceMatch = text.match(/\$?(\d+(?:\.\d{1,2})?)/);

      if (priceMatch && priceMatch[1]) {
        const currentPrice = parseFloat(priceMatch[1]);
        if (!isNaN(currentPrice) && currentPrice < originalPrice) {
          return true;
        }
      }
    }
  }

  return false;
}

// Calculate the savings after applying a coupon
function calculateSavings(): number | null {
  if (originalPrice === null) {
    return null;
  }

  let lowestCurrentPrice: number | null = null;

  for (const selector of PRICE_SELECTORS) {
    const elements = document.querySelectorAll(selector);

    for (const element of elements) {
      const text = element.textContent || "";
      const priceMatch = text.match(/\$?(\d+(?:\.\d{1,2})?)/);

      if (priceMatch && priceMatch[1]) {
        const currentPrice = parseFloat(priceMatch[1]);
        if (!isNaN(currentPrice) && currentPrice > 0) {
          if (
            lowestCurrentPrice === null ||
            currentPrice < lowestCurrentPrice
          ) {
            lowestCurrentPrice = currentPrice;
          }
        }
      }
    }
  }

  if (lowestCurrentPrice !== null && lowestCurrentPrice < originalPrice) {
    return originalPrice - lowestCurrentPrice;
  }

  return null;
}

// Create and show notification to the user
function showNotification(message: string) {
  // Remove any existing notification
  const existingNotification = document.getElementById("nectar-notification");
  if (existingNotification) {
    existingNotification.remove();
  }

  // Create new notification element
  const notification = document.createElement("div");
  notification.id = "nectar-notification";
  notification.style.position = "fixed";
  notification.style.bottom = "20px";
  notification.style.right = "20px";
  notification.style.backgroundColor = "#f07377"; // Nectar color
  notification.style.color = "white";
  notification.style.padding = "10px 20px";
  notification.style.borderRadius = "5px";
  notification.style.boxShadow = "0 2px 10px rgba(0, 0, 0, 0.2)";
  notification.style.zIndex = "9999";
  notification.style.fontFamily = "Arial, sans-serif";
  notification.style.fontSize = "14px";
  notification.style.maxWidth = "300px";

  notification.textContent = message;

  document.body.appendChild(notification);

  // Remove notification after some time
  setTimeout(() => {
    notification.remove();
  }, 5000);
}

// Utility function for delay
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Apply best coupon
function applyBestCoupon(code: string) {
  const input = (window as any).nectarCouponInput as HTMLInputElement;
  const submitButton = (window as any).nectarSubmitButton as HTMLElement;

  if (!input || !submitButton) {
    return;
  }

  // Fill in the coupon code
  input.value = code;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  // Click the submit button
  submitButton.click();

  // Show success message
  showNotification(`Applied coupon: ${code}`);
}

// Message handler from background script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "startCouponTesting") {
    const coupons = message.coupons as Coupon[];

    // Start testing coupons
    testCoupons(coupons).then((results) => {
      // Send results back to background script
      chrome.runtime.sendMessage({
        action: "couponTestingComplete",
        results: results,
      });
    });

    sendResponse({ success: true });
    return true;
  }

  if (message.action === "applyBestCoupon") {
    applyBestCoupon(message.code);
    sendResponse({ success: true });
    return true;
  }
});

// Initialize when the page is fully loaded
if (document.readyState === "complete") {
  initialize();
} else {
  window.addEventListener("load", initialize);
}
