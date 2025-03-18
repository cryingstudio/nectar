"use client";

import { useState } from "react";
import { Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SettingsProps {
  onClose: () => void;
  onSave: (settings: ExtensionSettings) => void;
  currentSettings: ExtensionSettings;
}

interface ExtensionSettings {
  defaultSource: string;
  enableNotifications: boolean;
  refreshInterval: number;
  autoApplyCoupons: boolean;
  saveToDatabase: boolean;
  customSources: CustomSource[];
}

interface CustomSource {
  id: string;
  name: string;
  baseUrl: string;
}

export function SettingsMenu({
  onClose,
  onSave,
  currentSettings,
}: SettingsProps) {
  const [settings, setSettings] = useState<ExtensionSettings>(currentSettings);

  const handleSaveSettings = () => {
    onSave(settings);
    onClose();
  };

  return (
    <Card className="border border-neutral-800 bg-neutral-900 shadow-xl overflow-hidden w-[350px] rounded-3xl">
      <div className="pl-4 pr-4 flex items-center justify-between">
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold text-white flex items-center">
            Settings
          </h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="text-neutral-400 hover:text-white hover:bg-neutral-800"
          onClick={onClose}
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <Separator className="bg-neutral-800" />

      <CardContent className="">
        <div className="max-h-[350px] overflow-y-auto custom-scrollbar space-y-5">
          {/* General Settings */}
          <div>
            <h3 className="text-sm font-medium text-amber-400 mb-3">General</h3>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-white">Default Source</Label>
                  <p className="text-xs text-neutral-400">
                    Select your preferred coupon source
                  </p>
                </div>
                <Select
                  value={settings.defaultSource}
                  onValueChange={(value: any) =>
                    setSettings({ ...settings, defaultSource: value })
                  }
                >
                  <SelectTrigger className="w-32 bg-neutral-800 border-neutral-700">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-neutral-800 border-neutral-700">
                    <SelectItem value="CouponFollow">CouponFollow</SelectItem>
                    {settings.customSources.map((source) => (
                      <SelectItem key={source.id} value={source.name}>
                        {source.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-white">Notifications</Label>
                  <p className="text-xs text-neutral-400">
                    Show notifications for new coupons
                  </p>
                </div>
                <Switch
                  checked={settings.enableNotifications}
                  onCheckedChange={(checked: any) =>
                    setSettings({ ...settings, enableNotifications: checked })
                  }
                  className="data-[state=checked]:bg-amber-600 data-[state=unchecked]:bg-neutral-400"
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-white">Save to Database</Label>
                  <p className="text-xs text-neutral-400">
                    Contribute coupons to help other users
                  </p>
                </div>
                <Switch
                  checked={settings.saveToDatabase}
                  onCheckedChange={(checked: any) =>
                    setSettings({ ...settings, saveToDatabase: checked })
                  }
                  className="data-[state=checked]:bg-amber-600 data-[state=unchecked]:bg-neutral-400"
                />
              </div>
            </div>
          </div>
        </div>

        <Separator className="bg-neutral-800" />

        <div className="flex justify-end pr-4">
          <Button
            variant="outline"
            className="border-amber-600 bg-neutral-900 text-amber-400 hover:bg-amber-600/40"
            onClick={handleSaveSettings}
          >
            <Save className="h-4 w-4 mr-2" />
            Save Settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
