import { useCallback, useEffect, useState } from "react";
import { api, type DocumentRecord } from "../services/api";

/** Server document list. Polls quickly while anything is indexing so status changes show up. */
export function useDocuments() {
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setDocs(await api.documents());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const busy = docs?.some((d) => d.status === "processing" || d.status === "uploaded");
  useEffect(() => {
    const t = setInterval(refresh, busy ? 1500 : 15000);
    return () => clearInterval(t);
  }, [busy, refresh]);
  return { docs, error, refresh, setDocs };
}

export type Documents = ReturnType<typeof useDocuments>;
