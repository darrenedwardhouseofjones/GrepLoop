"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Cpu, Loader2, Search, Siren, XCircle } from "lucide-react";

interface LogEntry {
  id: string;
  message: string;
  level: string;
  createdAt: string;
}

interface Props {
  prId: string | undefined;
  isScanning: boolean;
}

const LEVEL_ICONS: Record<string, React.ReactNode> = {
  info: <Bot size={11} className="text-cyan-400" />,
  tool_call: <Search size={11} className="text-indigo-400" />,
  warn: <Siren size={11} className="text-amber-400" />,
  error: <XCircle size={11} className="text-rose-400" />,
};

const LEVEL_COLORS: Record<string, string> = {
  info: "text-cyan-300",
  tool_call: "text-indigo-300",
  warn: "text-amber-300",
  error: "text-rose-300",
};

export default function ReviewProgress({ prId, isScanning }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!prId || !isScanning) {
      setLogs([]);
      return;
    }

    setLogs([]);

    const poll = async () => {
      try {
        const res = await fetch(`/api/reviews/log?prId=${prId}`);
        if (res.ok) {
          setLogs(await res.json());
        }
      } catch {
        // ignore polling errors
      }
      pollRef.current = setTimeout(poll, 2000);
    };

    poll();

    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [prId, isScanning]);

  useEffect(() => {
    if (expanded) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, expanded]);

  if (!isScanning || !prId) return null;

  return (
    <div className="mt-3 border border-white/10 rounded-lg overflow-hidden bg-slate-950/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 bg-slate-900/60 flex items-center justify-between gap-2 text-xs font-mono cursor-pointer hover:bg-slate-900/80 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Loader2 size={12} className="text-cyan-400 animate-spin" />
          <span className="text-cyan-400 font-bold uppercase tracking-wider text-[10px]">Review Progress</span>
          <span className="text-slate-500 text-[10px]">({logs.length} events)</span>
        </div>
        {expanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
      </button>

      {expanded && (
        <div className="max-h-48 overflow-y-auto p-2 space-y-0.5">
          {logs.length === 0 ? (
            <div className="text-[10px] text-slate-600 font-mono text-center py-4 italic">
              Waiting for AI review loop to start...
            </div>
          ) : (
            <>
              {logs.map((log) => (
                <div key={log.id} className="flex gap-1.5 text-[10px] font-mono leading-relaxed px-1 py-0.5 rounded hover:bg-white/[0.02]">
                  <span className="shrink-0 mt-0.5">{LEVEL_ICONS[log.level] || <Cpu size={11} className="text-slate-500" />}</span>
                  <span className={`${LEVEL_COLORS[log.level] || "text-slate-300"} flex-1 min-w-0`}>{log.message}</span>
                </div>
              ))}
              <div ref={bottomRef} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
