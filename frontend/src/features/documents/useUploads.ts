import { useEffect, useRef, useState } from "react";
import { api, type AppSettings } from "../../services/api";
import type { Documents } from "../../hooks/useDocuments";
import { useToast } from "../../components/ui";

export interface Upload {
  key: string;
  name: string;
  progress: number;
}

/** Validates, uploads (multipart) and then watches indexing until the server says indexed or failed. */
export function useUploads(documents: Documents, settings: AppSettings | null) {
  const toast = useToast();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const watching = useRef<Set<string>>(new Set());
  const allowed = settings?.limits.allowed_extensions ?? [".pdf", ".txt", ".md", ".markdown"];
  const maxMb = settings?.limits.max_upload_mb ?? 10;

  useEffect(() => {
    for (const d of documents.docs ?? []) {
      if (!watching.current.has(d.id) || d.status === "processing" || d.status === "uploaded") continue;
      watching.current.delete(d.id);
      if (d.status === "indexed") toast("success", `${d.filename} is ready. Ask anything about it.`);
      else toast("error", `${d.filename} could not be indexed. ${d.error ?? ""}`);
    }
  }, [documents.docs, toast]);

  const validate = (f: File): string | null => {
    const ext = f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".")).toLowerCase() : "";
    if (!allowed.includes(ext)) return `${f.name} is not a PDF, TXT or Markdown file.`;
    if (f.size === 0) return `${f.name} is empty.`;
    if (f.size > maxMb * 1024 * 1024) return `${f.name} is larger than the ${maxMb} MB limit.`;
    return null;
  };

  /** Returns the ids of documents that were accepted (new or already present). */
  const uploadFiles = async (files: File[]): Promise<string[]> => {
    const ids: string[] = [];
    for (const file of files) {
      const problem = validate(file);
      if (problem) {
        toast("error", problem);
        continue;
      }
      const key = crypto.randomUUID();
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      try {
        const res = await api.upload(file, (progress) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress } : x))));
        ids.push(res.document.id);
        if (res.duplicate) toast("info", `${file.name} is already uploaded as ${res.document.filename}.`);
        else watching.current.add(res.document.id);
        await documents.refresh();
      } catch (e) {
        toast("error", `${file.name}: ${(e as Error).message}`);
      } finally {
        setUploads((u) => u.filter((x) => x.key !== key));
      }
    }
    return ids;
  };

  const watch = (id: string) => watching.current.add(id);
  return { uploads, uploadFiles, watch, allowed, maxMb };
}

export type Uploads = ReturnType<typeof useUploads>;
