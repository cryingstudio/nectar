"use client";

import { useState, useEffect } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

interface Coupon {
  id: number;
  code: string;
  discount: string;
  terms: string;
  verified: boolean;
}

export default function NectarExtension() {
  const [currentSite, setCurrentSite] = useState("");
  const [coupons, setCoupons] = useState<Coupon[]>([]); // Initialize as empty array
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    const getCurrentSite = async () => {
      try {
        const tabs = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        const currentTab = tabs[0];
        if (currentTab && currentTab.url) {
          const currentUrl = new URL(currentTab.url);
          let domain = currentUrl.hostname;
          domain = domain.replace(/^www\./, "");
          setCurrentSite(domain);

          // Construct the CouponFollow search URL
          const couponFollowUrl = `https://couponfollow.com/site/${domain}`;

          // Inject the couponFollowUrl into the page
          chrome.scripting.executeScript({
            target: { tabId: currentTab.id || 0 },
            func: (url) => {
              (window as any).couponFollowUrl = url;
            },
            args: [couponFollowUrl],
          });

          // Execute the content script to get the coupons
          chrome.scripting
            .executeScript({
              target: { tabId: currentTab.id || 0 }, // Ensure tabId is not undefined
              files: ["content.js"], // Use files instead of func
            })
            .then((result) => {
              console.log("Result from executeScript:", result);
              // The result is an array of arrays.  We only care about the first result.
              if (result && result.length > 0 && Array.isArray(result[0])) {
                setCoupons(result[0] as Coupon[]);
              } else {
                console.warn("No coupons found or invalid result:", result);
                setCoupons([]); // Ensure coupons is an empty array
              }
            })
            .catch((error) => {
              console.error("Error executing script:", error);
              setCoupons([]); // Ensure coupons is an empty array
            });
        }
      } catch (error) {
        console.error("Error getting current site:", error);
      }
    };

    getCurrentSite();
  }, []);

  const handleCopy = (id: number, code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <Card className="border border-neutral-800 bg-neutral-900 shadow-xl overflow-hidden w-[350px] rounded-3xl">
      <div className="pl-4 flex items-center justify-between">
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold text-white flex items-center">
            Nectar
            <Badge className="ml-2 bg-amber-700 text-white hover:bg-amber-800">
              Beta
            </Badge>
          </h1>
          <p className="text-sm text-neutral-400 pt-1">
            Finding the best deals for {<b>{currentSite}</b>}
          </p>
        </div>
      </div>

      <Separator className="bg-neutral-800" />

      <div className="pl-4 bg-neutral-900 text-neutral-400 text-sm">
        {coupons.length} coupons found for this site
      </div>

      <CardContent className="p-0">
        <div className="max-h-[350px] overflow-y-auto custom-scrollbar">
          {coupons.map((coupon, index) => (
            <div
              key={coupon.id}
              className={`p-4 border-b border-neutral-800 hover:bg-neutral-800/50 ${
                index === 0 ? "border-t border-neutral-800" : ""
              }`}
            >
              <div className="flex justify-between items-center mb-2">
                <div className="flex items-center">
                  <span className="text-sm font-mono font-bold text-white bg-neutral-800 px-3 py-2 rounded">
                    {coupon.code}
                  </span>
                  {coupon.verified && (
                    <Badge className="ml-2 bg-green-900 text-green-300 hover:bg-green-900">
                      Verified
                    </Badge>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className={`border-amber-600 bg-neutral-900 text-amber-400 hover:bg-amber-600/40 ${
                    copiedId === coupon.id ? "bg-amber-600/30" : ""
                  }`}
                  onClick={() => handleCopy(coupon.id, coupon.code)}
                >
                  {copiedId === coupon.id ? (
                    <>
                      <Check className="h-4 w-4 mr-1" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-1" /> Copy
                    </>
                  )}
                </Button>
              </div>
              <p className="font-medium text-amber-400">{coupon.discount}</p>
              <p className="text-sm text-neutral-400 mt-1">{coupon.terms}</p>
            </div>
          ))}
        </div>
      </CardContent>

      <div className="pl-4 bg-neutral-900 text-neutral-500 text-xs">
        Last updated: {new Date().toLocaleDateString()}
      </div>
    </Card>
  );
}
