"use client";

import { Plus, Trash2 } from "lucide-react";
import ProviderConfig from "./ProviderConfig";
import ModelPicker from "./ModelPicker";
import type { RoleAccent, WorkingPreset } from "./shared";

/**
 * Renders one role's tab (Chat or Embedding).
 *
 * Layout:
 *  - Two pickers: primary provider (required) + fallback provider (optional).
 *    If the fallback is unset or identical to primary, no fallback is configured
 *    — the role runs single-provider. Same as before.
 *  - Editable config for the currently-selected preset (ProviderConfig).
 *    The "currently-selected" preset is whichever of {primary, fallback} the
 *    user last touched — tracked via `focusSlot`.
 *  - One ModelPicker scoped to this role only (chatModel or embeddingModel).
 *  - "+ New Provider" creates a blank preset and selects it as primary.
 *  - "Delete" removes the preset from storage (blocked if active in any slot).
 */
export default function RolePanel({
  role,
  accent,
  presets,
  primaryPresetId,
  fallbackPresetId,
  focusSlot,
  canDeleteActive,
  onSelectPrimary,
  onSelectFallback,
  onAddProvider,
  onDeleteActive,
  onUpdatePreset,
  onFetchModels,
}: {
  role: "chat" | "embedding";
  accent: RoleAccent;
  presets: WorkingPreset[];
  primaryPresetId: string;
  fallbackPresetId: string;
  /** Which slot's preset is currently shown in the editor below the pickers. */
  focusSlot: "primary" | "fallback";
  canDeleteActive: boolean;
  onSelectPrimary: (id: string) => void;
  onSelectFallback: (id: string) => void;
  onAddProvider: () => void;
  onDeleteActive: () => void;
  onUpdatePreset: (id: string, patch: Partial<WorkingPreset>) => void;
  onFetchModels: (id: string) => void;
}) {
  if (presets.length === 0) {
    return (
      <div className="bg-slate-950/65 rounded-xl border border-dashed border-white/10 p-8 text-center">
        <p className="text-xs text-slate-400 font-mono mb-4">
          No providers configured yet. Add one to pick a {role} model.
        </p>
        <button
          type="button"
          onClick={onAddProvider}
          className="bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 font-mono text-xs font-bold px-4 py-2 rounded-lg inline-flex items-center gap-2 cursor-pointer"
        >
          <Plus size={13} />
          <span>Add Provider</span>
        </button>
      </div>
    );
  }

  const accentBorder = accent === "cyan" ? "border-cyan-500" : "border-indigo-500";
  const roleLabel = role === "chat" ? "Chat Model (PR Reviewer)" : "Embedding Model (Semantic Search)";

  const focusedId = focusSlot === "primary" ? primaryPresetId : fallbackPresetId;
  const active = presets.find((p) => p.id === focusedId) || presets.find((p) => p.id === primaryPresetId) || presets[0];
  const modelValue = role === "chat" ? active.chatModel : active.embeddingModel;
  const onModelChange = (v: string) =>
    onUpdatePreset(active.id, role === "chat" ? { chatModel: v } : { embeddingModel: v });

  return (
    <div className={`bg-slate-950/65 rounded-xl border ${accentBorder}/30 p-4 space-y-4`}>
      <ProviderSlotPicker
        label="Primary"
        accent={accent}
        value={primaryPresetId}
        presets={presets}
        allowEmpty={false}
        onChange={onSelectPrimary}
        onAddProvider={onAddProvider}
      />
      <ProviderSlotPicker
        label="Fallback (optional)"
        accent={accent}
        value={fallbackPresetId}
        presets={presets}
        allowEmpty={true}
        onChange={onSelectFallback}
      />

      <div className="flex items-center justify-between gap-3 pt-3 border-t border-white/5">
        <div className="text-[10px] font-mono uppercase text-slate-400">
          Editing: <span className={accent === "cyan" ? "text-cyan-400" : "text-indigo-400"}>{active.name || "(unnamed)"}</span>
        </div>
        <button
          type="button"
          onClick={onDeleteActive}
          disabled={!canDeleteActive}
          className="bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-slate-400 hover:text-rose-400 border border-white/10 font-mono text-xs px-2.5 py-2 rounded-lg flex items-center gap-1 cursor-pointer"
          title={
            canDeleteActive
              ? "Delete the focused provider preset"
              : "Preset is in use by a slot — clear the slot first"
          }
        >
          <Trash2 size={12} />
          <span className="hidden sm:inline">Delete</span>
        </button>
      </div>

      <ProviderConfig
        preset={active}
        onUpdate={(patch) => onUpdatePreset(active.id, patch)}
        onFetchModels={() => onFetchModels(active.id)}
      />

      <div className={`pt-3 mt-1 border-t ${accentBorder}/20`}>
        <ModelPicker
          label={roleLabel}
          accent={accent}
          models={active.modelsCache}
          value={modelValue}
          onChange={onModelChange}
          isFetching={active.isFetching}
        />
      </div>
    </div>
  );
}

/**
 * A single primary/fallback picker. Renders a <select> with an optional
 * "None" option (fallback only). When the user picks a preset that has
 * not yet had its models fetched, the parent's onFetchModels handler
 * will fire on first focus — kept in the parent to avoid duplicate fetches.
 */
function ProviderSlotPicker({
  label,
  accent,
  value,
  presets,
  allowEmpty,
  onChange,
  onAddProvider,
}: {
  label: string;
  accent: RoleAccent;
  value: string;
  presets: WorkingPreset[];
  allowEmpty: boolean;
  onChange: (id: string) => void;
  onAddProvider?: () => void;
}) {
  const labelText = accent === "cyan" ? "text-cyan-400" : "text-indigo-400";
  return (
    <div>
      <label className={`text-[10px] uppercase font-mono ${labelText} block mb-1`}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none cursor-pointer"
        >
          {allowEmpty && <option value="">(no fallback)</option>}
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || "(unnamed)"} — {p.endpoint.replace(/^https?:\/\//, "").split("/")[0]}
            </option>
          ))}
        </select>
        {onAddProvider && (
          <button
            type="button"
            onClick={onAddProvider}
            className="bg-slate-900 hover:bg-slate-800 text-slate-300 border border-white/10 font-mono text-xs px-2.5 py-2 rounded-lg flex items-center gap-1 cursor-pointer"
            title="Add a new provider preset"
          >
            <Plus size={12} className="text-cyan-400" />
            <span className="hidden sm:inline">New</span>
          </button>
        )}
      </div>
    </div>
  );
}
