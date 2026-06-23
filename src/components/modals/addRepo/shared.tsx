import type React from "react";

export const inputClass =
  "w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 outline-hidden focus:border-cyan-500 transition-all placeholder-slate-700";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-slate-500 font-bold mb-1 uppercase text-[9px]">{label}</label>
      {children}
    </div>
  );
}
