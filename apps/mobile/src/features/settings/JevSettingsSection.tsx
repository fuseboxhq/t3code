import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/** Jev belongs to an environment; never copy its key or opt-in to other servers. */
export function JevSettingsSection() {
  const { environments } = useEnvironments();
  return environments.flatMap((environment) => {
    const config = environment.serverConfig;
    if (!config?.environment.capabilities.jev) return [];
    return [
      <EnvironmentJevSettings
        key={environment.environmentId}
        environment={environment}
        settings={config.settings.jev}
      />,
    ];
  });
}

/** Editing requires a connected environment and a session allowed to change its settings. */
function canEditJevSettings(
  environment: EnvironmentPresentation,
  session: AuthSessionState | null,
) {
  return (
    environment.connection.phase === "connected" &&
    session?.authenticated === true &&
    session.scopes?.includes(AuthOrchestrationOperateScope) === true
  );
}

/** Keeps a pending key draft out of shared client state and clears it only after saving. */
function useJevSettingsEditor(environment: EnvironmentPresentation) {
  const session = useAtomValue(environmentSession.sessionStateValueAtom(environment.environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, "Jev settings update");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const disabled = saving || !canEditJevSettings(environment, session);
  const save = async (patch: NonNullable<ServerSettingsPatch["jev"]>, message: string) => {
    if (disabled) return;
    setSaving(true);
    setStatus(null);
    try {
      const result = await update({
        environmentId: environment.environmentId,
        input: { patch: { jev: patch } },
      });
      if (result._tag === "Success") {
        setKey("");
        setStatus(message);
      } else setStatus("Could not save Jev settings. Try again.");
    } finally {
      setSaving(false);
    }
  };
  return { disabled, key, setKey, saving, status, save };
}

function EnvironmentJevSettings({
  environment,
  settings,
}: {
  readonly environment: EnvironmentPresentation;
  readonly settings: ServerSettings["jev"];
}) {
  const { disabled, key, setKey, saving, status, save } = useJevSettingsEditor(environment);
  const configured = settings.apiKey.length > 0;
  const keyHint = configured
    ? {
        description: "A key is saved on this server. Enter a new key to replace it.",
        placeholder: "Replace saved key",
      }
    : {
        description: "Save your TypeSafe API key on this server to enable Jev.",
        placeholder: "Enter API key",
      };
  return (
    <SettingsSection title={`Jev · ${environment.label}`}>
      <SettingsSwitchRow
        icon="sparkles"
        label="Jev mode"
        value={settings.enabled}
        disabled={disabled || (!configured && !settings.enabled)}
        subtitle="Let coding agents ask Jev for choices, scores, and yes/no judgments."
        onValueChange={(enabled) =>
          void save(
            { enabled },
            enabled
              ? "Jev mode enabled. Start a new agent session to use it."
              : "Jev mode disabled.",
          )
        }
      />
      <View className="gap-3 border-t border-border p-4">
        <Text className="text-sm text-foreground-muted">
          Evaluations send context to TypeSafe and use your API quota. Start a new agent session
          after enabling. Turning it off blocks further evaluations.
        </Text>
        <Text className="text-sm text-foreground-muted">{keyHint.description}</Text>
        <TextInput
          accessibilityLabel={`TypeSafe API key for ${environment.label}`}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          value={key}
          onChangeText={setKey}
          maxLength={4096}
          placeholder={keyHint.placeholder}
          className="rounded-xl border border-border bg-subtle px-3 py-3 text-foreground"
        />
        <JevKeyActions
          disabled={disabled}
          canSave={key.trim().length > 0}
          configured={configured}
          saving={saving}
          onSave={() => void save({ apiKey: key.trim() }, "API key saved.")}
          onRemove={() =>
            void save({ apiKey: "", enabled: false }, "API key removed and Jev mode disabled.")
          }
        />
        <Text accessibilityLiveRegion="polite" className="min-h-5 text-sm text-foreground-muted">
          {status}
        </Text>
      </View>
    </SettingsSection>
  );
}

/** Key actions share the same disabled and pending treatment. */
function JevKeyActions({
  disabled,
  canSave,
  configured,
  saving,
  onSave,
  onRemove,
}: {
  readonly disabled: boolean;
  readonly canSave: boolean;
  readonly configured: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly onRemove: () => void;
}) {
  const saveDisabled = disabled || !canSave;
  return (
    <View className="flex-row gap-3">
      <Pressable
        accessibilityRole="button"
        disabled={saveDisabled}
        accessibilityState={{ disabled: saveDisabled }}
        className="rounded-xl bg-subtle px-4 py-3 disabled:opacity-50"
        onPress={onSave}
      >
        <Text className="font-t3-medium text-foreground">{saving ? "Saving…" : "Save key"}</Text>
      </Pressable>
      {configured ? (
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          accessibilityState={{ disabled }}
          className="rounded-xl bg-subtle px-4 py-3 disabled:opacity-50"
          onPress={onRemove}
        >
          <Text className="font-t3-medium text-foreground">Remove key</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
