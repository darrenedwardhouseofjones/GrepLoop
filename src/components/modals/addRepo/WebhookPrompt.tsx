"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { CheckCircle, X, Loader2 } from "lucide-react";

interface Props {
  repoName: string;
  repoId: string;
  hasPat: boolean;
  onClose: () => void;
}

export default function WebhookPrompt({ repoName, repoId, hasPat, onClose }: Props) {
  const [settingUp, setSettingUp] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [manualInstructions, setManualInstructions] = useState<string | null>(null);

  const handleAutoSetup = async () => {
    setSettingUp(true);
    setResult(null);
    try {
      const res = await fetch(`/api/repos/${repoId}/webhook`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setResult({ success: true, message: `Webhook created (ID: ${data.webhookId})` });
      } else {
        setResult({ success: false, message: data.error || "Auto-setup failed" });
      }
    } catch (err: any) {
      setResult({ success: false, message: err.message });
    } finally {
      setSettingUp(false);
    }
  };

  const handleManual = async () => {
    try {
      const res = await fetch(`/api/repos/${repoId}/webhook/setup-instructions`);
      if (res.ok) {
        const data = await res.json();
        setManualInstructions(data.instructions || "See setup instructions below.");
      } else {
        setManualInstructions("Could not load instructions.");
      }
    } catch (err: any) {
      setManualInstructions("Error: " + err.message);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-[#0F1219] border border-white/15 w-full max-w-lg rounded-xl overflow-hidden shadow-2xl"
      >
        <div className="px-5 py-4 bg-slate-950/70 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle size={16} className="text-emerald-400" />
            <span className="text-sm font-bold text-white tracking-tight uppercase font-mono">Repo Registered</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-all"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4 text-xs font-mono">
          <p className="text-slate-300">
            <strong className="text-white">{repoName}</strong> has been registered
            {hasPat ? " and is being cloned." : ". It will be cloned once a deploy key or PAT is configured."}
          </p>

          <p className="text-slate-400">
            Set up a webhook so GrepLoop is notified on every push:
          </p>

          {result && (
            <div className={`p-2 rounded text-xs ${result.success ? "bg-emerald-950/30 border border-emerald-800/20 text-emerald-400" : "bg-rose-950/30 border border-rose-800/20 text-rose-400"}`}>
              {result.message}
            </div>
          )}

          {manualInstructions && (
            <pre className="p-3 bg-slate-950 border border-white/10 rounded text-[10px] text-slate-400 whitespace-pre-wrap max-h-60 overflow-y-auto">
              {manualInstructions}
            </pre>
          )}

          <div className="flex gap-2.5 mt-2">
            {hasPat && !result && !manualInstructions && (
              <button
                onClick={handleAutoSetup}
                disabled={settingUp}
                className="flex-1 bg-cyan-500 hover:bg-cyan-400 hover:shadow-[0_0_12px_rgba(6,182,212,0.3)] text-black py-2.5 rounded font-bold transition-all cursor-pointer text-center disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {settingUp && <Loader2 size={14} className="animate-spin" />}
                {settingUp ? "Setting up..." : "Auto-Setup Webhook"}
              </button>
            )}
            {!result && !manualInstructions && (
              <button
                onClick={handleManual}
                className="flex-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 py-2.5 rounded font-bold transition-all cursor-pointer text-center"
              >
                Show Manual Instructions
              </button>
            )}
          </div>

          {(result || manualInstructions) && (
            <button
              onClick={onClose}
              className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 py-2.5 rounded font-bold transition-all cursor-pointer text-center"
            >
              Done
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
