import type { EnvironmentId, ServerSettingsPatch, UnifiedSettings } from "@t3tools/contracts";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Keeps API-key drafts local until an explicit save to the selected environment. */
export function JevSettings({
  environmentId,
  settings,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings["jev"];
  readonly readOnly: boolean;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, "Jev settings update");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const configured = settings.apiKey.length > 0;
  const disabled = readOnly || saving;
  const save = async (patch: NonNullable<ServerSettingsPatch["jev"]>, message: string) => {
    if (disabled) return;
    setSaving(true);
    setStatus(null);
    try {
      const result = await update({ environmentId, input: { patch: { jev: patch } } });
      if (result._tag === "Success") {
        setKey("");
        setStatus(message);
      } else {
        setStatus("Could not save Jev settings. Try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      {...searchableSetting("jev-mode")}
      description="Let coding agents use TypeSafe's Jev model for choices, scores, and yes/no judgments."
    >
      <SettingsRow
        title="Enable Jev mode"
        description="Agent evaluations send the supplied context to TypeSafe and use your API quota. Start a new agent session after enabling. Turning it off blocks further evaluations."
        control={
          <Switch
            aria-label="Enable Jev mode"
            checked={settings.enabled}
            disabled={disabled || (!configured && !settings.enabled)}
            onCheckedChange={(enabled) =>
              void save(
                { enabled },
                enabled
                  ? "Jev mode enabled. Start a new agent session to use it."
                  : "Jev mode disabled.",
              )
            }
          />
        }
      />
      <SettingsRow
        title="TypeSafe API key"
        description={
          configured
            ? "A key is saved on this server. Enter a new key to replace it."
            : "Save your key to enable Jev. It stays on this server."
        }
        control={
          <form
            className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
            onSubmit={(event) => {
              event.preventDefault();
              if (key.trim()) void save({ apiKey: key.trim() }, "API key saved.");
            }}
          >
            <Input
              aria-label="TypeSafe API key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 sm:w-52"
              placeholder={configured ? "Replace saved key" : "Enter API key"}
              value={key}
              maxLength={4096}
              disabled={disabled}
              onChange={(event) => setKey(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={disabled || !key.trim()}>
              {saving ? "Saving…" : "Save key"}
            </Button>
            {configured ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void save(
                    { apiKey: "", enabled: false },
                    "API key removed and Jev mode disabled.",
                  )
                }
              >
                Remove key
              </Button>
            ) : null}
          </form>
        }
      />
      {status ? (
        <p role="status" className="px-4 pb-3 text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
    </SettingsSection>
  );
}
