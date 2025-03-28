import browser from "webextension-polyfill";

const API_BASE_URL = "https://nectar-db.vercel.app/api";

browser.runtime.onMessage.addListener((message: any) => {
  switch (message.action) {
    case "scrapeCoupons":
      return handleScrapeCoupons(message.domain);
    default:
      return undefined;
  }
});

async function handleScrapeCoupons(domain: string) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/coupons?domain=${encodeURIComponent(domain)}`
    );

    if (!response.ok) throw new Error("Failed to fetch coupons");

    const { coupons } = await response.json();

    if (coupons.length > 0) {
      return { success: true, coupons };
    } else {
      return { success: false, error: "No coupons found" };
    }
  } catch (error) {
    console.error("Error handling scrape coupons:", error);
    return { success: false, error: (error as Error).message };
  }
}
