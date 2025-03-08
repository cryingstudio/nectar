// content.ts
interface Coupon {
  title: string;
  code: string;
  link: string;
}

// This is stringified and injected, so it can't access variables from this scope directly
async function scrapeCoupons(): Promise<Coupon[]> {
  console.log("scrapeCoupons function is running");

  return new Promise(async (resolve, reject) => {
    try {
      // Retrieve the couponFollowUrl from the page
      const couponFollowUrl = (window as any).couponFollowUrl;

      if (!couponFollowUrl) {
        reject("couponFollowUrl not found on the page");
        return;
      }

      const response = await fetch(couponFollowUrl);
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      const html = await response.text();

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      const coupons: Coupon[] = [];
      const couponElements = doc.querySelectorAll(".offer-card.regular-offer"); // Inspect CouponFollow's HTML

      for (const element of couponElements) {
        console.log("Found coupon element:", element);

        const title =
          element.querySelector(".offer-title")?.textContent || "No Title";
        let code = "No Code";
        let linkElement = element.querySelector(".link.details-link");
        let link =
          linkElement instanceof HTMLAnchorElement ? linkElement.href : "#";

        // Check if data-show-as-coupon is "True"
        const showAsCoupon = element.getAttribute("data-show-as-coupon");
        if (showAsCoupon === "True") {
          // Extract the modal URL
          const modalUrl = element.getAttribute("data-modal");
          if (modalUrl) {
            // Fetch the modal page
            const couponPageResponse = await fetch(modalUrl);
            if (couponPageResponse.ok) {
              const couponPageHtml = await couponPageResponse.text();
              const couponPageDoc = parser.parseFromString(
                couponPageHtml,
                "text/html"
              );

              // Extract the coupon code from the input field
              const codeElement = couponPageDoc.querySelector("input.code");
              if (codeElement) {
                code =
                  (codeElement as HTMLInputElement).value?.trim() || "No Code";
              }
            } else {
              console.error(
                "Error fetching coupon page:",
                couponPageResponse.status
              );
            }
          }
        }

        coupons.push({ title: title, code: code, link: link });
      }

      console.log("Scraped coupons:", coupons);
      console.log("scrapeCoupons function is resolving with coupons:", coupons);
      return resolve(coupons); // Resolve with the coupons array
    } catch (error: any) {
      console.error("Error scraping coupons:", error);
      reject(error.message);
    }
  });
}

// Make scrapeCoupons available in the window object
declare global {
  interface Window {
    scrapeCoupons: () => Promise<Coupon[]>;
  }
}

window.scrapeCoupons = scrapeCoupons;

// Export something to make this a module.
export {};
