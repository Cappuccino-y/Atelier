import { useEffect, useState } from "react";

type Toast = { id: number; type: "info" | "warning" | "error"; title: string; detail?: any };
let nextId = 1;
const listeners = new Set<(toasts: Toast[]) => void>();
let toasts: Toast[] = [];

function emit() {
  for (const l of listeners) l([...toasts]);
}

function push(type: Toast["type"], title: string, detail?: any) {
  const id = nextId++;
  toasts = [...toasts, { id, type, title, detail }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id);
    emit();
  }, 4000);
}

export const toast = {
  info: (title: string, detail?: any) => push("info", title, detail),
  warning: (title: string, detail?: any) => push("warning", title, detail),
  error: (title: string, detail?: any) => push("error", title, detail),
};

export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    listeners.add(setList);
    return () => { listeners.delete(setList); };
  }, []);
  
  return (
    <div className="fixed bottom-4 left-4 z-50 space-y-2">
      {list.map(t => (
        <div
          key={t.id}
          className={
            "border rounded-md p-3 shadow-md bg-popover text-sm min-w-64 " +
            (t.type === "error" ? "border-red-300 bg-red-50" :
             t.type === "warning" ? "border-amber-300 bg-amber-50" : "")
          }
        >
          <div className="font-medium">{t.title}</div>
        </div>
      ))}
    </div>
  );
}