import parse from "node-html-parser";

interface Coupon {
  id: number;
  code: string;
  discount: string;
  terms: string;
  verified: boolean;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("Nectar extension installed!");
});

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "scrapeCoupons") {
    const domain = message.domain;
    console.log("Background script scraping coupons for:", domain);

    // Fetch coupon data from couponfollow.com
    fetchCoupons(domain)
      .then((coupons) => {
        console.log("Coupons found:", coupons);
        sendResponse({ success: true, coupons });
      })
      .catch((error) => {
        console.error("Error fetching coupons:", error);
        sendResponse({ success: false, error: error.message });
      });

    // Return true to indicate we'll send an async response
    return true;
  }
});

async function fetchCoupons(domain: string): Promise<Coupon[]> {
  try {
    const couponFollowUrl = `https://couponfollow.com/site/${domain}`;
    console.log("Fetching from:", couponFollowUrl);

    const response = await fetch(couponFollowUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const html = await response.text();
    const doc = parse(html);

    const coupons: Coupon[] = [];
    const couponElements = doc.querySelectorAll(".offer-card.regular-offer");
    console.log(`Found ${couponElements.length} coupon elements`);

    let idCounter = 1;

    for (const element of couponElements) {
      const discount =
        element.querySelector(".offer-title")?.textContent?.trim() ||
        "Discount";
      const terms =
        element.querySelector(".offer-description")?.textContent?.trim() ||
        "Terms apply";

      // Default values
      let code = "AUTOMATIC";
      let verified = false;

      // Check for verified badge
      const verifiedBadge = element.querySelector('img[alt="Verified Coupon"]');
      if (verifiedBadge) {
        verified = true;
      }

      // Check if it's a coupon with a code
      const codeElement = element.querySelector(".code");
      if (codeElement) {
        code = codeElement.textContent.trim();
      }

      coupons.push({
        id: idCounter++,
        code,
        discount,
        terms,
        verified,
      });
    }

    return coupons;
  } catch (error: any) {
    console.error("Error in fetchCoupons:", error);
    throw error;
  }
}
