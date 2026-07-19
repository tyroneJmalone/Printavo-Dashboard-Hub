import { useState } from "react";
import { ArrowUp, ArrowDown, X, Save, FolderOpen, Trash2, Plus } from "lucide-react";

const ALL_FIELDS: { id: string; label: string }[] = [
  { id: "first_name", label: "First Name" },
  { id: "last_name", label: "Last Name" },
  { id: "style", label: "Style" },
  { id: "size", label: "Size" },
  { id: "color", label: "Color" },
  { id: "custom_field", label: "Custom Field" },
  { id: "delivery_method", label: "Delivery Method" },
  { id: "location", label: "Location" },
  { id: "sort_number", label: "Sort #" },
  { id: "order_number", label: "Order Number" },
  { id: "order_date", label: "Order Date" },
];

const FIELD_LABEL: Record<string, string> = Object.fromEntries(
  ALL_FIELDS.map((f) => [f.id, f.label]),
);

const STORAGE_KEY = "mintSortPresets";

interface SavedSortPreset {
  id: string;
  name: string;
  fields: string[];
}

function loadPresets(): SavedSortPreset[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function persistPresets(presets: SavedSortPreset[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

interface CustomSortBuilderProps {
  value: string[];
  onChange: (fields: string[]) => void;
}

const iconBtnCls =
  "h-6 w-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-100 hover:bg-slate-700 disabled:opacity-30 disabled:pointer-events-none shrink-0";

export function CustomSortBuilder({ value, onChange }: CustomSortBuilderProps) {
  const [savedPresets, setSavedPresets] = useState<SavedSortPreset[]>(loadPresets);
  const [presetName, setPresetName] = useState("");
  const [fieldToAdd, setFieldToAdd] = useState("");

  const availableFields = ALL_FIELDS.filter((f) => !value.includes(f.id));

  const addField = () => {
    if (fieldToAdd && !value.includes(fieldToAdd)) {
      onChange([...value, fieldToAdd]);
      setFieldToAdd("");
    }
  };

  const removeField = (idx: number) => onChange(value.filter((_, i) => i !== idx));

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    const next = [...value];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onChange(next);
  };

  const moveDown = (idx: number) => {
    if (idx === value.length - 1) return;
    const next = [...value];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onChange(next);
  };

  const savePreset = () => {
    if (!presetName.trim() || value.length === 0) return;
    const preset: SavedSortPreset = {
      id: crypto.randomUUID(),
      name: presetName.trim(),
      fields: [...value],
    };
    const updated = [...savedPresets, preset];
    setSavedPresets(updated);
    persistPresets(updated);
    setPresetName("");
  };

  const loadPreset = (preset: SavedSortPreset) => onChange([...preset.fields]);

  const deletePreset = (id: string) => {
    const updated = savedPresets.filter((p) => p.id !== id);
    setSavedPresets(updated);
    persistPresets(updated);
  };

  return (
    <div className="space-y-4 rounded-lg border border-slate-700 bg-slate-800/40 p-4">
      <div>
        <div className="text-xs font-semibold text-slate-300">Sort Order</div>
        <p className="text-[11px] text-slate-500 mt-0.5 mb-2">
          Fields apply left-to-right: primary → secondary → …
        </p>

        {value.length === 0 ? (
          <p className="text-sm text-slate-500 italic py-2 px-1">
            No fields added yet — add at least one below.
          </p>
        ) : (
          <div className="space-y-1 mb-3">
            {value.map((fieldId, idx) => (
              <div
                key={fieldId}
                className="flex items-center gap-2 px-3 py-2 bg-slate-900 rounded-md border border-slate-700"
              >
                <span className="text-xs text-slate-500 w-5 text-right shrink-0">
                  {idx + 1}.
                </span>
                <span className="flex-1 text-sm font-medium text-slate-200">
                  {FIELD_LABEL[fieldId] ?? fieldId}
                </span>
                <button
                  className={iconBtnCls}
                  onClick={() => moveUp(idx)}
                  disabled={idx === 0}
                  title="Move up"
                >
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button
                  className={iconBtnCls}
                  onClick={() => moveDown(idx)}
                  disabled={idx === value.length - 1}
                  title="Move down"
                >
                  <ArrowDown className="h-3 w-3" />
                </button>
                <button
                  className="h-6 w-6 flex items-center justify-center rounded text-red-400/80 hover:text-red-400 hover:bg-slate-700 shrink-0"
                  onClick={() => removeField(idx)}
                  title="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {availableFields.length > 0 && (
          <div className="flex gap-2">
            <select
              value={fieldToAdd}
              onChange={(e) => setFieldToAdd(e.target.value)}
              className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669]"
            >
              <option value="">Add a sort field…</option>
              {availableFields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <button
              onClick={addField}
              disabled={!fieldToAdd}
              className="flex items-center gap-1 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-700 text-slate-300 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-slate-700" />

      <div className="space-y-3">
        <div className="text-xs font-semibold text-slate-300">Saved Presets</div>

        {savedPresets.length > 0 && (
          <div className="space-y-1">
            {savedPresets.map((preset) => (
              <div
                key={preset.id}
                className="flex items-center gap-2 px-3 py-2 rounded-md border border-slate-700 bg-slate-900"
              >
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium block text-slate-200">
                    {preset.name}
                  </span>
                  <span className="text-xs text-slate-500 truncate block">
                    {preset.fields.map((f) => FIELD_LABEL[f] ?? f).join(" → ")}
                  </span>
                </div>
                <button
                  className="flex items-center gap-1 h-7 px-2 shrink-0 text-xs text-slate-300 hover:text-slate-100 hover:bg-slate-700 rounded"
                  onClick={() => loadPreset(preset)}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Load
                </button>
                <button
                  className="flex items-center justify-center h-7 px-2 shrink-0 text-red-400/80 hover:text-red-400 hover:bg-slate-700 rounded"
                  onClick={() => deletePreset(preset.id)}
                  title="Delete preset"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            placeholder="Name this preset…"
            className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669]"
            onKeyDown={(e) => e.key === "Enter" && savePreset()}
          />
          <button
            onClick={savePreset}
            disabled={!presetName.trim() || value.length === 0}
            className="flex items-center gap-1 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-700 text-slate-300 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none shrink-0"
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
