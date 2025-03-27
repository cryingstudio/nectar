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

interface ExtensionSettings {
  defaultSource: string;
  enableNotifications: boolean;
  refreshInterval: number;
  autoApplyCoupons: boolean;
  saveToDatabase: boolean;
  customSources: {
    id: string;
    name: string;
    baseUrl: string;
  }[];
}

export default function NectarExtension() {
  const [currentSite, setCurrentSite] = useState("");
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Default settings
  const [settings, setSettings] = useState<ExtensionSettings>({
    defaultSource: "CouponFollow",
    enableNotifications: true,
    refreshInterval: 24,
    autoApplyCoupons: false,
    saveToDatabase: true,
    customSources: [],
  });

  useEffect(() => {
    // Load settings from storage
    chrome.storage.sync.get(["nectarSettings"], (result) => {
      if (result.nectarSettings) {
        setSettings(result.nectarSettings);
      }
    });

    const getCurrentSiteAndCoupons = async () => {
      try {
        setLoading(true);
        setError(null);

        // Get the current tab information
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

          // Message the background script to fetch the coupons
          chrome.runtime.sendMessage(
            {
              action: "scrapeCoupons",
              domain,
              // Pass settings to background script
              settings: {
                defaultSource: settings.defaultSource,
                saveToDatabase: settings.saveToDatabase,
              },
            },
            (response) => {
              if (chrome.runtime.lastError) {
                console.error("Runtime error:", chrome.runtime.lastError);
                setError(
                  "Failed to communicate with the extension. Please try again."
                );
                setLoading(false);
                return;
              }

              if (response && response.success) {
                setCoupons(response.coupons);
              } else {
                setError(response?.error || "Failed to fetch coupons");
                setCoupons([]);
              }

              setLoading(false);
            }
          );
        } else {
          setError("Could not determine the current website");
          setLoading(false);
        }
      } catch (error: any) {
        console.error("Error in getCurrentSiteAndCoupons:", error);
        setError(error.message || "An unknown error occurred");
        setLoading(false);
      }
    };

    getCurrentSiteAndCoupons();
  }, [settings.defaultSource, settings.saveToDatabase]);

  const handleCopy = (code: string) => {
    console.log("Copying coupon code:", code);
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  return (
    <Card className="border border-neutral-800 bg-neutral-900 shadow-xl overflow-hidden w-[350px] rounded-3xl">
      <div className="pl-4 pr-4 flex items-center justify-between">
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold text-white flex items-center">
            Nectar
            <Badge className="ml-2 bg-amber-700 text-white hover:bg-amber-800">
              Beta
            </Badge>
          </h1>
          <p className="text-sm text-neutral-400 pt-1">
            Finding the best deals for{" "}
            {currentSite ? <b>{currentSite}</b> : "this site"}
          </p>
        </div>
      </div>

      <Separator className="bg-neutral-800" />

      <div className="pl-4 bg-neutral-900 text-neutral-400 text-sm">
        {loading
          ? "Searching for coupons..."
          : error
          ? "Could not load coupons"
          : `${coupons.length} coupons found for this site`}
      </div>

      <CardContent className="p-0">
        <div className="max-h-[350px] overflow-y-auto custom-scrollbar">
          {loading ? (
            <div className="p-4 text-center text-neutral-400">
              <div className="animate-pulse">Loading coupons...</div>
            </div>
          ) : error ? (
            <div className="p-4 text-center text-red-400">
              <p>{error}</p>
              <p className="text-sm mt-2">Please try again later</p>
            </div>
          ) : coupons.length === 0 ? (
            <div className="p-4 text-center text-neutral-400">
              No coupons found for this site
            </div>
          ) : (
            coupons.map((coupon, index) => (
              <div
                key={coupon.id}
                className={`p-4 border-b border-neutral-800 hover:bg-neutral-800/50 ${
                  index === 0 ? "border-t border-neutral-800" : ""
                }`}
              >
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-center">
                    <span className="text-sm font-bold text-white bg-neutral-800 px-3 py-2 rounded">
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
                    className="border-amber-600 bg-neutral-900 text-amber-400 hover:bg-amber-600/40"
                    onClick={() => handleCopy(coupon.code)}
                  >
                    {copiedCode === coupon.code ? (
                      <div className="flex items-center">
                        <Check className="h-4 w-4 mr-1" />
                        <span>Copied</span>
                      </div>
                    ) : (
                      <div className="flex items-center">
                        <Copy className="h-4 w-4 mr-1" />
                        <span>Copy</span>
                      </div>
                    )}
                  </Button>
                </div>
                <p className="font-medium text-amber-400">{coupon.discount}</p>
                <p className="text-sm text-neutral-400 mt-1">{coupon.terms}</p>
              </div>
            ))
          )}
        </div>
      </CardContent>

      <div className="pl-4 bg-neutral-900 text-neutral-500 text-xs">
        Last updated: {new Date().toLocaleDateString()}
      </div>
    </Card>
  );
}
